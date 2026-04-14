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
const OPENCLAW_MAIN_AGENT = "main";
const OPENCLAW_PATH = "/home/ubuntu/.openclaw/tools/node-v22.22.0/bin:/home/ubuntu/.openclaw/lib/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONFIG_FILE = path.join(OPENCLAW_HOME, "openclaw.json");
const ENV_FILE = path.join(OPENCLAW_HOME, "env", "openclaw.env");
const HERMES_HOME = "/home/ubuntu/.hermes";
const HERMES_CONFIG_FILE = path.join(HERMES_HOME, "config.yaml");
const HERMES_ENV_FILE = path.join(HERMES_HOME, ".env");
const HERMES_BIN = "/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes";
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const REVIEW_CACHE_TTL_MS = Number(process.env.REVIEW_CACHE_TTL_MS || 60000);

const clients = new Set();
const state = {
  updatedAt: null,
  services: {},
  network: {},
  agents: {
    openclaw: { status: "unknown", lastProbeAt: null, lastOkAt: null, latencyMs: null, detail: "" },
    hermes: { status: "unknown", lastProbeAt: null, lastOkAt: null, latencyMs: null, detail: "" }
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
    openclaw: { hasKey: false, hasToken: false, telegramProxy: "", model: "" },
    hermes: { hasKey: false, hasToken: false, model: "", provider: "", baseUrl: "" }
  },
  overall: { level: "unknown", reason: "initializing" }
};

const history = [];
const reviewCache = {
  models: { at: 0, data: null },
  sessions: { at: 0, data: null },
  skills: { at: 0, data: null },
  alerts: { at: 0, data: null },
  modelOptions: { at: 0, data: null }
};

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

function tryParseJson(text, fallback = null) {
  try {
    return JSON.parse(text || "");
  } catch (_) {
    return fallback;
  }
}

async function runOpenclawJson(cmd, timeoutMs = 25000) {
  const full = `bash -lc "export PATH=${OPENCLAW_PATH}; timeout 25 ${OPENCLAW_BIN} ${cmd} --json"`;
  const r = await run(full, timeoutMs);
  if (!r.ok) return null;
  return tryParseJson(r.stdout, null);
}

