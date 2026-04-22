// =============================================================
// Agent Observatory — Frontend Application (v3 — Agentic)
// =============================================================

const API = {
  sessions: () => '/sessions',
  traces:   (id) => `/sessions/${encodeURIComponent(id)}/traces`,
  delete:   (id) => `/sessions/${encodeURIComponent(id)}`,
};

const state = {
  sessions: [],
  selectedSessionId: null,
  traces: [],
  selectedTrace: null,
  view: 'tree',
};

let treeZoomBehavior  = null;
let treeZoomTransform = null;

// =============================================================
// Agent icon system
// Named agent icons use Unicode symbols; funny animal names get emoji.
// =============================================================

const NAMED_ICONS = [
  [['architecture', 'arch'],              '⬡'],
  [['senior-engineer', 'senior engineer'],'⌬'],
  [['engineer'],                          '⌬'],
  [['team-lead', 'team lead'],            '◉'],
  [['lead'],                              '◉'],
  [['adr-writer', 'adr'],                 '◧'],
  [['writer'],                            '✎'],
  [['cross-team', 'scanner'],             '⊕'],
  [['plan'],                              '◫'],
  [['explore'],                           '◌'],
  [['general-purpose', 'general'],        '◆'],
  [['reviewer', 'review'],                '◎'],
  [['claude-code', 'claude'],             '◈'],
  [['root', 'session'],                   '◉'],
];

const ANIMAL_ICONS = {
  raccoon: '🦝', penguin: '🐧', narwhal: '🐳', capybara: '🦫',
  platypus: '🦆', axolotl: '🐟', quokka: '🦘', pangolin: '🦎',
  meerkat: '🐿', blobfish: '🐡', tardigrade: '🦠', wombat: '🦡',
  ocelot: '🐆', tapir: '🐘', manatee: '🐋', numbat: '🦊',
  kinkajou: '🦝', binturong: '🐻', fossa: '🐱', saiga: '🐐',
};

function getAgentIcon(agentType) {
  if (!agentType) return '◆';
  const t = agentType.toLowerCase();

  // Check named agent patterns
  for (const [keywords, icon] of NAMED_ICONS) {
    if (keywords.some(k => t.includes(k))) return icon;
  }

  // Check animal names (for funny generated names)
  for (const [animal, emoji] of Object.entries(ANIMAL_ICONS)) {
    if (t.includes(animal)) return emoji;
  }

  return '◆';
}

// =============================================================
// Utilities
// =============================================================

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60)    return `${Math.round(diff)}s ago`;
  if (diff < 3600)  return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function wordCount(str) {
  return str ? str.trim().split(/\s+/).filter(Boolean).length : 0;
}

