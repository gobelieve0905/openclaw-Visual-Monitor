#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { exec } = require("child_process");
const url = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 19101);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS || 300000);

const OPENCLAW_HOME = "/home/ubuntu/.openclaw";
const OPENCLAW_BIN = "/home/ubuntu/.openclaw/tools/node-v22.22.0/bin/openclaw";
const OPENCLAW_PATH = "/home/ubuntu/.openclaw/tools/node-v22.22.0/bin:/home/ubuntu/.openclaw/lib/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONFIG_FILE = path.join(OPENCLAW_HOME, "openclaw.json");
const ENV_FILE = path.join(OPENCLAW_HOME, "env", "openclaw.env");
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const clients = new Set();
const state = {
  updatedAt: null,
  services: {},
  network: {},
  agents: {
    main: { status: "unknown", lastProbeAt: null, lastOkAt: null, latencyMs: null, detail: "" },
    work: { status: "unknown", lastProbeAt: null, lastOkAt: null, latencyMs: null, detail: "" }
  },
  metrics: {
    logWindowMinutes: 5,
    networkErrors5m: 0,
    timeoutErrors5m: 0,
    failover5m: 0,
    llmFailed5m: 0,
    sendOk5m: 0,
    llmRequest5m: 0
  },
  system: {
    load1: 0,
    load5: 0,
    load15: 0,
    memUsedPct: 0,
    diskUsedPct: 0,
    uptime: "-"
  },
  config: {
    hasDailyKey: false,
    hasWorkKey: false,
    hasDailyToken: false,
    hasWorkToken: false,
    telegramProxy: ""
  },
  overall: { level: "unknown", reason: "initializing" }
};

const history = [];

function run(cmd, timeoutMs = 12000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
        error: error ? String(error.message || error) : null
      });
    });
  });
}

function parseEnvFile(text) {
  const out = {};
  for (const lineRaw of text.split("\n")) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function safeIso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

function addHistory(snapshot) {
  history.push(snapshot);
  while (history.length > 1440) history.shift();
}

async function persistHistory() {
  try {
    await fsp.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    await fsp.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error("[persistHistory] failed:", err.message);
  }
}

async function loadHistory() {
  try {
    const txt = await fsp.readFile(HISTORY_FILE, "utf8");
    const arr = JSON.parse(txt);
    if (Array.isArray(arr)) arr.slice(-1440).forEach((x) => history.push(x));
  } catch (_) {}
}

function levelFromState(nextState) {
  const bad = [];
  if (nextState.services.gateway !== "active") bad.push("gateway");
  if (nextState.services.singbox !== "active") bad.push("sing-box");
  if (!nextState.network.proxyPortOpen) bad.push("proxy-port");
  if (nextState.network.openaiHttpCode !== 200) bad.push("openai-relay");
  if (nextState.network.telegramDaily !== 200) bad.push("telegram-daily");
  if (nextState.network.telegramWork !== 200) bad.push("telegram-work");

  const mainBad = nextState.agents.main.status === "error";
  const workBad = nextState.agents.work.status === "error";
  const mainUnknown = nextState.agents.main.status === "unknown";
  const workUnknown = nextState.agents.work.status === "unknown";

  if (bad.length === 0 && !mainBad && !workBad && !mainUnknown && !workUnknown && nextState.metrics.timeoutErrors5m === 0 && nextState.metrics.networkErrors5m === 0) {
    return { level: "green", reason: "all checks passed" };
  }

  if (bad.includes("gateway") || bad.includes("sing-box") || bad.includes("proxy-port") || (mainBad && workBad)) {
    return { level: "red", reason: `critical: ${bad.join(", ") || "agents unhealthy"}` };
  }

  if (mainUnknown || workUnknown) {
    return { level: "yellow", reason: "warming up: waiting first agent probes" };
  }

  return { level: "yellow", reason: `degraded: ${bad.join(", ") || "partial agent degradation"}` };
}

async function getLogMetrics() {
  const now = Date.now();
  const dateTag = new Date(now).toISOString().slice(0, 10);
  const logFile = `/tmp/openclaw/openclaw-${dateTag}.log`;
  const metrics = {
    networkErrors5m: 0,
    timeoutErrors5m: 0,
    failover5m: 0,
    llmFailed5m: 0,
    sendOk5m: 0,
    llmRequest5m: 0
  };

  try {
    const txt = await fsp.readFile(logFile, "utf8");
    const lines = txt.split("\n").slice(-4000);
    const cutoff = now - 5 * 60 * 1000;

    for (const line of lines) {
      if (!line) continue;
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+\-]\d{2}:\d{2})/);
      if (!tsMatch) continue;
      const t = Date.parse(tsMatch[1]);
      if (!Number.isFinite(t) || t < cutoff) continue;
      const lower = line.toLowerCase();
      if (lower.includes("network connection error")) metrics.networkErrors5m += 1;
      if (lower.includes("timeout")) metrics.timeoutErrors5m += 1;
      if (lower.includes("failover decision")) metrics.failover5m += 1;
      if (lower.includes("llm request failed")) metrics.llmFailed5m += 1;
      if (lower.includes("llm request") || lower.includes("responses")) metrics.llmRequest5m += 1;
      if (lower.includes("sendmessage ok")) metrics.sendOk5m += 1;
    }
  } catch (_) {}

  return metrics;
}

