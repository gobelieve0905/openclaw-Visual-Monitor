'use strict';

const $ = (id) => document.getElementById(id);
const nodeTestState = {};
const BJ_TZ = 'Asia/Shanghai';
let trendRange = 'day';
const VIEW_DEFAULT = 'overview';
const VIEW_SET = new Set(['overview', 'openclaw', 'hermes']);
let openclawSkillItems = [];
let ocSkillListCollapsed = false;

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
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: BJ_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(d);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} CST`;
  } catch (_) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad((d.getUTCHours() + 8) % 24)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} CST`;
  }
}

function setText(id, text, cls) {
  const el = $(id);
  if (!el) return;
  const prev = el.textContent;
  el.textContent = text;
  if (prev !== String(text)) {
    el.classList.remove('value-flash');
    void el.offsetWidth;
    el.classList.add('value-flash');
    setTimeout(() => el.classList.remove('value-flash'), 2000);
  }
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

async function runAgentTest(agentKey) {
  const plan = agentKey === 'openclaw'
    ? ['openclaw', 'telegram-openclaw', 'proxy', 'llm']
    : ['hermes', 'telegram-hermes', 'proxy', 'llm'];
  const mainNode = agentKey === 'openclaw' ? 'openclaw' : 'hermes';
  const portLabel = agentKey === 'openclaw' ? '19001' : '18789';

  nodeTestState[agentKey] = { ...(nodeTestState[agentKey] || {}), running: true };
  applyAgentTestState(agentKey);

  const results = [];
  for (const nodeId of plan) {
    await runNodeTest(nodeId);
    results.push({ nodeId, ...(nodeTestState[nodeId] || {}) });
  }

  const failed = results.filter((r) => !r.ok).map((r) => r.nodeId);
  const mainChecks = nodeTestState[mainNode]?.checks || {};
  const portOpen = mainChecks.portOpen === true;
  const ok = failed.length === 0 && portOpen;
  const testedAt = new Date().toISOString();
  const durationMs = results.reduce((acc, r) => acc + (r.durationMs || 0), 0);
  const detail = ok
    ? `链路通过，端口 ${portLabel}=open`
    : `失败节点: ${failed.join(', ') || '-'}；端口 ${portLabel}=${portOpen ? 'open' : 'closed'}`;

  nodeTestState[agentKey] = {
    running: false,
    ok,
    testedAt,
    durationMs,
    detail,
    checks: { portOpen, failedNodes: failed }
  };
  applyAgentTestState(agentKey);
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

  document.querySelectorAll('.node-test-btn[data-node-id]').forEach((btn) => {
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

function resolveViewFromHash() {
  const raw = (window.location.hash || '').replace(/^#/, '').trim();
  if (VIEW_SET.has(raw)) return raw;
  return VIEW_DEFAULT;
}

function applyView(view) {
  document.querySelectorAll('[data-view]').forEach((sec) => {
    if (sec.getAttribute('data-view') === view) sec.classList.remove('module-hidden');
    else sec.classList.add('module-hidden');
  });
  document.querySelectorAll('[data-view-link]').forEach((a) => {
    if (a.getAttribute('data-view-link') === view) a.classList.add('active');
    else a.classList.remove('active');
  });
}

function initViewRouter() {
  const update = () => applyView(resolveViewFromHash());
  window.addEventListener('hashchange', update);
  update();
}

function td(v, cls = '') {
  return `<td class="${cls}">${v == null ? '-' : String(v)}</td>`;
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLabel(ts, range) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  if (range === 'day') {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: BJ_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }
  if (range === 'week') {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: BJ_TZ, month: '2-digit', day: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat('zh-CN', { timeZone: BJ_TZ, month: '2-digit', day: '2-digit' }).format(d);
}

function aggregateHistory(items, range) {
  const now = Date.now();
  const bucketMs = range === 'day' ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const spanMs = range === 'day' ? 24 * 60 * 60 * 1000 : (range === 'week' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000);
  const start = now - spanMs;
  const map = new Map();

  (items || []).forEach((x) => {
    const t = Date.parse(x.ts || '');
    if (!Number.isFinite(t) || t < start) return;
    const k = Math.floor((t - start) / bucketMs);
    const obj = map.get(k) || { count: 0, req: 0, latencySum: 0, latencyN: 0, ts: start + k * bucketMs };
    obj.count += 1;
    obj.req += Number(x.metrics?.llmRequest5m || 0);
    const ocLat = Number(x.agents?.openclaw?.latencyMs || 0);
    const hLat = Number(x.agents?.hermes?.latencyMs || 0);
    if (ocLat > 0) { obj.latencySum += ocLat; obj.latencyN += 1; }
    if (hLat > 0) { obj.latencySum += hLat; obj.latencyN += 1; }
    map.set(k, obj);
  });

  const points = [];
  const maxK = Math.ceil(spanMs / bucketMs);
  for (let i = 0; i <= maxK; i += 1) {
    const b = map.get(i) || { req: 0, latencySum: 0, latencyN: 0, ts: start + i * bucketMs };
    const req = Number(b.req || 0);
    points.push({
      label: formatLabel(b.ts, range),
      token: req * 1200,
      latency: b.latencyN > 0 ? Math.round(b.latencySum / b.latencyN) : 0
    });
  }
  return points.filter((_, idx) => range !== 'day' || idx % 2 === 0).slice(-24);
}

function renderLineChart(svgId, points, valueKey, color) {
  const svg = $(svgId);
  if (!svg) return;
  const w = 720; const h = 240;
  const p = { l: 46, r: 14, t: 16, b: 30 };
  const cw = w - p.l - p.r;
  const ch = h - p.t - p.b;
  const vals = points.map((x) => Number(x[valueKey] || 0));
  const max = Math.max(1, ...vals);
  const min = 0;
  const x = (i) => p.l + (i / Math.max(1, points.length - 1)) * cw;
  const y = (v) => p.t + (1 - (v - min) / (max - min || 1)) * ch;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(max * r));
  const grid = ticks.map((t) => `<g><line x1="${p.l}" y1="${y(t)}" x2="${w - p.r}" y2="${y(t)}" stroke="#e6edf8"/><text x="${p.l - 6}" y="${y(t) + 4}" font-size="10" text-anchor="end" fill="#64748b">${t}</text></g>`).join('');
  const poly = points.map((pt, i) => `${x(i)},${y(Number(pt[valueKey] || 0))}`).join(' ');
  const dots = points.map((pt, i) => `<circle cx="${x(i)}" cy="${y(Number(pt[valueKey] || 0))}" r="2.2" fill="${color}"><title>${pt.label}: ${pt[valueKey]}</title></circle>`).join('');
  const labelsStep = Math.max(1, Math.floor(points.length / 8));
  const labels = points.map((pt, i) => (i % labelsStep === 0 || i === points.length - 1)
    ? `<text x="${x(i)}" y="${h - 10}" font-size="10" text-anchor="middle" fill="#64748b">${pt.label}</text>` : '').join('');

  svg.innerHTML = `${grid}<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2.2"/>${dots}${labels}`;
}

function renderTrendPanels(points) {
  renderLineChart('tokenChart', points, 'token', '#2563eb');
  renderLineChart('latencyChart', points, 'latency', '#ea580c');
}

function renderModels(data) {
  const oc = data?.openclaw || {};
  const ocModels = Array.isArray(oc.models) ? oc.models : [];
  const h = data?.hermes || {};

  setText('ocModelCount', ocModels.length);
  setText('ocModelSummary', ocModels[0]?.name || ocModels[0]?.key || '-');
  setText('hModelSummary', h.model || '-');
  setText('hProviderSummary', h.provider || '-');

  const ocBody = $('ocModelsTbody');
  if (ocBody) {
    const rows = ocModels.map((m) =>
      `<tr>${td(m.name || m.key || '-')}${td(m.contextWindow || '-')}${td(m.available ? '可用' : '异常', m.available ? 'ok' : 'bad')}</tr>`
    );
    ocBody.innerHTML = rows.join('') || `<tr><td colspan="3">暂无模型数据</td></tr>`;
  }
}

function renderModelOptions(data) {
  const oc = data?.openclaw || {};
  const h = data?.hermes || {};
  const ocSel = $('ocModelSelect');
  const hSel = $('hModelSelect');
  if (ocSel) {
    const opts = Array.isArray(oc.options) ? oc.options : [];
    ocSel.innerHTML = opts.map((m) => `<option value="${m}">${m}</option>`).join('') || '<option value="">-</option>';
    if (oc.current && opts.includes(oc.current)) ocSel.value = oc.current;
  }
  if (hSel) {
    const opts = Array.isArray(h.options) ? h.options : [];
    hSel.innerHTML = opts.map((m) => `<option value="${m}">${m}</option>`).join('') || '<option value="">-</option>';
    if (h.current && opts.includes(h.current)) hSel.value = h.current;
  }
}

function renderSessions(data) {
  setText('ocSessionCount', data?.openclaw?.count ?? '-');
  setText('hSessionCount', data?.hermes?.count ?? '-');

  const ocBody = $('ocSessionsTbody');
  if (ocBody) {
    const rows = (data?.openclaw?.items || []).map((x) =>
      `<tr>${td(x.key)}${td(x.kind || '-')}${td(x.model || '-')}${td(x.totalTokens ?? 0)}${td(fmtTs(x.updatedAt))}</tr>`
    );
    ocBody.innerHTML = rows.join('') || `<tr><td colspan="5">暂无 OpenClaw 会话</td></tr>`;
  }

  const hBody = $('hSessionsTbody');
  if (hBody) {
    const rows = (data?.hermes?.items || []).map((x) =>
      `<tr>${td(x.key)}${td(x.chatType || '-')}${td(x.platform || '-')}${td(x.totalTokens ?? 0)}${td(fmtTs(x.updatedAt))}</tr>`
    );
    hBody.innerHTML = rows.join('') || `<tr><td colspan="5">暂无 Hermes 会话</td></tr>`;
  }
}

function renderSkills(data) {
  setText('ocSkillTotal', data?.openclaw?.total ?? '-');
  setText('ocSkillEligible', data?.openclaw?.eligible ?? '-');
  setText('ocSkillEligibleDup', data?.openclaw?.eligible ?? '-');
  setText('hSkillTotal', data?.hermes?.total ?? '-');
  setText('hSkillCats', (data?.hermes?.categories || []).length);
  setText('hSkillCatsDup', (data?.hermes?.categories || []).length);
  const body = $('skillsTbody');
  if (!body) return;
  const rows = (data?.hermes?.categories || []).map((x) => `<tr>${td(x.category)}${td(x.count)}</tr>`);
  body.innerHTML = rows.join('') || `<tr><td colspan="2">暂无技能数据</td></tr>`;

  const ocList = $('ocSkillList');
  if (ocList) {
    const items = Array.isArray(data?.openclaw?.available) ? data.openclaw.available : [];
    openclawSkillItems = items;
    ocList.innerHTML = items.length
      ? items.map((x, idx) => {
        const rawName = String(x.name || '-');
        const name = esc(rawName);
        const purpose = esc(x.purpose || '-');
        return `
          <div class="skill-table-row" data-skill-row="${idx}">
            <div class="skill-table-main">
              <span class="skill-table-name">${name}</span>
              <span class="skill-table-state"><i class="dot ok"></i>可用</span>
            </div>
            <div class="skill-table-note-line" data-purpose-view="${idx}" title="双击编辑备注">${purpose}</div>
            <div class="skill-note-edit is-hidden" id="ocSkillEdit-${idx}">
              <input class="skill-note-input" id="ocSkillNoteInput-${idx}" value="${purpose}" />
              <button class="skill-note-save" data-skill-save="${idx}">保存</button>
              <button class="skill-note-cancel" data-skill-cancel="${idx}">取消</button>
            </div>
            <span class="skill-note-msg" id="ocSkillNoteMsg-${idx}">-</span>
          </div>
        `;
      }).join('')
      : '<span class="muted">暂无可用技能</span>';

    ocList.onclick = async (evt) => {
      const cancelBtn = evt.target.closest('[data-skill-cancel]');
      if (cancelBtn) {
        const idx = Number(cancelBtn.getAttribute('data-skill-cancel') || -1);
        const editRow = $(`ocSkillEdit-${idx}`);
        if (editRow) editRow.classList.add('is-hidden');
        return;
      }

      const saveBtn = evt.target.closest('[data-skill-save]');
      if (!saveBtn) return;
      const idx = Number(saveBtn.getAttribute('data-skill-save') || -1);
      const skillName = String(openclawSkillItems[idx]?.name || '').trim();
      const input = $(`ocSkillNoteInput-${idx}`);
      const msg = $(`ocSkillNoteMsg-${idx}`);
      const note = input && typeof input.value === 'string' ? input.value.trim() : '';
      if (!skillName) {
        if (msg) msg.textContent = '保存失败: skillName 无效';
        return;
      }
      saveBtn.disabled = true;
      if (msg) msg.textContent = '保存中...';
      try {
        const r = await fetch('/api/skills/note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: 'openclaw', skillName, note })
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (msg) msg.textContent = '已保存';
        const editRow = $(`ocSkillEdit-${idx}`);
        if (editRow) editRow.classList.add('is-hidden');
        await refreshOnce();
      } catch (err) {
        if (msg) msg.textContent = `保存失败: ${err && err.message ? err.message : 'unknown'}`;
      } finally {
        saveBtn.disabled = false;
      }
    };

    ocList.ondblclick = (evt) => {
      const target = evt.target.closest('[data-purpose-view]');
      if (!target) return;
      const idx = Number(target.getAttribute('data-purpose-view') || -1);
      const editRow = $(`ocSkillEdit-${idx}`);
      if (!editRow) return;
      editRow.classList.remove('is-hidden');
      const input = $(`ocSkillNoteInput-${idx}`);
      if (input) {
        input.focus();
        input.select();
      }
    };

    ocList.classList.toggle('collapsed', ocSkillListCollapsed);
  }

  const hList = $('hSkillList');
  if (hList) {
    const items = Array.isArray(data?.hermes?.available) ? data.hermes.available : [];
    hList.innerHTML = items.length
      ? items.map((x) => `<span class="skill-pill">${x.name} <small>(${x.category || 'misc'})</small></span>`).join('')
      : '<span class="muted">暂无可用技能</span>';
  }
}

function renderAlerts(data) {
  const body = $('alertsTbody');
  if (!body) return;
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  if (alerts.length === 0) {
    body.innerHTML = `<tr><td>${'info'}</td><td>NORMAL</td><td class="ok">当前无告警</td><td>${fmtTs(data?.updatedAt)}</td></tr>`;
    return;
  }
  body.innerHTML = alerts.map((x) => `<tr>${td(x.level, x.level === 'error' ? 'bad' : 'warn')}${td(x.code || '-')}${td(x.message || '-')}${td(fmtTs(x.at))}</tr>`).join('');
}

function render(stats, health) {
  const updated = stats?.updatedAt || health?.updatedAt || '-';
  $('updatedAt').textContent = fmtTs(updated);
  $('updatedAtSide').textContent = fmtTs(updated);

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

  setText('mReq', stats?.activity?.llmRequest5m ?? '-');
  setText('mLlmFail', stats?.errors?.llmFailed5m ?? '-');
  setText('mNetErr', stats?.errors?.networkErrors5m ?? '-');
  const load = stats?.system?.load1 ?? 0;
  const mem = stats?.system?.memUsedPct ?? 0;
  setText('mSysLoad', `${load} / ${mem}%`);

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

  try {
    const review = await fetchJson('/api/review/overview');
    renderModels(review.models || {});
    renderSessions(review.sessions || {});
    renderSkills(review.skills || {});
    renderAlerts(review.alerts || {});
  } catch (_) {}

  try {
    const modelOptions = await fetchJson('/api/model-options');
    renderModelOptions(modelOptions || {});
  } catch (_) {}

  try {
    const hist = await fetchJson('/api/history?limit=2000');
    const points = aggregateHistory(hist.items || [], trendRange);
    renderTrendPanels(points);
  } catch (_) {}

  if (stats || health) render(stats || {}, health || {});
  if (arch) renderArchitecture(arch);

  setApiStatus('apiHealth', result.healthOk);
  setApiStatus('apiStats', result.statsOk);
  setApiStatus('apiArch', result.archOk);
  setApiStatus('apiEvents', result.eventsOk);
}

async function switchModel(agentKey, selectId, msgId, btnId) {
  const sel = $(selectId);
  const msg = $(msgId);
  const btn = $(btnId);
  const model = sel && sel.value ? String(sel.value).trim() : '';
  if (!model) {
    if (msg) msg.textContent = '请选择模型';
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '应用中...';
  }
  if (msg) msg.textContent = `正在切换到 ${model}...`;
  try {
    const r = await fetch('/api/model/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentKey, model })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (msg) msg.textContent = `已切换: ${model}`;
    await refreshOnce();
  } catch (err) {
    if (msg) msg.textContent = `切换失败: ${err && err.message ? err.message : 'unknown'}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '应用模型';
    }
  }
}

async function refreshNow(btnId) {
  const btn = $(btnId);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '刷新中...';
  }
  try {
    await refreshOnce();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '刷新状态';
    }
  }
}

async function boot() {
  const ocBtn = $('ocTestBtn');
  const hermesBtn = $('hermesTestBtn');
  const ocRefreshBtn = $('ocRefreshBtn');
  const hermesRefreshBtn = $('hermesRefreshBtn');
  const ocModelApplyBtn = $('ocModelApplyBtn');
  const hModelApplyBtn = $('hModelApplyBtn');
  const ocSkillToggleBtn = $('ocSkillToggleBtn');
  document.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const r = btn.getAttribute('data-range') || 'day';
      trendRange = r;
      document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await refreshOnce();
    });
  });
  if (ocBtn) ocBtn.addEventListener('click', async () => runAgentTest('openclaw'));
  if (hermesBtn) hermesBtn.addEventListener('click', async () => runAgentTest('hermes'));
  if (ocRefreshBtn) ocRefreshBtn.addEventListener('click', async () => refreshNow('ocRefreshBtn'));
  if (hermesRefreshBtn) hermesRefreshBtn.addEventListener('click', async () => refreshNow('hermesRefreshBtn'));
  if (ocModelApplyBtn) ocModelApplyBtn.addEventListener('click', async () => switchModel('openclaw', 'ocModelSelect', 'ocModelSwitchMsg', 'ocModelApplyBtn'));
  if (hModelApplyBtn) hModelApplyBtn.addEventListener('click', async () => switchModel('hermes', 'hModelSelect', 'hModelSwitchMsg', 'hModelApplyBtn'));
  if (ocSkillToggleBtn) {
    ocSkillToggleBtn.addEventListener('click', () => {
      ocSkillListCollapsed = !ocSkillListCollapsed;
      const ocList = $('ocSkillList');
      if (ocList) ocList.classList.toggle('collapsed', ocSkillListCollapsed);
      ocSkillToggleBtn.textContent = ocSkillListCollapsed ? '展开' : '收起';
    });
  }

  initViewRouter();

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