function truncate(str, len = 60) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function agentLabel(type) {
  if (!type) return 'unknown';
  return type.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function traceDepth(trace, byId) {
  let depth = 0, current = trace;
  while (current.parent_id && byId[current.parent_id]) {
    depth++;
    current = byId[current.parent_id];
  }
  return depth;
}

// =============================================================
// API
// =============================================================

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// =============================================================
// SSE
// =============================================================

function connectSSE() {
  const indicator = document.getElementById('live-indicator');
  const label     = indicator.querySelector('.live-label');

  const connect = () => {
    const source = new EventSource('/stream');

    source.addEventListener('message', e => {
      try { handleSSEEvent(JSON.parse(e.data)); } catch {}
    });

    source.addEventListener('open', () => {
      indicator.className = 'live-indicator connected';
      label.textContent = 'Live';
    });

    source.addEventListener('error', () => {
      indicator.className = 'live-indicator error';
      label.textContent = 'Disconnected';
      source.close();
      setTimeout(connect, 5000);
    });
  };

  connect();
}

function handleSSEEvent(data) {
  switch (data.type) {
    case 'trace_started': {
      const exists = state.sessions.find(s => s.id === data.session_id);
      if (!exists) {
        loadSessions();
      } else {
        exists.trace_count   = (exists.trace_count   || 0) + 1;
        exists.running_count = (exists.running_count || 0) + 1;
        exists.last_seen     = Date.now() / 1000;
        renderSessionList();
      }

      if (data.session_id === state.selectedSessionId) {
        state.traces.push({
          id: data.trace_id, session_id: data.session_id,
          parent_id: data.parent_id || null,
          agent_type: data.agent_type || 'unknown',
          description: data.description || '',
          prompt: '', response: null,
          status: 'running',
          started_at: data.started_at || Date.now() / 1000,
          completed_at: null, duration_ms: null,
        });
        renderView();
        updateStatsBar();
      }
      break;
    }

    case 'trace_completed': {
      if (data.session_id === state.selectedSessionId) {
        const trace = state.traces.find(t => t.id === data.trace_id);
        if (trace) {
          trace.status       = 'completed';
          trace.duration_ms  = data.duration_ms;
          trace.completed_at = data.completed_at || Date.now() / 1000;
        }
        renderView();
        updateStatsBar();
        if (state.selectedTrace?.id === data.trace_id) {
          const fresh = state.traces.find(t => t.id === data.trace_id);
          if (fresh) renderDetail(fresh);
        }
      }

      const sess = state.sessions.find(s => s.id === data.session_id);
      if (sess) {
        sess.running_count = Math.max(0, (sess.running_count || 1) - 1);
        sess.last_seen = Date.now() / 1000;
        renderSessionList();
      }
      break;
    }
  }
}

// =============================================================
// Sessions
// =============================================================

async function loadSessions() {
  try {
    state.sessions = await apiFetch(API.sessions());
    renderSessionList();
  } catch {}
}

function renderSessionList() {
  const list    = document.getElementById('session-list');
  const empty   = document.getElementById('sessions-empty');
  const counter = document.getElementById('session-count');

  counter.textContent = state.sessions.length;
  empty.style.display = state.sessions.length ? 'none' : '';

  const existing = new Map(
    [...list.querySelectorAll('.session-item')].map(el => [el.dataset.id, el])
  );
  existing.forEach((el, id) => { if (!state.sessions.find(s => s.id === id)) el.remove(); });

  state.sessions.forEach(sess => {
    let el = existing.get(sess.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'session-item';
      el.dataset.id = sess.id;
      el.innerHTML = `
        <div class="session-item-top">
          <span class="session-item-id"></span>
          <span class="session-health"></span>
        </div>
        <div class="session-item-meta">
          <span class="session-item-count"></span>
          <span class="session-item-time"></span>
        </div>
      `;
      el.addEventListener('click', () => selectSession(sess.id));
      list.appendChild(el);
    }

    el.querySelector('.session-item-id').textContent  = truncate(sess.id, 20);
    el.querySelector('.session-item-count').textContent =
      `${sess.trace_count} agent${sess.trace_count !== 1 ? 's' : ''}` +
      (sess.failed_count ? `  ·  ${sess.failed_count} ⚠` : '');
    el.querySelector('.session-item-time').textContent = formatRelativeTime(sess.last_seen);

    const health = el.querySelector('.session-health');
    health.innerHTML = '';
    ['running', 'interrupted'].forEach(type => {
      const count = type === 'running' ? sess.running_count : sess.failed_count;
      if (count > 0) {
        const d = document.createElement('span');
        d.className = `health-dot ${type}`;
        d.title = `${count} ${type}`;
        health.appendChild(d);
      }
    });

    el.classList.toggle('active', sess.id === state.selectedSessionId);
  });
}

async function selectSession(id) {
  state.selectedSessionId = id;
  state.selectedTrace = null;
  treeZoomTransform = null;

  document.querySelectorAll('.session-item')
    .forEach(el => el.classList.toggle('active', el.dataset.id === id));

  document.getElementById('header-session-id').textContent = truncate(id, 18);
  document.getElementById('btn-clear-session').hidden = false;

  try { state.traces = await apiFetch(API.traces(id)); } catch { state.traces = []; }

  renderView();
  updateStatsBar();
  renderDetail(null);
}

async function deleteSelectedSession() {
  if (!state.selectedSessionId || !confirm('Delete this session and all its traces?')) return;
  try { await apiFetch(API.delete(state.selectedSessionId), { method: 'DELETE' }); } catch {}

  state.sessions = state.sessions.filter(s => s.id !== state.selectedSessionId);
  state.selectedSessionId = null;
  state.traces = [];
  state.selectedTrace = null;
  treeZoomTransform = null;

  document.getElementById('btn-clear-session').hidden = true;
  document.getElementById('header-session-id').textContent = '';
  renderSessionList();
  renderView();
  renderDetail(null);
  updateStatsBar();
}

// =============================================================
// Stats bar
// =============================================================

function updateStatsBar() {
  const total     = state.traces.length;
  const running   = state.traces.filter(t => t.status === 'running').length;
  const completed = state.traces.filter(t => t.status === 'completed').length;
  const failed    = state.traces.filter(t => t.status === 'interrupted').length;

  const starts = state.traces.map(t => t.started_at).filter(Boolean);
  const ends   = state.traces.map(t => t.completed_at).filter(Boolean);
  const wallMs = (starts.length && ends.length)
    ? (Math.max(...ends) - Math.min(...starts)) * 1000 : null;

  document.getElementById('stat-total').textContent    = total     || '—';
  document.getElementById('stat-running').textContent  = running   || '—';
  document.getElementById('stat-completed').textContent= completed || '—';
  document.getElementById('stat-failed').textContent   = failed    || '—';
  document.getElementById('stat-walltime').textContent = wallMs != null ? formatDuration(wallMs) : '—';
}

// =============================================================
// View switching
// =============================================================

function switchView(view) {
  state.view = view;
  document.getElementById('tree-view').classList.toggle('hidden', view !== 'tree');
  document.getElementById('timeline-view').classList.toggle('hidden', view !== 'timeline');
  document.querySelectorAll('.view-tab')
    .forEach(t => t.classList.toggle('active', t.dataset.view === view));
  renderView();
}

function renderView() {
  if (state.view === 'tree') renderTree();
  else renderTimeline();
}

// =============================================================
// D3 — Call Tree (card nodes with icon boxes + SVG glow)
// =============================================================

const CARD_W   = 196;
const CARD_H   = 62;
const ICON_BOX = 46;   // width of the icon area inside each card
const NODE_W   = 256;  // horizontal spacing between depth levels
const NODE_H   = 86;   // vertical spacing between siblings

function buildHierarchy(traces) {
  if (!traces.length) return null;
  const map = {};
  traces.forEach(t => { map[t.id] = { ...t, children: [] }; });
  const roots = [];
  traces.forEach(t => {
    if (t.parent_id && map[t.parent_id]) map[t.parent_id].children.push(map[t.id]);
    else roots.push(map[t.id]);
  });
  if (roots.length === 1) return roots[0];
  return { id: '__root__', agent_type: 'Session', status: 'root', description: '', prompt: '', response: null, children: roots };
}

// SVG glow filter IDs by status
const GLOW_FILTER = {
  running:     'glow-amber',
  completed:   'glow-green',
  interrupted: 'glow-purple',
  root:        'glow-cyan',
};

function addGlowFilters(svg) {
  const defs = svg.append('defs');

  const glows = [
    { id: 'glow-amber',  color: '#ffb800' },
    { id: 'glow-green',  color: '#00ff88' },
    { id: 'glow-purple', color: '#bf5af2' },
    { id: 'glow-cyan',   color: '#00d4ff' },
  ];

  glows.forEach(({ id, color }) => {
    const f = defs.append('filter')
      .attr('id', id)
      .attr('x', '-40%').attr('y', '-40%')
      .attr('width', '180%').attr('height', '180%');

    f.append('feDropShadow')
      .attr('dx', 0).attr('dy', 0)
      .attr('stdDeviation', 4)
      .attr('flood-color', color)
      .attr('flood-opacity', 0.55);
  });
}

function renderTree() {
  const container = document.getElementById('tree-view');
  const empty     = document.getElementById('tree-empty');
  container.querySelectorAll('svg').forEach(el => el.remove());

  if (!state.selectedSessionId || !state.traces.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const rootData = buildHierarchy(state.traces);
  if (!rootData) return;

  const hierarchy = d3.hierarchy(rootData);
  d3.tree().nodeSize([NODE_H, NODE_W])(hierarchy);

  let minX = Infinity, maxX = -Infinity;
  hierarchy.each(d => { if (d.x < minX) minX = d.x; if (d.x > maxX) maxX = d.x; });

  const { width: vW, height: vH } = container.getBoundingClientRect();
  const svgW = Math.max(vW, (hierarchy.height + 1) * NODE_W + CARD_W + 80);
  const svgH = Math.max(vH, maxX - minX + NODE_H * 2);

  const svg = d3.select(container).append('svg')
    .attr('class', 'tree-svg')
    .attr('width', svgW)
    .attr('height', svgH);

  addGlowFilters(svg);

  const g = svg.append('g');

  // Zoom
  treeZoomBehavior = d3.zoom().scaleExtent([0.1, 2.5]).on('zoom', e => {
    treeZoomTransform = e.transform;
    g.attr('transform', e.transform);
  });
  svg.call(treeZoomBehavior);
  const initT = treeZoomTransform ||
    d3.zoomIdentity.translate(CARD_W / 2 + 24, vH / 2 - (minX + maxX) / 2);
  svg.call(treeZoomBehavior.transform, initT);

  // Links — bezier between card edges
  g.selectAll('.link')
    .data(hierarchy.links())
    .join('path')
    .attr('class', 'link')
    .attr('d', d => {
      const sx = d.source.y + CARD_W / 2;
      const sy = d.source.x;
      const tx = d.target.y - CARD_W / 2;
      const ty = d.target.x;
      const mx = (sx + tx) / 2;
      return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
    });

  const tooltip = document.getElementById('node-tooltip');

  // Nodes
  const node = g.selectAll('.node')
    .data(hierarchy.descendants())
    .join('g')
    .attr('class', d => `node node-${d.data.status}${state.selectedTrace?.id === d.data.id ? ' selected' : ''}`)
    .attr('transform', d => `translate(${d.y},${d.x})`)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.data.id === '__root__') return;
      const trace = state.traces.find(t => t.id === d.data.id) || d.data;
      selectTrace(trace);
    })
    .on('mouseover', (event, d) => {
      if (!d.data.prompt && !d.data.description) return;
      tooltip.classList.remove('hidden');
      tooltip.innerHTML = `
        <div class="tooltip-agent">${getAgentIcon(d.data.agent_type)} ${agentLabel(d.data.agent_type)}</div>
        <div class="tooltip-prompt">${truncate(d.data.prompt || d.data.description, 220)}</div>
      `;
    })
    .on('mousemove', event => {
      tooltip.style.left = `${event.clientX + 14}px`;
      tooltip.style.top  = `${event.clientY - 10}px`;
    })
    .on('mouseout', () => tooltip.classList.add('hidden'));

  // Card background (with glow on non-unknown nodes)
  node.append('rect')
    .attr('class', 'node-card-bg')
    .attr('x', -CARD_W / 2)
    .attr('y', -CARD_H / 2)
    .attr('width', CARD_W)
    .attr('height', CARD_H)
    .attr('rx', 4)
    .attr('filter', d => GLOW_FILTER[d.data.status] ? `url(#${GLOW_FILTER[d.data.status]})` : null);

  // Left status stripe
  node.append('rect')
    .attr('class', d => `node-status-bar bar-${d.data.status}`)
    .attr('x', -CARD_W / 2)
    .attr('y', -CARD_H / 2 + 4)
    .attr('width', 3)
    .attr('height', CARD_H - 8)
    .attr('rx', 1.5);

  // Icon box background
  node.append('rect')
    .attr('class', d => `node-icon-bg icon-bg-${d.data.status}`)
    .attr('x', -CARD_W / 2 + 4)
    .attr('y', -CARD_H / 2 + 1)
    .attr('width', ICON_BOX - 2)
    .attr('height', CARD_H - 2)
    .attr('rx', 3);

  // Icon (emoji or unicode symbol)
  node.append('text')
    .attr('class', 'node-icon')
    .attr('x', -CARD_W / 2 + 4 + (ICON_BOX - 2) / 2)
    .attr('y', 1)
    .text(d => getAgentIcon(d.data.agent_type));

  // Content area
  const cx = -CARD_W / 2 + ICON_BOX + 10;

  node.append('text')
    .attr('class', 'node-label')
    .attr('x', cx).attr('y', -14)
    .text(d => truncate(agentLabel(d.data.agent_type), 18));

  node.append('text')
    .attr('class', 'node-desc')
    .attr('x', cx).attr('y', 0)
    .text(d => truncate(d.data.description, 22));

  node.append('text')
    .attr('class', d => `node-meta meta-${d.data.status}`)
    .attr('x', cx).attr('y', 14)
    .text(d => {
      if (d.data.status === 'running')     return '⟳ running';
      if (d.data.status === 'interrupted') return '⚠ interrupted';
      if (d.data.status === 'root')        return '';
      return formatDuration(d.data.duration_ms) || '';
    });

  // Click background to deselect
  svg.on('click', () => {
    state.selectedTrace = null;
    renderDetail(null);
    node.attr('class', d => `node node-${d.data.status}`);
  });
}