async function checkServices() {
  const gateway = await run("systemctl --user is-active openclaw-gateway.service");
  const singbox = await run("systemctl is-active sing-box.service");
  return {
    gateway: gateway.stdout || "unknown",
    singbox: singbox.stdout || "unknown"
  };
}

async function checkProxyPort() {
  const r = await run("ss -lnt | grep -q '127.0.0.1:7890' && echo open || echo closed");
  return r.stdout === "open";
}

async function loadConfigAndEnv() {
  const out = { env: {}, cfg: {} };
  try {
    out.env = parseEnvFile(await fsp.readFile(ENV_FILE, "utf8"));
  } catch (_) {}
  try {
    out.cfg = JSON.parse(await fsp.readFile(CONFIG_FILE, "utf8"));
  } catch (_) {}
  return out;
}

async function probeOpenAI(env) {
  const base = env.OPENAI_BASE_URL || "https://aixj.vip/v1";
  const key = env.OPENAI_API_KEY_DAILY || env.OPENAI_API_KEY || "";
  if (!key) return 0;
  const cmd = `curl -sS -o /dev/null -w "%{http_code}" --max-time 12 -H "Authorization: Bearer ${key}" "${base}/models"`;
  const r = await run(cmd, 15000);
  return Number(r.stdout || 0);
}

async function probeTelegram(env, cfg) {
  const tokens = {
    daily: env.TELEGRAM_TOKEN_DAILY || (((cfg || {}).channels || {}).telegram || {}).accounts?.tg_daily?.botToken || "",
    work: env.TELEGRAM_TOKEN_WORK || (((cfg || {}).channels || {}).telegram || {}).accounts?.tg_work?.botToken || ""
  };
  const proxy = (((cfg || {}).channels || {}).telegram || {}).proxy || "";

  async function one(token) {
    if (!token) return 0;
    const proxyPart = proxy ? `-x ${proxy} ` : "";
    const cmd = `curl -sS ${proxyPart}--max-time 12 -o /dev/null -w "%{http_code}" "https://api.telegram.org/bot${token}/getMe"`;
    const r = await run(cmd, 15000);
    return Number(r.stdout || 0);
  }

  return {
    daily: await one(tokens.daily),
    work: await one(tokens.work)
  };
}

async function probeSystem() {
  const [load, mem, disk, up] = await Promise.all([
    run("cat /proc/loadavg | awk '{print $1\" \"$2\" \"$3}'"),
    run("free -m | awk '/Mem:/ {print $3\" \"$2}'"),
    run("df -P / | awk 'NR==2 {print $5}' | tr -d '%'"),
    run("uptime -p")
  ]);

  const [l1, l5, l15] = (load.stdout || "0 0 0").split(/\s+/).map(Number);
  const [used, total] = (mem.stdout || "0 0").split(/\s+/).map(Number);
  const memUsedPct = total > 0 ? Math.round((used / total) * 100) : 0;
  const diskUsedPct = Number(disk.stdout || 0);

  return {
    load1: Number.isFinite(l1) ? l1 : 0,
    load5: Number.isFinite(l5) ? l5 : 0,
    load15: Number.isFinite(l15) ? l15 : 0,
    memUsedPct,
    diskUsedPct: Number.isFinite(diskUsedPct) ? diskUsedPct : 0,
    uptime: up.stdout || "-"
  };
}