function cacheValid(entry) {
  return entry && entry.data && (Date.now() - entry.at < REVIEW_CACHE_TTL_MS);
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

function uniqStrings(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items || []) {
    const s = String(raw || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
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
  if (nextState.services.openclawGateway !== "active") bad.push("openclaw-gateway");
  if (nextState.services.hermesGateway !== "active") bad.push("hermes-gateway");
  if (nextState.services.singbox !== "active") bad.push("sing-box");
  if (!nextState.network.proxyPortOpen) bad.push("proxy-port");
  if (nextState.network.openclawOpenaiHttpCode !== 200) bad.push("openclaw-openai");
  if (nextState.network.hermesOpenaiHttpCode !== 200) bad.push("hermes-openai");
  if (nextState.network.openclawTelegram !== 200) bad.push("openclaw-telegram");
  if (nextState.network.hermesTelegram !== 200) bad.push("hermes-telegram");
  if (!nextState.network.openclawPortOpen) bad.push("openclaw-port");
  if (!nextState.network.hermesPortOpen) bad.push("hermes-port");

  const openclawBad = nextState.agents.openclaw.status === "error";
  const hermesBad = nextState.agents.hermes.status === "error";
  const openclawUnknown = nextState.agents.openclaw.status === "unknown";
  const hermesUnknown = nextState.agents.hermes.status === "unknown";

  if (bad.length === 0 && !openclawBad && !hermesBad && !openclawUnknown && !hermesUnknown && nextState.metrics.timeoutErrors5m === 0 && nextState.metrics.networkErrors5m === 0) {
    return { level: "green", reason: "all checks passed" };
  }

  if (bad.includes("openclaw-gateway") || bad.includes("hermes-gateway") || bad.includes("sing-box") || bad.includes("proxy-port") || (openclawBad && hermesBad)) {
    return { level: "red", reason: `critical: ${bad.join(", ") || "agents unhealthy"}` };
  }

  if (openclawUnknown || hermesUnknown) {
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
  const openclawGateway = await run("systemctl --user is-active openclaw-gateway.service");
  const hermesGateway = await run("systemctl --user is-active hermes-gateway.service");
  const singbox = await run("systemctl is-active sing-box.service");
  return {
    openclawGateway: openclawGateway.stdout || "unknown",
    hermesGateway: hermesGateway.stdout || "unknown",
    singbox: singbox.stdout || "unknown"
  };
}

async function checkPort(port) {
  const r = await run(`ss -lnt | grep -q '127.0.0.1:${port}' && echo open || echo closed`);
  return r.stdout === "open";
}

function parseHermesConfig(text) {
  const modelMatch = text.match(/^\s*default:\s*["']?([^"'\n]+)["']?/m);
  const providerMatch = text.match(/^\s*provider:\s*["']?([^"'\n]+)["']?/m);
  const baseUrlMatch = text.match(/^\s*base_url:\s*["']?([^"'\n]+)["']?/m);
  const apiServerPortMatch = text.match(/^\s*port:\s*(\d+)\s*$/m);
  return {
    model: modelMatch ? modelMatch[1].trim() : "",
    provider: providerMatch ? providerMatch[1].trim() : "",
    baseUrl: baseUrlMatch ? baseUrlMatch[1].trim() : "",
    apiServerPort: apiServerPortMatch ? Number(apiServerPortMatch[1]) : 18789
  };
}

async function loadConfigAndEnv() {
  const out = {
    openclaw: { env: {}, cfg: {} },
    hermes: { env: {}, cfgText: "", cfg: { model: "", provider: "", baseUrl: "", apiServerPort: 18789 } }
  };
  try {
    out.openclaw.env = parseEnvFile(await fsp.readFile(ENV_FILE, "utf8"));
  } catch (_) {}
  try {
    out.openclaw.cfg = JSON.parse(await fsp.readFile(CONFIG_FILE, "utf8"));
  } catch (_) {}
  try {
    out.hermes.env = parseEnvFile(await fsp.readFile(HERMES_ENV_FILE, "utf8"));
  } catch (_) {}
  try {
    out.hermes.cfgText = await fsp.readFile(HERMES_CONFIG_FILE, "utf8");
    out.hermes.cfg = parseHermesConfig(out.hermes.cfgText);
  } catch (_) {}
  return out;
}

async function probeOpenAI(base, key) {
  if (!key) return 0;
  const resolvedBase = base || "https://aixj.vip/v1";
  const cmd = `curl -sS -o /dev/null -w "%{http_code}" --max-time 12 -H "Authorization: Bearer ${key}" "${resolvedBase}/models"`;
  const r = await run(cmd, 15000);
  return Number(r.stdout || 0);
}

async function probeTelegram(token, proxy) {
  if (!token) return 0;
  const proxyPart = proxy ? `-x ${proxy} ` : "";
  const cmd = `curl -sS ${proxyPart}--max-time 12 -o /dev/null -w "%{http_code}" "https://api.telegram.org/bot${token}/getMe"`;
  const r = await run(cmd, 15000);
  return Number(r.stdout || 0);
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

let probeCursor = "openclaw";

function maskError(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 220 ? `${t.slice(0, 220)}...` : t;
}

async function probeAgent(agentId) {
  if (agentId === "hermes") {
    const start = Date.now();
    const cmd = `bash -lc "source /home/ubuntu/.hermes/hermes-agent/venv/bin/activate; timeout 20 ${HERMES_BIN} dump"`;
    const r = await run(cmd, 25000);
    const latency = Date.now() - start;
    const text = `${r.stdout}\n${r.stderr}`.trim();
    const provider = (text.match(/provider:\s+([^\n]+)/) || [])[1] || "";
    const model = (text.match(/model:\s+([^\n]+)/) || [])[1] || "";
    const gateway = (text.match(/gateway:\s+([^\n]+)/) || [])[1] || "";
    const ok = r.ok && /running/.test(gateway);
    state.agents.hermes.lastProbeAt = safeIso();
    state.agents.hermes.latencyMs = latency;
    state.agents.hermes.status = ok ? "ok" : "error";
    state.agents.hermes.detail = ok ? `model=${model.trim() || "-"} provider=${provider.trim() || "-"}` : (text.split("\n").slice(-2).join(" | ") || "hermes probe failed");
    if (ok) state.agents.hermes.lastOkAt = safeIso();
    return;
  }

  const cmd = `bash -lc "export PATH=${OPENCLAW_PATH}; timeout 20 ${OPENCLAW_BIN} models --agent ${OPENCLAW_MAIN_AGENT} status --json"`;
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

  state.agents.openclaw.lastProbeAt = safeIso();
  state.agents.openclaw.latencyMs = latency;
  state.agents.openclaw.status = ok ? "ok" : "error";
  state.agents.openclaw.detail = detail;
  if (ok) state.agents.openclaw.lastOkAt = safeIso();
}

async function runNodeTest(nodeId) {
  const start = Date.now();
  const ctx = await loadConfigAndEnv();
  const openclawEnv = ctx.openclaw.env || {};
  const openclawCfg = ctx.openclaw.cfg || {};
  const hermesEnv = ctx.hermes.env || {};
  const hermesCfg = ctx.hermes.cfg || {};
  const proxyUrl = ((((openclawCfg || {}).channels || {}).telegram || {}).proxy) || "";
  const openclawTgToken = openclawEnv.TELEGRAM_TOKEN_WORK || ((((openclawCfg || {}).channels || {}).telegram || {}).accounts?.tg_work?.botToken) || "";
  const hermesTgToken = hermesEnv.TELEGRAM_BOT_TOKEN || "";
  const openclawBase = openclawEnv.OPENAI_BASE_URL || "https://aixj.vip/v1";
  const openclawKey = openclawEnv.OPENAI_API_KEY_DAILY || openclawEnv.OPENAI_API_KEY || "";
  const hermesBase = hermesCfg.baseUrl || hermesEnv.OPENAI_BASE_URL || "https://aixj.vip/v1";
  const hermesKey = hermesEnv.OPENAI_API_KEY || "";

  let ok = false;
  let detail = "";
  const checks = {};

  if (nodeId === "telegram-openclaw") {
    const code = await probeTelegram(openclawTgToken, proxyUrl);
    checks.httpCode = code;
    ok = code === 200;
    detail = `Telegram getMe=${code}`;
  } else if (nodeId === "telegram-hermes") {
    const code = await probeTelegram(hermesTgToken, proxyUrl);
    checks.httpCode = code;
    ok = code === 200;
    detail = `Telegram getMe=${code}`;
  } else if (nodeId === "proxy") {
    const [singbox, portOpen] = await Promise.all([
      run("systemctl is-active sing-box.service"),
      checkPort(7890)
    ]);
    checks.singbox = singbox.stdout || "unknown";
    checks.portOpen = portOpen;
    ok = checks.singbox === "active" && checks.portOpen === true;
    detail = `sing-box=${checks.singbox}, 7890=${checks.portOpen ? "open" : "closed"}`;
  } else if (nodeId === "openclaw") {
    const [svc, portOpen, probe] = await Promise.all([
      run("systemctl --user is-active openclaw-gateway.service"),
      checkPort(19001),
      run(`bash -lc "export PATH=${OPENCLAW_PATH}; timeout 20 ${OPENCLAW_BIN} models --agent ${OPENCLAW_MAIN_AGENT} status --json"`, 25000)
    ]);
    checks.service = svc.stdout || "unknown";
    checks.portOpen = portOpen;
    checks.probeExitOk = probe.ok;
    ok = checks.service === "active" && checks.portOpen === true && checks.probeExitOk === true;
    detail = `service=${checks.service}, 19001=${checks.portOpen ? "open" : "closed"}, probe=${probe.ok ? "ok" : "fail"}`;
  } else if (nodeId === "hermes") {
    const [svc, portOpen, dump] = await Promise.all([
      run("systemctl --user is-active hermes-gateway.service"),
      checkPort(18789),
      run(`bash -lc "source /home/ubuntu/.hermes/hermes-agent/venv/bin/activate; timeout 20 ${HERMES_BIN} dump"`, 25000)
    ]);
    checks.service = svc.stdout || "unknown";
    checks.portOpen = portOpen;
    checks.dumpOk = dump.ok;
    ok = checks.service === "active" && checks.portOpen === true && checks.dumpOk === true;
    detail = `service=${checks.service}, 18789=${checks.portOpen ? "open" : "closed"}, dump=${dump.ok ? "ok" : "fail"}`;
  } else if (nodeId === "llm") {
    const [ocCode, hCode] = await Promise.all([
      probeOpenAI(openclawBase, openclawKey),
      probeOpenAI(hermesBase, hermesKey)
    ]);
    checks.openclawCode = ocCode;
    checks.hermesCode = hCode;
    ok = ocCode === 200 && hCode === 200;
    detail = `openclaw=${ocCode}, hermes=${hCode}`;
  } else {
    return {
      node: nodeId,
      ok: false,
      detail: "unsupported node id",
      checks: {},
      testedAt: safeIso(),
      durationMs: Date.now() - start
    };
  }

  return {
    node: nodeId,
    ok,
    detail: maskError(detail),
    checks,
    testedAt: safeIso(),
    durationMs: Date.now() - start
  };
}

function buildConfigSummary(ctx) {
  const env = ctx.openclaw.env || {};
  const cfg = ctx.openclaw.cfg || {};
  const hermesEnv = ctx.hermes.env || {};
  const hermesCfg = ctx.hermes.cfg || {};
  const c = (((cfg || {}).channels || {}).telegram || {});
  return {
    openclaw: {
      hasKey: Boolean(env.OPENAI_API_KEY_DAILY || env.OPENAI_API_KEY || env.OPENAI_API_KEY_WORK),
      hasToken: Boolean(env.TELEGRAM_TOKEN_WORK || c.accounts?.tg_work?.botToken),
      telegramProxy: c.proxy || "",
      model: "openclaw/main"
    },
    hermes: {
      hasKey: Boolean(hermesEnv.OPENAI_API_KEY),
      hasToken: Boolean(hermesEnv.TELEGRAM_BOT_TOKEN),
      model: hermesCfg.model || "-",
      provider: hermesCfg.provider || "-",
      baseUrl: hermesCfg.baseUrl || "-"
    }
  };
}

function buildAgentSplit() {
  function one(agentId, label, channelCode, openaiCode, hasKey, hasToken) {
    const probe = state.agents[agentId] || {};
    const checks = [
      state.services.openclawGateway === "active" || agentId === "hermes",
      state.services.hermesGateway === "active" || agentId === "openclaw",
      state.services.singbox === "active",
      state.network.proxyPortOpen === true,
      openaiCode === 200,
      channelCode === 200,
      probe.status === "ok",
      Boolean(hasKey),
      Boolean(hasToken)
    ];
    const passCount = checks.filter(Boolean).length;
    const score = Math.round((passCount / checks.length) * 100);

    return {
      agentId,
      status: probe.status || "unknown",
      model: probe.detail || "-",
      latencyMs: probe.latencyMs ?? null,
      lastProbeAt: probe.lastProbeAt || null,
      lastOkAt: probe.lastOkAt || null,
      score,
      chain: {
        openclawGateway: state.services.openclawGateway === "active",
        hermesGateway: state.services.hermesGateway === "active",
        singbox: state.services.singbox === "active",
        proxyOpen: state.network.proxyPortOpen === true,
        openaiRelay: openaiCode === 200,
        telegram: channelCode === 200,
        probe: probe.status === "ok",
        apiKey: Boolean(hasKey),
        telegramToken: Boolean(hasToken)
      },
      channel: {
        name: label,
        httpCode: channelCode,
        state: channelCode === 200 ? "ok" : "error"
      }
    };
  }

  return {
    openclaw: one("openclaw", "OpenClaw Bot", state.network.openclawTelegram, state.network.openclawOpenaiHttpCode, state.config.openclaw.hasKey, state.config.openclaw.hasToken),
    hermes: one("hermes", "Hermes Bot", state.network.hermesTelegram, state.network.hermesOpenaiHttpCode, state.config.hermes.hasKey, state.config.hermes.hasToken)
  };
}

function buildStatsAll() {
  const openclawOk = state.agents.openclaw.status === "ok";
  const hermesOk = state.agents.hermes.status === "ok";
  const servicesOk = state.services.openclawGateway === "active" && state.services.hermesGateway === "active" && state.services.singbox === "active";
  const channelsOk = state.network.openclawTelegram === 200 && state.network.hermesTelegram === 200;

  return {
    updatedAt: state.updatedAt,
    overview: {
      overall: state.overall,
      servicesOk,
      channelsOk,
      proxyOpen: state.network.proxyPortOpen,
      openclawOpenaiCode: state.network.openclawOpenaiHttpCode,
      hermesOpenaiCode: state.network.hermesOpenaiHttpCode
    },
    agents: {
      openclaw: state.agents.openclaw,
      hermes: state.agents.hermes,
      okCount: [openclawOk, hermesOk].filter(Boolean).length,
      total: 2
    },
    agentsSplit: buildAgentSplit(),
    systems: {
      openclaw: {
        service: state.services.openclawGateway,
        port: 19001,
        portOpen: state.network.openclawPortOpen,
        telegramCode: state.network.openclawTelegram,
        openaiCode: state.network.openclawOpenaiHttpCode,
        model: state.config.openclaw.model || "-"
      },
      hermes: {
        service: state.services.hermesGateway,
        port: 18789,
        portOpen: state.network.hermesPortOpen,
        telegramCode: state.network.hermesTelegram,
        openaiCode: state.network.hermesOpenaiHttpCode,
        model: state.config.hermes.model || "-",
        provider: state.config.hermes.provider || "-"
      }
    },
    channels: {
      openclawCode: state.network.openclawTelegram,
      hermesCode: state.network.hermesTelegram,
      proxy: state.config.openclaw.telegramProxy || "-"
    },
    services: {
      openclawGateway: state.services.openclawGateway,
      hermesGateway: state.services.hermesGateway,
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

async function getReviewModels() {
  if (cacheValid(reviewCache.models)) return reviewCache.models.data;

  let sessionStore = {};
  try {
    sessionStore = tryParseJson(await fsp.readFile("/home/ubuntu/.openclaw/agents/main/sessions/sessions.json", "utf8"), {}) || {};
  } catch (_) {}
  const ocItems = Object.values(sessionStore || {});
  const last = ocItems
    .filter((x) => typeof x.updatedAt === "number")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || {};
  const ocModel = last.model || state.config.openclaw.model || "-";
  const hermesDump = await run(`bash -lc "source /home/ubuntu/.hermes/hermes-agent/venv/bin/activate; timeout 15 ${HERMES_BIN} dump"`, 20000);
  const hermesText = `${hermesDump.stdout || ""}\n${hermesDump.stderr || ""}`;
  const hModel = ((hermesText.match(/model:\s+([^\n]+)/) || [])[1] || "").trim();
  const hProvider = ((hermesText.match(/provider:\s+([^\n]+)/) || [])[1] || "").trim();

  const data = {
    updatedAt: safeIso(),
    openclaw: {
      count: ocModel && ocModel !== "-" ? 1 : 0,
      defaultModel: ocModel || "-",
      models: ocModel && ocModel !== "-" ? [{
        key: ocModel,
        name: ocModel,
        contextWindow: Number(last.contextTokens || 0),
        available: true,
        tags: ["active"]
      }] : []
    },
    hermes: {
      model: hModel || "-",
      provider: hProvider || "-",
      dumpOk: !!hermesDump.ok
    }
  };

  reviewCache.models = { at: Date.now(), data };
  return data;
}

async function fetchRemoteModelIds(base, key) {
  if (!key) return [];
  const resolvedBase = String(base || "https://aixj.vip/v1").replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${resolvedBase}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return [];
    const j = await r.json();
    const arr = Array.isArray(j?.data) ? j.data : [];
    return uniqStrings(arr.map((x) => x && x.id).filter(Boolean)).slice(0, 200);
  } catch (_) {
    return [];
  }
}

async function getModelOptions() {
  if (cacheValid(reviewCache.modelOptions)) return reviewCache.modelOptions.data;
  const ctx = await loadConfigAndEnv();
  const env = ctx.openclaw.env || {};
  const hermesEnv = ctx.hermes.env || {};
  const hermesCfg = ctx.hermes.cfg || {};

  const openclawStatus = await runOpenclawJson(`models --agent ${OPENCLAW_MAIN_AGENT} status`, 25000);
  const ocAllowed = Array.isArray(openclawStatus?.allowed) ? openclawStatus.allowed : [];
  const ocCurrent = String(openclawStatus?.resolvedDefault || openclawStatus?.defaultModel || "").replace(/^openai\//, "");
  const ocAliasCurrent = String(openclawStatus?.resolvedDefault || openclawStatus?.defaultModel || "");
  const ocBase = env.OPENAI_BASE_URL || "https://aixj.vip/v1";
  const ocKey = env.OPENAI_API_KEY_DAILY || env.OPENAI_API_KEY || "";
  const remote = await fetchRemoteModelIds(ocBase, ocKey);
  const common = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"];
  const openclawModels = uniqStrings([
    ...ocAllowed.map((x) => String(x || "").replace(/^openai\//, "")),
    ...remote,
    ...common,
    ocCurrent,
    ocAliasCurrent.replace(/^openai\//, "")
  ]);

  const hCurrent = hermesCfg.model || "";
  const hBase = hermesCfg.baseUrl || hermesEnv.OPENAI_BASE_URL || "https://aixj.vip/v1";
  const hKey = hermesEnv.OPENAI_API_KEY || "";
  const hermesRemote = await fetchRemoteModelIds(hBase, hKey);
  const hermesModels = uniqStrings([
    hCurrent,
    ...hermesRemote,
    ...common
  ]);

  const data = {
    updatedAt: safeIso(),
    openclaw: {
      current: openclawModels.includes(ocCurrent) ? ocCurrent : (ocCurrent || "-"),
      options: openclawModels
    },
    hermes: {
      current: hCurrent || "-",
      options: hermesModels
    }
  };
  reviewCache.modelOptions = { at: Date.now(), data };
  return data;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function switchAgentModel(agent, model) {
  const target = String(model || "").trim();
  if (!target) {
    return { ok: false, error: "model is required" };
  }
  if (agent === "openclaw") {
    const cmd = `bash -lc "export PATH=${OPENCLAW_PATH}; timeout 25 ${OPENCLAW_BIN} models --agent ${OPENCLAW_MAIN_AGENT} set openai/${target}"`;
    const r = await run(cmd, 30000);
    if (!r.ok) {
      return { ok: false, error: maskError(r.stderr || r.stdout || r.error || "openclaw model set failed") };
    }
    reviewCache.models = { at: 0, data: null };
    reviewCache.modelOptions = { at: 0, data: null };
    return { ok: true, detail: `openclaw -> ${target}` };
  }
  if (agent === "hermes") {
    const setCmd = `bash -lc "source /home/ubuntu/.hermes/hermes-agent/venv/bin/activate; timeout 20 ${HERMES_BIN} config set model.default ${JSON.stringify(target)}"`;
    const r1 = await run(setCmd, 25000);
    if (!r1.ok) {
      return { ok: false, error: maskError(r1.stderr || r1.stdout || r1.error || "hermes model set failed") };
    }
    const r2 = await run("systemctl --user restart hermes-gateway.service", 20000);
    if (!r2.ok) {
      return { ok: false, error: maskError(r2.stderr || r2.stdout || r2.error || "hermes gateway restart failed") };
    }
    reviewCache.models = { at: 0, data: null };
    reviewCache.modelOptions = { at: 0, data: null };
    return { ok: true, detail: `hermes -> ${target}` };
  }
  return { ok: false, error: "unsupported agent" };
}

async function getReviewSessions() {
  if (cacheValid(reviewCache.sessions)) return reviewCache.sessions.data;

  let openclawSessionsRaw = {};
  try {
    openclawSessionsRaw = tryParseJson(await fsp.readFile("/home/ubuntu/.openclaw/agents/main/sessions/sessions.json", "utf8"), {}) || {};
  } catch (_) {}
  const ocItems = Object.entries(openclawSessionsRaw || {}).map(([key, x]) => ({
    key,
    updatedAt: x.updatedAt || null,
    kind: x.chatType || "-",
    model: x.model || "-",
    totalTokens: Number(x.totalTokens || 0)
  }));

  let hermesSessionsRaw = {};
  try {
    hermesSessionsRaw = tryParseJson(await fsp.readFile("/home/ubuntu/.hermes/sessions/sessions.json", "utf8"), {}) || {};
  } catch (_) {}
  const hItems = Object.values(hermesSessionsRaw || {}).map((x) => ({
    key: x.session_key || x.session_id || "-",
    updatedAt: x.updated_at || null,
    platform: x.platform || (x.origin && x.origin.platform) || "-",
    chatType: x.chat_type || (x.origin && x.origin.chat_type) || "-",
    displayName: x.display_name || (x.origin && x.origin.chat_name) || "-",
    totalTokens: Number(x.total_tokens || 0)
  }));

  const data = {
    updatedAt: safeIso(),
    openclaw: {
      count: ocItems.length,
      items: ocItems
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 20)
    },
    hermes: {
      count: hItems.length,
      items: hItems.slice(0, 20)
    }
  };

  reviewCache.sessions = { at: Date.now(), data };
  return data;
}

async function getReviewSkills() {
  if (cacheValid(reviewCache.skills)) return reviewCache.skills.data;

  let ocSkillsLoaded = [];
  try {
    const openclawSessionsRaw = tryParseJson(await fsp.readFile("/home/ubuntu/.openclaw/agents/main/sessions/sessions.json", "utf8"), {}) || {};
    const latest = Object.values(openclawSessionsRaw || {})
      .filter((x) => typeof x.updatedAt === "number")
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    ocSkillsLoaded = (((latest || {}).skillsSnapshot || {}).resolvedSkills || []).map((x) => ({
      name: x.name || "-",
      source: x.source || "unknown",
      eligible: true,
      bundled: String(x.source || "").includes("bundled")
    }));
  } catch (_) {}

  let hCategories = [];
  let hTotal = 0;
  try {
    const base = "/home/ubuntu/.hermes/skills";
    const cats = await fsp.readdir(base, { withFileTypes: true });
    for (const c of cats) {
      if (!c.isDirectory()) continue;
      const full = path.join(base, c.name);
      const items = await fsp.readdir(full, { withFileTypes: true });
      const count = items.filter((x) => x.isDirectory()).length;
      if (count > 0) {
        hCategories.push({ category: c.name, count });
        hTotal += count;
      }
    }
  } catch (_) {}

  const sourceCounts = {};
  for (const s of ocSkillsLoaded) {
    const k = s.source || "unknown";
    sourceCounts[k] = (sourceCounts[k] || 0) + 1;
  }

  const data = {
    updatedAt: safeIso(),
    openclaw: {
      total: ocSkillsLoaded.length,
      eligible: ocSkillsLoaded.filter((x) => x.eligible).length,
      bundled: ocSkillsLoaded.filter((x) => x.bundled).length,
      sources: sourceCounts,
      available: ocSkillsLoaded.map((x) => ({
        name: x.name,
        source: x.source || "unknown"
      })).slice(0, 80)
    },
    hermes: {
      total: hTotal,
      categories: hCategories.sort((a, b) => b.count - a.count).slice(0, 20),
      available: []
    }
  };

  try {
    const base = "/home/ubuntu/.hermes/skills";
    const cats = await fsp.readdir(base, { withFileTypes: true });
    const all = [];
    for (const c of cats) {
      if (!c.isDirectory()) continue;
      const full = path.join(base, c.name);
      const items = await fsp.readdir(full, { withFileTypes: true });
      for (const it of items) {
        if (!it.isDirectory()) continue;
        all.push({ name: it.name, category: c.name });
      }
    }
    data.hermes.available = all.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 120);
  } catch (_) {}

  reviewCache.skills = { at: Date.now(), data };
  return data;
}

async function getReviewAlerts() {
  if (cacheValid(reviewCache.alerts)) return reviewCache.alerts.data;
  const alerts = [];
  const now = safeIso();

  if (state.services.openclawGateway !== "active") alerts.push({ level: "error", code: "OPENCLAW_GATEWAY_DOWN", message: "OpenClaw 网关未运行", at: now });
  if (state.services.hermesGateway !== "active") alerts.push({ level: "error", code: "HERMES_GATEWAY_DOWN", message: "Hermes 网关未运行", at: now });
  if (state.services.singbox !== "active") alerts.push({ level: "error", code: "SINGBOX_DOWN", message: "sing-box 未运行", at: now });
  if (!state.network.proxyPortOpen) alerts.push({ level: "error", code: "PROXY_PORT_CLOSED", message: "127.0.0.1:7890 未监听", at: now });
  if (state.network.openclawTelegram !== 200) alerts.push({ level: "warn", code: "OPENCLAW_TG_DEGRADED", message: `OpenClaw Telegram=${state.network.openclawTelegram || 0}`, at: now });
  if (state.network.hermesTelegram !== 200) alerts.push({ level: "warn", code: "HERMES_TG_DEGRADED", message: `Hermes Telegram=${state.network.hermesTelegram || 0}`, at: now });
  if (state.network.openclawOpenaiHttpCode !== 200) alerts.push({ level: "warn", code: "OPENCLAW_LLM_DEGRADED", message: `OpenClaw LLM=${state.network.openclawOpenaiHttpCode || 0}`, at: now });
  if (state.network.hermesOpenaiHttpCode !== 200) alerts.push({ level: "warn", code: "HERMES_LLM_DEGRADED", message: `Hermes LLM=${state.network.hermesOpenaiHttpCode || 0}`, at: now });
  if (state.metrics.llmFailed5m > 0) alerts.push({ level: "warn", code: "LLM_FAILED_5M", message: `最近5分钟 LLM失败 ${state.metrics.llmFailed5m} 次`, at: now });
  if (state.metrics.networkErrors5m > 0) alerts.push({ level: "warn", code: "NETWORK_ERRORS_5M", message: `最近5分钟 网络错误 ${state.metrics.networkErrors5m} 次`, at: now });

  const data = {
    updatedAt: now,
    count: alerts.length,
    alerts: alerts.slice(0, 30)
  };
  reviewCache.alerts = { at: Date.now(), data };
  return data;
}

async function updateSnapshot() {
  const [ctx, services, proxyPortOpen, openclawPortOpen, hermesPortOpen, metrics, system] = await Promise.all([
    loadConfigAndEnv(),
    checkServices(),
    checkPort(7890),
    checkPort(19001),
    checkPort(18789),
    getLogMetrics(),
    probeSystem()
  ]);

  const openclawEnv = ctx.openclaw.env || {};
  const openclawCfg = ctx.openclaw.cfg || {};
  const hermesEnv = ctx.hermes.env || {};
  const hermesCfg = ctx.hermes.cfg || {};
  const openclawTgToken = openclawEnv.TELEGRAM_TOKEN_WORK || ((((openclawCfg || {}).channels || {}).telegram || {}).accounts?.tg_work?.botToken) || "";
  const proxyUrl = ((((openclawCfg || {}).channels || {}).telegram || {}).proxy) || "";
  const openclawBase = openclawEnv.OPENAI_BASE_URL || "https://aixj.vip/v1";
  const openclawKey = openclawEnv.OPENAI_API_KEY_DAILY || openclawEnv.OPENAI_API_KEY || "";
  const hermesBase = hermesCfg.baseUrl || hermesEnv.OPENAI_BASE_URL || "https://aixj.vip/v1";
  const hermesKey = hermesEnv.OPENAI_API_KEY || "";
  const hermesTgToken = hermesEnv.TELEGRAM_BOT_TOKEN || "";

  const [openclawOpenaiHttpCode, hermesOpenaiHttpCode, openclawTelegram, hermesTelegram] = await Promise.all([
    probeOpenAI(openclawBase, openclawKey),
    probeOpenAI(hermesBase, hermesKey),
    probeTelegram(openclawTgToken, proxyUrl),
    probeTelegram(hermesTgToken, proxyUrl)
  ]);

  const config = buildConfigSummary(ctx);

  const next = {
    updatedAt: safeIso(),
    services,
    network: {
      proxyPortOpen,
      openclawPortOpen,
      hermesPortOpen,
      openclawOpenaiHttpCode,
      hermesOpenaiHttpCode,
      openclawTelegram,
      hermesTelegram
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

  if (req.method === "GET" && parsed.pathname === "/api/agents-split") {
    return sendJson(res, 200, buildAgentSplit());
  }

  if (req.method === "GET" && parsed.pathname === "/api/architecture") {
    const stats = buildStatsAll();
    return sendJson(res, 200, {
      updatedAt: state.updatedAt,
      nodes: [
        { id: "telegram-openclaw", label: "Telegram @GobelieveClawdBot", status: state.network.openclawTelegram === 200 ? "ok" : "bad" },
        { id: "openclaw", label: "OpenClaw Gateway (19001)", status: state.services.openclawGateway === "active" && state.network.openclawPortOpen ? "ok" : "bad" },
        { id: "telegram-hermes", label: "Telegram @GobelievePersonalAgentBot", status: state.network.hermesTelegram === 200 ? "ok" : "bad" },
        { id: "hermes", label: "Hermes Gateway (18789)", status: state.services.hermesGateway === "active" && state.network.hermesPortOpen ? "ok" : "bad" },
        { id: "proxy", label: "sing-box Proxy (7890)", status: state.services.singbox === "active" && state.network.proxyPortOpen ? "ok" : "bad" },
        { id: "llm", label: "AIXJ LLM API", status: (state.network.openclawOpenaiHttpCode === 200 && state.network.hermesOpenaiHttpCode === 200) ? "ok" : "warn" }
      ],
      links: [
        { from: "telegram-openclaw", to: "openclaw" },
        { from: "telegram-hermes", to: "hermes" },
        { from: "openclaw", to: "proxy" },
        { from: "hermes", to: "proxy" },
        { from: "proxy", to: "llm" }
      ],
      systems: stats.systems
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/test-node") {
    const nodeId = String(parsed.query.node || "").trim();
    if (!nodeId) return sendJson(res, 400, { error: "missing node query parameter" });
    try {
      const result = await runNodeTest(nodeId);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, {
        node: nodeId,
        ok: false,
        detail: maskError(err && (err.message || err)),
        checks: {},
        testedAt: safeIso()
      });
    }
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

  if (req.method === "GET" && parsed.pathname === "/api/review/models") {
    return sendJson(res, 200, await getReviewModels());
  }

  if (req.method === "GET" && parsed.pathname === "/api/review/sessions") {
    return sendJson(res, 200, await getReviewSessions());
  }

  if (req.method === "GET" && parsed.pathname === "/api/review/skills") {
    return sendJson(res, 200, await getReviewSkills());
  }

  if (req.method === "GET" && parsed.pathname === "/api/review/alerts") {
    return sendJson(res, 200, await getReviewAlerts());
  }

  if (req.method === "GET" && parsed.pathname === "/api/review/overview") {
    const [models, sessions, skills, alerts] = await Promise.all([
      getReviewModels(),
      getReviewSessions(),
      getReviewSkills(),
      getReviewAlerts()
    ]);
    return sendJson(res, 200, {
      updatedAt: safeIso(),
      models,
      sessions,
      skills,
      alerts
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/model-options") {
    return sendJson(res, 200, await getModelOptions());
  }

  if (req.method === "POST" && parsed.pathname === "/api/model/switch") {
    try {
      const raw = await readRequestBody(req);
      const j = tryParseJson(raw, {}) || {};
      const agent = String(j.agent || "").trim().toLowerCase();
      const model = String(j.model || "").trim();
      const ret = await switchAgentModel(agent, model);
      if (!ret.ok) return sendJson(res, 400, { ok: false, error: ret.error || "switch failed" });
      await Promise.all([updateSnapshot(), probeAgent(agent).catch(() => {})]);
      return sendJson(res, 200, { ok: true, detail: ret.detail, updatedAt: safeIso() });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: maskError(err && (err.message || err)) });
    }
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
    probeCursor = probeCursor === "openclaw" ? "hermes" : "openclaw";
    probeAgent(agentId)
      .then(() => updateSnapshot())
      .catch((err) => console.error("[probe]", agentId, err.message));
  }, PROBE_INTERVAL_MS);

  probeAgent("openclaw").then(() => updateSnapshot()).catch(() => {});
  probeAgent("hermes").then(() => updateSnapshot()).catch(() => {});

  server.listen(PORT, HOST, () => {
    console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
    console.log(`[dashboard] poll=${POLL_INTERVAL_MS}ms probe=${PROBE_INTERVAL_MS}ms`);
  });
}

start().catch((err) => {
  console.error("[startup] failed:", err);
  process.exit(1);
});