// =============================================================
// D3 — Timeline (Gantt with depth indentation)
// =============================================================

function renderTimeline() {
  const container = document.getElementById('timeline-view');
  const empty     = document.getElementById('timeline-empty');
  container.querySelectorAll('svg').forEach(el => el.remove());

  if (!state.selectedSessionId || !state.traces.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const traces = [...state.traces].sort((a, b) => a.started_at - b.started_at);
  const byId   = {};
  traces.forEach(t => { byId[t.id] = t; });

  const margin = { top: 24, right: 32, bottom: 40, left: 182 };
  const rowH   = 38;
  const { width: vW } = container.getBoundingClientRect();
  const innerW = Math.max(vW - margin.left - margin.right, 200);
  const innerH = traces.length * rowH;
  const svgH   = innerH + margin.top + margin.bottom;
  const now    = Date.now() / 1000;

  const sessStart = d3.min(traces, t => t.started_at);
  const sessEnd   = d3.max(traces, t => t.completed_at || now);
  const xScale    = d3.scaleTime()
    .domain([new Date(sessStart * 1000), new Date(sessEnd * 1000)])
    .range([0, innerW]);

  const svg = d3.select(container).append('svg')
    .attr('class', 'timeline-svg').attr('width', vW).attr('height', svgH);

  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Grid
  g.append('g').attr('class', 'grid')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).ticks(7).tickSize(-innerH).tickFormat(''))
    .select('.domain').remove();

  // X axis
  const timeFmt = d3.timeFormat('%H:%M:%S');
  g.append('g').attr('class', 'x-axis')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).ticks(7).tickFormat(timeFmt));

  // "Now" line if any running
  if (traces.some(t => t.status === 'running')) {
    const nx = xScale(new Date(now * 1000));
    g.append('line').attr('class', 'tl-now-line')
      .attr('x1', nx).attr('x2', nx).attr('y1', 0).attr('y2', innerH);
    g.append('text').attr('class', 'tl-now-label')
      .attr('x', nx + 4).attr('y', -8).text('NOW');
  }

  // Rows
  traces.forEach((trace, i) => {
    const y     = i * rowH;
    const yMid  = y + rowH / 2;
    const depth = traceDepth(trace, byId);
    const indent = depth * 10;
    const isSelected = state.selectedTrace?.id === trace.id;

    // Icon + label
    g.append('text')
      .attr('class', 'tl-label')
      .attr('x', -10 - indent)
      .attr('y', yMid).attr('dy', '0.35em')
      .attr('text-anchor', 'end')
      .text(`${getAgentIcon(trace.agent_type)} ${truncate(agentLabel(trace.agent_type), 16)}`);

    const barX  = xScale(new Date(trace.started_at * 1000)) + indent;
    const barW  = Math.max(4, xScale(new Date((trace.completed_at || now) * 1000)) - xScale(new Date(trace.started_at * 1000)) - indent);

    g.append('rect')
      .attr('class', `tl-bar tl-bar-${trace.status}${isSelected ? ' selected' : ''}`)
      .attr('x', barX).attr('y', y + 7)
      .attr('width', barW).attr('height', rowH - 14).attr('rx', 3)
      .on('click', () => selectTrace(trace));

    if (trace.duration_ms && barW > 42) {
      g.append('text')
        .attr('class', 'tl-bar-label')
        .attr('x', barX + barW / 2).attr('y', yMid).attr('dy', '0.35em')
        .attr('text-anchor', 'middle')
        .text(formatDuration(trace.duration_ms));
    }
  });
}