let probeCursor = "main";
async function probeAgent(agentId) {
  const cmd = `bash -lc "export PATH=${OPENCLAW_PATH}; timeout 20 ${OPENCLAW_BIN} models --agent ${agentId} status --json"`;
  const start = Date.now();
  const r = await run(cmd, 25000);
  const latency = Date.now() - start;
  const text = `${r.stdout}\n${r.stderr}`.trim();

  let ok = false;
  let detail = "";
  try {
    const parsed = JSON.parse(r.stdout || "{}");
    const missing = (((parsed || {}).auth || {}).missingProvidersInUse) || [];
    ok = r.ok && Array.isArray(missing) && missing.length === 0;
    detail = ok
      ? `model=${parsed.resolvedDefault || "-"} auth=ok`
      : `missingProviders=${Array.isArray(missing) ? missing.join(",") : "unknown"}`;
  } catch (_) {
    ok = false;
    detail = text.split("\n").slice(-2).join(" | ") || "probe parse failed";
  }

  state.agents[agentId].lastProbeAt = safeIso();
  state.agents[agentId].latencyMs = latency;
  state.agents[agentId].status = ok ? "ok" : "error";
  state.agents[agentId].detail = detail;
  if (ok) state.agents[agentId].lastOkAt = safeIso();
}

function buildConfigSummary(env, cfg) {
  const c = (((cfg || {}).channels || {}).telegram || {});
  return {
    hasDailyKey: Boolean(env.OPENAI_API_KEY_DAILY || env.OPENAI_API_KEY),
    hasWorkKey: Boolean(env.OPENAI_API_KEY_WORK || env.OPENAI_API_KEY),
    hasDailyToken: Boolean(env.TELEGRAM_TOKEN_DAILY || c.accounts?.tg_daily?.botToken),
    hasWorkToken: Boolean(env.TELEGRAM_TOKEN_WORK || c.accounts?.tg_work?.botToken),
    telegramProxy: c.proxy || ""
  };
}

function buildStatsAll() {
  const mainOk = state.agents.main.status === "ok";
  const workOk = state.agents.work.status === "ok";
  const servicesOk = state.services.gateway === "active" && state.services.singbox === "active";
  const channelsOk = state.network.telegramDaily === 200 && state.network.telegramWork === 200;

  return {
    updatedAt: state.updatedAt,
    overview: {
      overall: state.overall,
      servicesOk,
      channelsOk,
      proxyOpen: state.network.proxyPortOpen,
      openaiCode: state.network.openaiHttpCode
    },
    agents: {
      main: state.agents.main,
      work: state.agents.work,
      okCount: [mainOk, workOk].filter(Boolean).length,
      total: 2
    },
    channels: {
      dailyCode: state.network.telegramDaily,
      workCode: state.network.telegramWork,
      proxy: state.config.telegramProxy || "-"
    },
    services: {
      gateway: state.services.gateway,
      singbox: state.services.singbox,
      proxyPortOpen: state.network.proxyPortOpen
    },
    errors: {
      networkErrors5m: state.metrics.networkErrors5m,
      timeoutErrors5m: state.metrics.timeoutErrors5m,
      failover5m: state.metrics.failover5m,
      llmFailed5m: state.metrics.llmFailed5m
    },
    activity: {
      llmRequest5m: state.metrics.llmRequest5m,
      sendOk5m: state.metrics.sendOk5m,
      lastUpdate: state.updatedAt
    },
    system: state.system,
    config: state.config
  };
}

async function updateSnapshot() {
  const [{ env, cfg }, services, proxyPortOpen, metrics, system] = await Promise.all([
    loadConfigAndEnv(),
    checkServices(),
    checkProxyPort(),
    getLogMetrics(),
    probeSystem()
  ]);

  const [openaiHttpCode, telegram] = await Promise.all([
    probeOpenAI(env),
    probeTelegram(env, cfg)
  ]);

  const config = buildConfigSummary(env, cfg);

  const next = {
    updatedAt: safeIso(),
    services,
    network: {
      proxyPortOpen,
      openaiHttpCode,
      telegramDaily: telegram.daily,
      telegramWork: telegram.work
    },
    agents: state.agents,
    metrics: {
      logWindowMinutes: 5,
      networkErrors5m: metrics.networkErrors5m,
      timeoutErrors5m: metrics.timeoutErrors5m,
      failover5m: metrics.failover5m,
      llmFailed5m: metrics.llmFailed5m,
      sendOk5m: metrics.sendOk5m,
      llmRequest5m: metrics.llmRequest5m
    },
    system,
    config
  };

  next.overall = levelFromState(next);

  state.updatedAt = next.updatedAt;
  state.services = next.services;
  state.network = next.network;
  state.metrics = next.metrics;
  state.system = next.system;
  state.config = next.config;
  state.overall = next.overall;

  addHistory({
    ts: next.updatedAt,
    overall: next.overall.level,
    network: next.network,
    services: next.services,
    metrics: next.metrics,
    system: next.system,
    agents: next.agents
  });
  await persistHistory();

  broadcast({ type: "snapshot", data: next, stats: buildStatsAll() });
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch (_) {}
  }
}

