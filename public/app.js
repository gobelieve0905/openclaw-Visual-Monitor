'use strict';

const $ = (id) => document.getElementById(id);
const nodeTestState = {};

function classByState(el, level) {
  if (!el) return;
  el.classList.remove('ok', 'warn', 'bad');
  if (level) el.classList.add(level);
}

function levelText(v) {
  if (v === 'green') return '正常';
  if (v === 'yellow') return '降级';
  if (v === 'red') return '故障';
  return '未知';
}

function codeText(code) {
  return Number(code) === 200 ? '200 正常' : `${code || 0} 异常`;
}

function stateLevelByCode(code) {
  return Number(code) === 200 ? 'ok' : 'bad';
}

function stateLevelByService(v) {
  return v === 'active' ? 'ok' : 'bad';
}

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function setText(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  if (cls) {
    el.classList.remove('ok', 'warn', 'bad');
    el.classList.add(cls);
  }
}

function applyAgentTestState(agentKey) {
  const mapping = agentKey === 'openclaw'
    ? { status: 'ocTestStatus', time: 'ocTestTime', conclusion: 'ocTestConclusion', error: 'ocTestError', btn: 'ocTestBtn', toolbarTime: 'ocToolbarLastTest' }
    : { status: 'hermesTestStatus', time: 'hermesTestTime', conclusion: 'hermesTestConclusion', error: 'hermesTestError', btn: 'hermesTestBtn', toolbarTime: 'hermesToolbarLastTest' };
  const s = nodeTestState[agentKey] || {};
  const btn = $(mapping.btn);
  if (btn) btn.disabled = !!s.running;
  if (s.running) {
    setText(mapping.status, '正在测试...', 'warn');
    setText(mapping.time, '-');
    setText(mapping.toolbarTime, '-');
    setText(mapping.conclusion, '测试进行中');
    setText(mapping.error, '-');
    if (btn) btn.textContent = '测试中...';
    return;
  }
  if (btn) btn.textContent = '测试 Agent';
  if (!s.testedAt) {
    setText(mapping.status, '未测试');
    setText(mapping.time, '-');
    setText(mapping.toolbarTime, '-');
    setText(mapping.conclusion, '-');
    setText(mapping.error, '-');
    return;
  }
  setText(mapping.status, s.ok ? '测试完成' : '测试失败', s.ok ? 'ok' : 'bad');
  setText(mapping.time, fmtTs(s.testedAt));
  setText(mapping.toolbarTime, fmtTs(s.testedAt));
  setText(mapping.conclusion, s.ok ? `成功 (${s.durationMs || 0}ms)` : `失败 (${s.durationMs || 0}ms)`, s.ok ? 'ok' : 'bad');
  setText(mapping.error, s.ok ? '-' : (s.detail || '-'), s.ok ? '' : 'bad');
}

function applyNodeTestState(nodeId) {
  const s = nodeTestState[nodeId] || {};
  const statusEls = Array.from(document.querySelectorAll(`[data-test-status="${nodeId}"]`));
  const timeEls = Array.from(document.querySelectorAll(`[data-test-time="${nodeId}"]`));
  const conclusionEls = Array.from(document.querySelectorAll(`[data-test-conclusion="${nodeId}"]`));
  const errorEls = Array.from(document.querySelectorAll(`[data-test-error="${nodeId}"]`));
  const btnEls = Array.from(document.querySelectorAll(`.node-test-btn[data-node-id="${nodeId}"]`));
  btnEls.forEach((btn) => { btn.disabled = !!s.running; });
  if (s.running) {
    btnEls.forEach((btn) => { btn.textContent = '测试中...'; });
    statusEls.forEach((el) => { el.textContent = '正在测试...'; el.className = 'warn'; });
    timeEls.forEach((el) => { el.textContent = '-'; });
    conclusionEls.forEach((el) => { el.textContent = '测试进行中'; });
    errorEls.forEach((el) => { el.textContent = '-'; });
    return;
  }
  btnEls.forEach((btn) => { btn.textContent = '测试'; });
  if (!s.testedAt) return;
  statusEls.forEach((el) => { el.textContent = s.ok ? '测试完成' : '测试失败'; el.className = s.ok ? 'ok' : 'bad'; });
  timeEls.forEach((el) => { el.textContent = fmtTs(s.testedAt); });
  conclusionEls.forEach((el) => { el.textContent = s.ok ? `成功 (${s.durationMs || 0}ms)` : `失败 (${s.durationMs || 0}ms)`; el.className = s.ok ? 'ok' : 'bad'; });
  errorEls.forEach((el) => { el.textContent = s.ok ? '-' : (s.detail || '-'); el.className = s.ok ? '' : 'bad'; });
}

