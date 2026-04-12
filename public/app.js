'use strict';

const $ = (id) => document.getElementById(id);
const navItems = Array.from(document.querySelectorAll('.nav-item'));

function classCard(selector, level) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.classList.remove('ok', 'warn', 'bad');
  if (level === 'ok') el.classList.add('ok');
  else if (level === 'warn') el.classList.add('warn');
  else if (level === 'bad') el.classList.add('bad');
}

function classBadge(id, level, text) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('ok', 'warn', 'bad');
  if (level) el.classList.add(level);
  if (text != null) el.textContent = text;
}

function overallText(level) {
  return level === 'green' ? '正常' : level === 'yellow' ? '降级' : level === 'red' ? '故障' : '未知';
}

function scoreLevel(score) {
  if (score >= 95) return 'ok';
  if (score >= 70) return 'warn';
  return 'bad';
}

function yn(flag) {
  return flag ? '已配置' : '缺失';
}

function translateOverallReason(reason) {
  if (!reason) return '-';
  const map = [
    ['all checks passed', '所有检查通过'],
    ['warming up: waiting first agent probes', '预热中：等待 Agent 首次探针'],
    ['critical:', '严重异常:'],
    ['degraded:', '服务降级:'],
    ['agents unhealthy', 'Agent 不健康'],
    ['partial agent degradation', '部分 Agent 降级'],
    ['gateway', 'Gateway'],
    ['sing-box', 'sing-box'],
    ['proxy-port', '代理端口'],
    ['openai-relay', 'OpenAI 中转'],
    ['telegram-daily', 'Telegram Daily'],
    ['telegram-work', 'Telegram Work']
  ];
  let out = String(reason);
  for (const [from, to] of map) out = out.replaceAll(from, to);
  return out;
}

function updateNavByScroll() {
  const sections = navItems
    .map((n) => ({ nav: n, section: document.querySelector(n.getAttribute('href')) }))
    .filter((x) => x.section);

  let active = null;
  for (const item of sections) {
    const rect = item.section.getBoundingClientRect();
    if (rect.top <= 120) active = item.nav;
  }
  if (!active && sections[0]) active = sections[0].nav;

  navItems.forEach((n) => n.classList.remove('active'));
  if (active) active.classList.add('active');
}