async function getRecentEvents(limit = 60) {
  const max = Math.max(1, Math.min(200, Number(limit || 60)));
  const out = [];
  const dateTag = new Date().toISOString().slice(0, 10);
  const logFile = "/tmp/openclaw/openclaw-" + dateTag + ".log";

  function shortMsg(raw) {
    if (!raw) return "";
    const txt = String(raw).replace(/\s+/g, " ").trim();
    return txt.length > 180 ? txt.slice(0, 180) + "..." : txt;
  }

  try {
    const txt = await fsp.readFile(logFile, "utf8");
    const lines = txt.split("\n").slice(-2000);
    for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
      const line = lines[i];
      if (!line) continue;

      let ts = "";
      let level = "info";
      let message = "";

      const low = line.toLowerCase();
      if (!(low.includes("error") || low.includes("warn") || low.includes("timeout") || low.includes("failover") || low.includes("sendmessage") || low.includes("llm request"))) continue;

      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+\-]\d{2}:\d{2})/);
      ts = tsMatch ? tsMatch[1] : "";
      if (low.includes("error")) level = "error";
      else if (low.includes("warn") || low.includes("timeout") || low.includes("failover")) level = "warn";
      message = shortMsg(line);
      out.push({ ts, level, message });
    }
  } catch (_) {}

  return out;
}

function sendJson(res, status, body) {
  const txt = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(txt),
    "Cache-Control": "no-store"
  });
  res.end(txt);
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(req, res) {
  const parsed = url.parse(req.url || "/");
  let pathname = decodeURIComponent(parsed.pathname || "/");
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(PUBLIC_DIR, pathname);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error("not file");
    res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (_) {
    res.writeHead(404);
    res.end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || "/", true);

  if (req.method === "GET" && parsed.pathname === "/api/health") {
    return sendJson(res, 200, {
      updatedAt: state.updatedAt,
      services: state.services,
      network: state.network,
      agents: state.agents,
      metrics: state.metrics,
      system: state.system,
      config: state.config,
      overall: state.overall
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/stats-all") {
    return sendJson(res, 200, buildStatsAll());
  }

  if (req.method === "GET" && parsed.pathname === "/api/system") {
    return sendJson(res, 200, state.system);
  }

  if (req.method === "GET" && parsed.pathname === "/api/activity") {
    return sendJson(res, 200, {
      llmRequest5m: state.metrics.llmRequest5m,
      sendOk5m: state.metrics.sendOk5m,
      llmFailed5m: state.metrics.llmFailed5m,
      updatedAt: state.updatedAt
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/history") {
    const limit = Math.max(1, Math.min(2000, Number(parsed.query.limit || 240)));
    return sendJson(res, 200, { items: history.slice(-limit) });
  }

  if (req.method === "GET" && parsed.pathname === "/api/events") {
    const limit = Math.max(1, Math.min(200, Number(parsed.query.limit || 60)));
    const items = await getRecentEvents(limit);
    return sendJson(res, 200, { items });
  }

  if (req.method === "GET" && parsed.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  return serveStatic(req, res);
});

async function start() {
  await loadHistory();
  await updateSnapshot();

  setInterval(() => {
    updateSnapshot().catch((err) => console.error("[poll]", err.message));
  }, POLL_INTERVAL_MS);

  setInterval(() => {
    const agentId = probeCursor;
    probeCursor = probeCursor === "main" ? "work" : "main";
    probeAgent(agentId)
      .then(() => updateSnapshot())
      .catch((err) => console.error("[probe]", agentId, err.message));
  }, PROBE_INTERVAL_MS);

  probeAgent("main").then(() => updateSnapshot()).catch(() => {});
  probeAgent("work").then(() => updateSnapshot()).catch(() => {});

  server.listen(PORT, HOST, () => {
    console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
    console.log(`[dashboard] poll=${POLL_INTERVAL_MS}ms probe=${PROBE_INTERVAL_MS}ms`);
  });
}

start().catch((err) => {
  console.error("[startup] failed:", err);
  process.exit(1);
});