async function runNodeTest(nodeId, bindAgentKey) {
  if (!nodeId) return;
  nodeTestState[nodeId] = { ...(nodeTestState[nodeId] || {}), running: true };
  if (bindAgentKey) nodeTestState[bindAgentKey] = { ...(nodeTestState[bindAgentKey] || {}), running: true };
  applyNodeTestState(nodeId);
  if (bindAgentKey) applyAgentTestState(bindAgentKey);

  try {
    const res = await fetch(`/api/test-node?node=${encodeURIComponent(nodeId)}`);
    const j = await res.json();
    const next = {
      running: false,
      ok: !!j.ok,
      testedAt: j.testedAt || new Date().toISOString(),
      durationMs: j.durationMs || 0,
      detail: j.detail || '-',
      checks: j.checks || {}
    };
    nodeTestState[nodeId] = next;
    applyNodeTestState(nodeId);
    if (bindAgentKey) {
      nodeTestState[bindAgentKey] = next;
      applyAgentTestState(bindAgentKey);
    }
  } catch (err) {
    const next = {
      running: false,
      ok: false,
      testedAt: new Date().toISOString(),
      durationMs: 0,
      detail: err && err.message ? err.message : '请求失败',
      checks: {}
    };
    nodeTestState[nodeId] = next;
    applyNodeTestState(nodeId);
    if (bindAgentKey) {
      nodeTestState[bindAgentKey] = next;
      applyAgentTestState(bindAgentKey);
    }
  }
}

function renderArchitecture(data) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const sharedWrap = $('sharedArchNodes');
  const ocWrap = $('ocArchNodes');
  const hWrap = $('hArchNodes');
  const sharedOrder = ['proxy', 'llm'];
  const ocOrder = ['telegram-openclaw', 'openclaw'];
  const hOrder = ['telegram-hermes', 'hermes'];

  function renderGroup(wrap, order) {
    if (!wrap) return;
    wrap.innerHTML = '';
    order.forEach((id) => {
      const n = nodeMap.get(id);
      if (!n) return;
      const d = document.createElement('div');
      d.className = `arch-node ${n.status || 'warn'}`;
      d.innerHTML = `
        <b>${n.label || n.id}</b>
        <small>${n.status || '-'}</small>
        <div class="node-actions">
          <button class="node-test-btn" data-node-id="${n.id}">测试</button>
        </div>
        <div class="test-meta compact">
          <div>状态：<span data-test-status="${n.id}">未测试</span></div>
          <div>上次测试：<span data-test-time="${n.id}">-</span></div>
          <div>结论：<span data-test-conclusion="${n.id}">-</span></div>
          <div>报错：<span data-test-error="${n.id}">-</span></div>
        </div>
      `;
      wrap.appendChild(d);
    });
  }

  renderGroup(sharedWrap, sharedOrder);
  renderGroup(ocWrap, ocOrder);
  renderGroup(hWrap, hOrder);

  document.querySelectorAll('.node-test-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nodeId = btn.getAttribute('data-node-id');
      if (!nodeId) return;
      await runNodeTest(nodeId);
    });
    applyNodeTestState(btn.getAttribute('data-node-id'));
  });
}

function renderEvents(items) {
  const box = $('events');
  if (!box) return;
  box.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    box.innerHTML = '<div class="event">暂无事件</div>';
    return;
  }
  items.slice(0, 60).forEach((ev) => {
    const div = document.createElement('div');
    div.className = `event ${ev.level || ''}`;
    div.textContent = `[${ev.ts || '-'}] ${ev.message || '-'}`;
    box.appendChild(div);
  });
}

function setApiStatus(id, ok) {
  const el = $(id);
  if (!el) return;
  el.textContent = ok ? '正常' : '异常';
  classByState(el, ok ? 'ok' : 'bad');
}