navItems.forEach((n) => {
  n.addEventListener('click', (e) => {
    const href = n.getAttribute('href');
    if (!href || !href.startsWith('#')) return;
    const target = document.querySelector(href);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
window.addEventListener('scroll', updateNavByScroll, { passive: true });

function updateEvents(items) {
  const box = $('events');
  if (!box) return;
  box.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    box.innerHTML = '<div class="event">暂无事件</div>';
    return;
  }
  for (const ev of items) {
    const div = document.createElement('div');
    div.className = `event ${ev.level || ''}`;
    div.innerHTML = `<span class="ts">${ev.ts || '-'}</span><span>${(ev.message || '-').replace(/</g, '&lt;')}</span>`;
    box.appendChild(div);
  }
}

async function refreshEvents() {
  try {
    const r = await fetch('/api/events?limit=60');
    const j = await r.json();
    updateEvents(j.items || []);
    classBadge('badge-events', null, `${(j.items || []).length}`);
  } catch (_) {
    updateEvents([]);
  }
}

function update(snapshot, stats) {
  $('updatedAt').textContent = `更新时间: ${snapshot.updatedAt || '-'}`;
  $('updatedAtSide').textContent = `更新时间: ${snapshot.updatedAt || '-'}`;

  const overall = snapshot.overall?.level || 'unknown';
  $('overall').textContent = overallText(overall);
  $('overallReason').textContent = translateOverallReason(snapshot.overall?.reason || '-');
  classCard('[data-key="overall"]', overall === 'green' ? 'ok' : overall === 'yellow' ? 'warn' : 'bad');
  classBadge('badge-overview', overall === 'green' ? 'ok' : overall === 'yellow' ? 'warn' : 'bad', overallText(overall));
  $('sideOverall').textContent = overallText(overall);

  $('gateway').textContent = snapshot.services.gateway || '-';
  const gwOk = snapshot.services.gateway === 'active';
  classCard('[data-key="gateway"]', gwOk ? 'ok' : 'bad');
  $('sideGateway').textContent = snapshot.services.gateway || '-';

  $('singbox').textContent = snapshot.services.singbox || '-';
  const sbOk = snapshot.services.singbox === 'active';
  classCard('[data-key="singbox"]', sbOk ? 'ok' : 'bad');
  $('sideSingbox').textContent = snapshot.services.singbox || '-';

  $('proxy').textContent = snapshot.network.proxyPortOpen ? '已监听' : '未监听';
  classCard('[data-key="proxy"]', snapshot.network.proxyPortOpen ? 'ok' : 'bad');

  $('openai').textContent = String(snapshot.network.openaiHttpCode || 0);
  classCard('[data-key="openai"]', snapshot.network.openaiHttpCode === 200 ? 'ok' : 'bad');

  $('tgDaily').textContent = String(snapshot.network.telegramDaily || 0);
  classCard('[data-key="tgDaily"]', snapshot.network.telegramDaily === 200 ? 'ok' : 'bad');

  $('tgWork').textContent = String(snapshot.network.telegramWork || 0);
  classCard('[data-key="tgWork"]', snapshot.network.telegramWork === 200 ? 'ok' : 'bad');

  $('agentMain').textContent = snapshot.agents.main.status || '-';
  $('agentMainDetail').textContent = `延迟=${snapshot.agents.main.latencyMs ?? '-'}ms, ${snapshot.agents.main.detail || '-'}`;
  classCard('[data-key="agentMain"]', snapshot.agents.main.status === 'ok' ? 'ok' : snapshot.agents.main.status === 'unknown' ? 'warn' : 'bad');

  $('agentWork').textContent = snapshot.agents.work.status || '-';
  $('agentWorkDetail').textContent = `延迟=${snapshot.agents.work.latencyMs ?? '-'}ms, ${snapshot.agents.work.detail || '-'}`;
  classCard('[data-key="agentWork"]', snapshot.agents.work.status === 'ok' ? 'ok' : snapshot.agents.work.status === 'unknown' ? 'warn' : 'bad');

  const agentsOk = snapshot.agents.main.status === 'ok' && snapshot.agents.work.status === 'ok';
  classBadge('badge-agents', agentsOk ? 'ok' : 'warn', agentsOk ? '正常' : '降级');

  const split = stats?.agentsSplit || {};
  const splitMain = split.main || {};
  const splitWork = split.work || {};
  const mainScore = Number(splitMain.score || 0);
  const workScore = Number(splitWork.score || 0);

  $('splitMainScore').textContent = `${mainScore}%`;
  $('splitMainDetail').textContent = splitMain.model || '-';
  $('splitMainChannel').textContent = `${splitMain.channel?.name || '-'} (${splitMain.channel?.httpCode ?? 0})`;
  $('splitMainProbe').textContent = splitMain.status === 'ok' ? '正常' : splitMain.status === 'error' ? '异常' : (splitMain.status || '-');
  $('splitMainLatency').textContent = splitMain.latencyMs != null ? `${splitMain.latencyMs}ms` : '-';
  $('splitMainLastOk').textContent = splitMain.lastOkAt || '-';
  classCard('[data-key="splitMain"]', scoreLevel(mainScore));

  $('splitWorkScore').textContent = `${workScore}%`;
  $('splitWorkDetail').textContent = splitWork.model || '-';
  $('splitWorkChannel').textContent = `${splitWork.channel?.name || '-'} (${splitWork.channel?.httpCode ?? 0})`;
  $('splitWorkProbe').textContent = splitWork.status === 'ok' ? '正常' : splitWork.status === 'error' ? '异常' : (splitWork.status || '-');
  $('splitWorkLatency').textContent = splitWork.latencyMs != null ? `${splitWork.latencyMs}ms` : '-';
  $('splitWorkLastOk').textContent = splitWork.lastOkAt || '-';
  classCard('[data-key="splitWork"]', scoreLevel(workScore));

  const avgScore = Math.round((mainScore + workScore) / 2);
  classBadge('badge-agent-split', scoreLevel(avgScore), `${avgScore}%`);

  $('mReq').textContent = String(snapshot.metrics.llmRequest5m || 0);
  $('mSend').textContent = String(snapshot.metrics.sendOk5m || 0);
  $('mLlmFail').textContent = String(snapshot.metrics.llmFailed5m || 0);
  classBadge('badge-activity', (snapshot.metrics.llmFailed5m || 0) === 0 ? 'ok' : 'warn', 'ACT');

  $('rowDailyCode').textContent = String(snapshot.network.telegramDaily || 0);
  $('rowDailyState').textContent = snapshot.network.telegramDaily === 200 ? '正常' : '异常';
  $('rowWorkCode').textContent = String(snapshot.network.telegramWork || 0);
  $('rowWorkState').textContent = snapshot.network.telegramWork === 200 ? '正常' : '异常';
  $('rowProxyUrl').textContent = stats?.channels?.proxy || snapshot.config.telegramProxy || '-';
  classBadge('badge-channels', snapshot.network.telegramDaily === 200 && snapshot.network.telegramWork === 200 ? 'ok' : 'bad', 'TG');

  $('rowGateway').textContent = snapshot.services.gateway || '-';
  $('rowSingbox').textContent = snapshot.services.singbox || '-';
  $('rowProxy').textContent = snapshot.network.proxyPortOpen ? '已监听' : '未监听';
  $('rowKeyDaily').textContent = yn(snapshot.config.hasDailyKey);
  $('rowKeyWork').textContent = yn(snapshot.config.hasWorkKey);
  $('rowTokenDaily').textContent = yn(snapshot.config.hasDailyToken);
  $('rowTokenWork').textContent = yn(snapshot.config.hasWorkToken);
  classBadge('badge-services', gwOk && sbOk && snapshot.network.proxyPortOpen ? 'ok' : 'bad', 'SYS');

  $('mNet').textContent = String(snapshot.metrics.networkErrors5m || 0);
  $('mTimeout').textContent = String(snapshot.metrics.timeoutErrors5m || 0);
  $('mFailover').textContent = String(snapshot.metrics.failover5m || 0);
  const errSum = (snapshot.metrics.networkErrors5m || 0) + (snapshot.metrics.timeoutErrors5m || 0) + (snapshot.metrics.llmFailed5m || 0);
  classBadge('badge-errors', errSum === 0 ? 'ok' : 'warn', errSum === 0 ? '0' : String(errSum));

  $('sysLoad1').textContent = String(snapshot.system.load1 ?? 0);
  $('sysMem').textContent = `${snapshot.system.memUsedPct ?? 0}%`;
  $('sysDisk').textContent = `${snapshot.system.diskUsedPct ?? 0}%`;
  $('sysUptime').textContent = snapshot.system.uptime || '-';
  const sysOk = (snapshot.system.memUsedPct ?? 0) < 90 && (snapshot.system.diskUsedPct ?? 0) < 90;
  classBadge('badge-system', sysOk ? 'ok' : 'warn', 'HOST');
}

function drawTrend(items) {
  const canvas = $('trend');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, w, h);

  const pad = 20;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  ctx.strokeStyle = '#253042';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const y = pad + (innerH / 2) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  const points = items.slice(-120).map((x) => (x.overall === 'green' ? 2 : x.overall === 'yellow' ? 1 : 0));
  if (points.length < 2) return;

  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((v, i) => {
    const x = pad + (innerW * i) / (points.length - 1);
    const y = pad + ((2 - v) / 2) * innerH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

async function refreshHistory() {
  const res = await fetch('/api/history?limit=120');
  const j = await res.json();
  drawTrend(j.items || []);
}

async function refreshStats() {
  const res = await fetch('/api/stats-all');
  return res.json();
}

async function boot() {
  const [h, s] = await Promise.all([
    fetch('/api/health').then((r) => r.json()),
    refreshStats()
  ]);

  update(h, s);
  await refreshHistory();
  await refreshEvents();
  updateNavByScroll();

  setInterval(() => { refreshEvents().catch(() => {}); }, 15000);

  const es = new EventSource('/api/stream');
  es.onmessage = (evt) => {
    try {
      const payload = JSON.parse(evt.data);
      if (payload.type === 'snapshot') {
        update(payload.data, payload.stats || null);
        refreshHistory().catch(() => {});
      }
    } catch (_) {}
  };
}

boot().catch((err) => console.error(err));