// =============================================================
// Trace selection & detail panel
// =============================================================

function selectTrace(trace) {
  const live = state.traces.find(t => t.id === trace.id);
  if (live && !live.prompt && live.status !== 'running') {
    apiFetch(API.traces(state.selectedSessionId)).then(traces => {
      state.traces = traces;
      const fresh = traces.find(t => t.id === trace.id);
      _applySelection(fresh || trace);
    }).catch(() => _applySelection(trace));
    return;
  }
  _applySelection(live || trace);
}

function _applySelection(trace) {
  state.selectedTrace = trace;
  renderDetail(trace);
  d3.selectAll('.node').attr('class', d =>
    `node node-${d.data.status}${d.data.id === trace?.id ? ' selected' : ''}`
  );
}

function renderDetail(trace) {
  const empty   = document.getElementById('detail-empty');
  const content = document.getElementById('detail-content');

  if (!trace || trace.id === '__root__') {
    empty.style.display = '';
    content.classList.add('hidden');
    return;
  }

  empty.style.display = 'none';
  content.classList.remove('hidden');

  // Status stripe + icon box
  document.getElementById('detail-status-stripe').className = `detail-status-stripe stripe-${trace.status}`;
  document.getElementById('detail-icon-box').className = `detail-agent-icon-box icon-box-${trace.status}`;
  document.getElementById('detail-agent-icon').textContent = getAgentIcon(trace.agent_type);

  // Hero
  document.getElementById('detail-agent-type').textContent  = agentLabel(trace.agent_type);
  document.getElementById('detail-description-hero').textContent = trace.description || '—';

  const statusBadge = document.getElementById('detail-status-badge');
  statusBadge.textContent = trace.status;
  statusBadge.className   = `badge badge-${trace.status}`;

  const durBadge = document.getElementById('detail-duration-badge');
  const durText  = formatDuration(trace.duration_ms) || (trace.status === 'running' ? 'running…' : '');
  durBadge.textContent   = durText;
  durBadge.style.display = durText ? '' : 'none';

  // Timing
  document.getElementById('detail-started').textContent     = formatTime(trace.started_at);
  document.getElementById('detail-completed').textContent   = formatTime(trace.completed_at);
  document.getElementById('detail-duration-val').textContent= formatDuration(trace.duration_ms) || '—';

  // Hierarchy
  const byId = {};
  state.traces.forEach(t => { byId[t.id] = t; });

  const parent = trace.parent_id ? byId[trace.parent_id] : null;
  document.getElementById('detail-parent').textContent =
    parent ? `${getAgentIcon(parent.agent_type)} ${agentLabel(parent.agent_type)}` : 'root';
  document.getElementById('detail-depth').textContent = traceDepth(trace, byId);

  // Children
  const children  = state.traces.filter(t => t.parent_id === trace.id);
  const childList = document.getElementById('detail-children');
  childList.innerHTML = '';
  children.forEach(child => {
    const chip = document.createElement('div');
    chip.className = 'child-chip';
    chip.innerHTML = `
      <span class="child-chip-icon">${getAgentIcon(child.agent_type)}</span>
      <span class="child-chip-name">${agentLabel(child.agent_type)}</span>
      <span class="child-chip-dur">${formatDuration(child.duration_ms) || ''}</span>
    `;
    chip.addEventListener('click', () => selectTrace(child));
    childList.appendChild(chip);
  });

  // Prompt
  document.getElementById('detail-prompt').textContent = trace.prompt || '(not captured)';
  document.getElementById('prompt-wc').textContent = trace.prompt ? `${wordCount(trace.prompt)} words` : '';

  // Response
  const responseEl   = document.getElementById('detail-response');
  const cardResponse = document.getElementById('card-response');
  if (trace.response) {
    responseEl.textContent = trace.response;
    document.getElementById('response-wc').textContent = `${wordCount(trace.response)} words`;
    cardResponse.style.display = '';
  } else if (trace.status === 'running') {
    responseEl.textContent = '⟳ agent still running…';
    document.getElementById('response-wc').textContent = '';
    cardResponse.style.display = '';
  } else {
    cardResponse.style.display = 'none';
  }
}

// =============================================================
// Collapsible sections + copy buttons
// =============================================================

function setupUI() {
  document.addEventListener('click', e => {
    const hdr = e.target.closest('.detail-card-title.clickable');
    if (hdr) hdr.closest('.detail-card.expandable')?.classList.toggle('collapsed');

    const btn = e.target.closest('.btn-copy');
    if (btn) {
      const el = document.getElementById(btn.dataset.target);
      if (!el) return;
      navigator.clipboard.writeText(el.textContent).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {});
    }
  });
}

// =============================================================
// Init
// =============================================================

async function init() {
  document.querySelectorAll('.view-tab')
    .forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  document.getElementById('btn-clear-session')
    .addEventListener('click', deleteSelectedSession);

  setupUI();
  connectSSE();
  await loadSessions();
  setInterval(loadSessions, 30_000);
}

document.addEventListener('DOMContentLoaded', init);