function render(stats, health) {
  const updated = stats?.updatedAt || health?.updatedAt || '-';
  $('updatedAt').textContent = updated;
  $('updatedAtSide').textContent = updated;

  const overallLevel = health?.overall?.level || 'unknown';
  $('overallLevel').textContent = levelText(overallLevel);
  $('overallReason').textContent = health?.overall?.reason || '-';
  classByState($('card-overall'), overallLevel === 'green' ? 'ok' : overallLevel === 'yellow' ? 'warn' : 'bad');

  const oc = stats?.systems?.openclaw || {};
  const hm = stats?.systems?.hermes || {};

  setText('ocStatus', oc.service || '-', stateLevelByService(oc.service));
  $('ocDetail').textContent = `模型: ${oc.model || '-'} / Provider: OpenClaw`;
  classByState($('card-oc'), oc.service === 'active' && oc.portOpen ? 'ok' : 'bad');
  setText('ocServiceQuick', oc.service || '-', stateLevelByService(oc.service));
  setText('ocPortQuick', oc.portOpen ? `${oc.port} open` : `${oc.port} closed`, oc.portOpen ? 'ok' : 'bad');
  setText('ocTgQuick', codeText(oc.telegramCode), stateLevelByCode(oc.telegramCode));
  setText('ocLlmQuick', codeText(oc.openaiCode), stateLevelByCode(oc.openaiCode));

  setText('hermesStatus', hm.service || '-', stateLevelByService(hm.service));
  $('hermesDetail').textContent = `模型: ${hm.model || '-'} / Provider: ${hm.provider || '-'}`;
  classByState($('card-hermes'), hm.service === 'active' && hm.portOpen ? 'ok' : 'bad');
  setText('hServiceQuick', hm.service || '-', stateLevelByService(hm.service));
  setText('hPortQuick', hm.portOpen ? `${hm.port} open` : `${hm.port} closed`, hm.portOpen ? 'ok' : 'bad');
  setText('hTgQuick', codeText(hm.telegramCode), stateLevelByCode(hm.telegramCode));
  setText('hLlmQuick', codeText(hm.openaiCode), stateLevelByCode(hm.openaiCode));

  const proxyOpen = !!stats?.services?.proxyPortOpen;
  $('proxyStatus').textContent = proxyOpen ? '已监听' : '未监听';
  $('proxyDetail').textContent = `sing-box: ${stats?.services?.singbox || '-'}`;
  classByState($('card-proxy'), proxyOpen && stats?.services?.singbox === 'active' ? 'ok' : 'bad');

  $('ocService').textContent = oc.service || '-';
  classByState($('ocService'), stateLevelByService(oc.service));
  $('ocPort').textContent = oc.portOpen ? `${oc.port} open` : `${oc.port} closed`;
  classByState($('ocPort'), oc.portOpen ? 'ok' : 'bad');
  $('ocTg').textContent = codeText(oc.telegramCode);
  classByState($('ocTg'), stateLevelByCode(oc.telegramCode));
  $('ocLlm').textContent = codeText(oc.openaiCode);
  classByState($('ocLlm'), stateLevelByCode(oc.openaiCode));
  $('ocModel').textContent = oc.model || '-';

  $('hService').textContent = hm.service || '-';
  classByState($('hService'), stateLevelByService(hm.service));
  $('hPort').textContent = hm.portOpen ? `${hm.port} open` : `${hm.port} closed`;
  classByState($('hPort'), hm.portOpen ? 'ok' : 'bad');
  $('hTg').textContent = codeText(hm.telegramCode);
  classByState($('hTg'), stateLevelByCode(hm.telegramCode));
  $('hLlm').textContent = codeText(hm.openaiCode);
  classByState($('hLlm'), stateLevelByCode(hm.openaiCode));
  $('hModel').textContent = `${hm.model || '-'} / ${hm.provider || '-'}`;

  applyAgentTestState('openclaw');
  applyAgentTestState('hermes');
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function refreshOnce() {
  const result = { healthOk: false, statsOk: false, archOk: false, eventsOk: false };

  let health = null;
  let stats = null;
  let arch = null;

  try {
    health = await fetchJson('/api/health');
    result.healthOk = true;
  } catch (_) {}

  try {
    stats = await fetchJson('/api/stats-all');
    result.statsOk = true;
  } catch (_) {}

  try {
    arch = await fetchJson('/api/architecture');
    result.archOk = true;
  } catch (_) {}

  try {
    const events = await fetchJson('/api/events?limit=40');
    renderEvents(events.items || []);
    result.eventsOk = true;
  } catch (_) {
    renderEvents([]);
  }

  if (stats || health) render(stats || {}, health || {});
  if (arch) renderArchitecture(arch);

  setApiStatus('apiHealth', result.healthOk);
  setApiStatus('apiStats', result.statsOk);
  setApiStatus('apiArch', result.archOk);
  setApiStatus('apiEvents', result.eventsOk);
}

async function boot() {
  const ocBtn = $('ocTestBtn');
  const hermesBtn = $('hermesTestBtn');
  const ocRefreshBtn = $('ocRefreshBtn');
  const hermesRefreshBtn = $('hermesRefreshBtn');
  if (ocBtn) ocBtn.addEventListener('click', async () => runNodeTest('openclaw', 'openclaw'));
  if (hermesBtn) hermesBtn.addEventListener('click', async () => runNodeTest('hermes', 'hermes'));
  if (ocRefreshBtn) ocRefreshBtn.addEventListener('click', async () => refreshOnce());
  if (hermesRefreshBtn) hermesRefreshBtn.addEventListener('click', async () => refreshOnce());

  await refreshOnce();
  setInterval(() => refreshOnce().catch(() => {}), 15000);

  try {
    const es = new EventSource('/api/stream');
    $('apiSse').textContent = '正常';
    classByState($('apiSse'), 'ok');
    es.onmessage = async () => {
      await refreshOnce();
    };
    es.onerror = () => {
      $('apiSse').textContent = '异常';
      classByState($('apiSse'), 'bad');
    };
  } catch (_) {
    $('apiSse').textContent = '异常';
    classByState($('apiSse'), 'bad');
  }
}

boot().catch(() => {});
