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
  [['architecture', 'arch'],              '🏗️'],
  [['senior-engineer', 'senior engineer'],'🧑‍💻'],
  [['engineer'],                          '🔧'],
  [['team-lead', 'team lead'],            '👑'],
  [['lead'],                              '👑'],
  [['adr-writer', 'adr'],                 '📋'],
  [['writer'],                            '✏️'],
  [['cross-team', 'scanner'],             '🔭'],
  [['plan'],                              '🗺️'],
  [['explore'],                           '🧭'],
  [['general-purpose', 'general'],        '🤖'],
  [['reviewer', 'review'],                '🔍'],
  [['claude-code', 'claude'],             '🤖'],
  [['root', 'session'],                   '🖥️'],
];

const ANIMAL_ICONS = {
  raccoon: '🦝', penguin: '🐧', narwhal: '🐳', capybara: '🦫',
  platypus: '🦆', axolotl: '🐟', quokka: '🦘', pangolin: '🦎',
  meerkat: '🐿', blobfish: '🐡', tardigrade: '🦠', wombat: '🦡',
  ocelot: '🐆', tapir: '🐘', manatee: '🐋', numbat: '🦊',
  kinkajou: '🦝', binturong: '🐻', fossa: '🐱', saiga: '🐐',
};

function getAgentIcon(agentType) {
  if (!agentType) return '🤖';
  const t = agentType.toLowerCase();

  // Check named agent patterns
  for (const [keywords, icon] of NAMED_ICONS) {
    if (keywords.some(k => t.includes(k))) return icon;
  }

  // Check animal names (for funny generated names)
  for (const [animal, emoji] of Object.entries(ANIMAL_ICONS)) {
    if (t.includes(animal)) return emoji;
  }

  return '🤖';
}

// Tool-type icons and colors for activity nodes
const TOOL_ICONS = {
  Bash: '⚡', Read: '📖', Write: '📝', Edit: '✏️',
  Grep: '🔍', Glob: '🗂️', WebFetch: '🌐', WebSearch: '🔎',
  TodoWrite: '✅', TodoRead: '📋', NotebookEdit: '📓',
  Agent: '🤖',
};
const TOOL_COLORS = {
  Bash: '#ffb800', Read: '#00d4ff', Write: '#00ff88', Edit: '#00ff88',
  Grep: '#bf5af2', Glob: '#bf5af2', WebFetch: '#ff6b6b', WebSearch: '#ff6b6b',
  TodoWrite: '#00d4ff', TodoRead: '#00d4ff', NotebookEdit: '#ffb800',
};
function getToolIcon(toolName)  { return TOOL_ICONS[toolName]  || '🔩'; }
function getToolColor(toolName) { return TOOL_COLORS[toolName] || '#4a5568'; }

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

function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatCost(usd) {
  if (usd == null) return '—';
  if (usd < 0.000001) return '<$0.000001';
  if (usd < 0.01)     return `$${usd.toFixed(6)}`;
  if (usd < 1)        return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
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
      try { handleSSEEvent(JSON.parse(e.data)); } catch (err) { console.warn('[Observatory] SSE parse error:', err); }
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
          kind: data.kind || 'agent',
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
          trace.status        = 'completed';
          trace.duration_ms   = data.duration_ms;
          trace.completed_at  = data.completed_at || Date.now() / 1000;
          trace.input_tokens  = data.input_tokens;
          trace.output_tokens = data.output_tokens;
          trace.cost_usd      = data.cost_usd;
        }
        renderView();
        updateStatsBar();
        if (state.selectedTrace?.id === data.trace_id) {
          const fresh = state.traces.find(t => t.id === data.trace_id);
          if (fresh) renderDetail(fresh);
        }

        // Live-update the Logs tab entry
        if (state.view === 'logs') {
          const logContainer = document.getElementById('log-entries');
          if (logContainer) {
            const byId = {};
            state.traces.forEach(t => { byId[t.id] = t; });
            const updated = state.traces.find(t => t.id === data.trace_id);
            if (updated) {
              const existing = logContainer.querySelector(`[data-id="${data.trace_id}"]`);
              if (existing) existing.remove();
              appendLogEntry(logContainer, updated, byId);
              scrollLogsIfEnabled();
            }
          }
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

    case 'session_created': {
      const exists = state.sessions.find(s => s.id === data.session_id);
      if (!exists) {
        loadSessions();
      }
      break;
    }

    case 'board_message': {
      const { board_id, message } = data;

      if (!chatState.messages[board_id]) chatState.messages[board_id] = [];
      chatState.messages[board_id].push(message);

      const b = chatState.boards.find(x => x.board_id === board_id);
      if (b) { b.message_count++; b.last_activity = message.timestamp; }
      else    { chatState.boards.unshift({ board_id, message_count: 1, last_activity: message.timestamp }); }

      if (state.view === 'chat') {
        renderBoardList();
        if (chatState.selectedBoardId === board_id) {
          const thread = document.getElementById('chat-thread');
          const msgs   = chatState.messages[board_id];
          document.getElementById('chat-empty').style.display = 'none';
          document.getElementById('chat-thread-header').hidden = false;
          document.getElementById('chat-board-id').textContent  = board_id;
          document.getElementById('chat-msg-count').textContent = `${msgs.length} messages`;
          appendChatBubble(thread, message, msgs);
          thread.scrollTop = thread.scrollHeight;
        }
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
  } catch (err) { console.warn('[Observatory] Failed to load sessions:', err); }
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
  try { await apiFetch(API.delete(state.selectedSessionId), { method: 'DELETE' }); } catch (err) { console.warn('[Observatory] Delete session failed:', err); }

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

  const totalTokens = state.traces.reduce((s, t) => s + (t.input_tokens || 0) + (t.output_tokens || 0), 0);
  const totalCost   = state.traces.reduce((s, t) => s + (t.cost_usd || 0), 0);

  document.getElementById('stat-total').textContent    = total     || '—';
  document.getElementById('stat-running').textContent  = running   || '—';
  document.getElementById('stat-completed').textContent= completed || '—';
  document.getElementById('stat-failed').textContent   = failed    || '—';
  document.getElementById('stat-walltime').textContent = wallMs != null ? formatDuration(wallMs) : '—';
  document.getElementById('stat-tokens').textContent   = totalTokens ? formatTokens(totalTokens) : '—';
  document.getElementById('stat-cost').textContent     = totalCost   ? formatCost(totalCost)     : '—';
}

// =============================================================
// View switching
// =============================================================

// =============================================================
// Chat / Board
// =============================================================

const CHAT_COLORS = ['#00d4ff','#00ff88','#ffb800','#bf5af2','#ff6b6b','#ffd93d','#06d6a0','#f77f00'];

function agentColor(name) {
  let h = 0;
  for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}

const chatState = {
  boards:         [],        // [{board_id, message_count, last_activity}]
  selectedBoardId: null,
  messages:       {},        // board_id -> [msg]
};

async function loadBoards() {
  try {
    chatState.boards = await apiFetch('/boards');
    renderBoardList();
  } catch (err) { console.warn('[Observatory] Failed to load boards:', err); }
}

function renderBoardList() {
  const list  = document.getElementById('board-list');
  const empty = document.getElementById('boards-empty');

  if (!chatState.boards.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';

  const existing = new Map([...list.querySelectorAll('.board-item')].map(el => [el.dataset.id, el]));
  existing.forEach((el, id) => { if (!chatState.boards.find(b => b.board_id === id)) el.remove(); });

  chatState.boards.forEach(board => {
    let el = existing.get(board.board_id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'board-item';
      el.dataset.id = board.board_id;
      el.innerHTML = `
        <div class="board-item-id"></div>
        <div class="board-item-meta">
          <span class="board-msg-count"></span>
          <span class="board-time"></span>
        </div>
      `;
      el.addEventListener('click', () => selectBoard(board.board_id));
      list.appendChild(el);
    }
    el.querySelector('.board-item-id').textContent     = truncate(board.board_id, 20);
    el.querySelector('.board-msg-count').textContent   = `${board.message_count} msg`;
    el.querySelector('.board-time').textContent        = formatRelativeTime(board.last_activity);
    el.classList.toggle('active', board.board_id === chatState.selectedBoardId);
  });
}

async function selectBoard(boardId) {
  chatState.selectedBoardId = boardId;
  if (!chatState.messages[boardId]) {
    try { chatState.messages[boardId] = await apiFetch(`/board/${boardId}`); } catch { chatState.messages[boardId] = []; }
  }
  renderBoardList();
  renderChatThread();
}

function renderChatThread() {
  const thread  = document.getElementById('chat-thread');
  const empty   = document.getElementById('chat-empty');
  const header  = document.getElementById('chat-thread-header');
  const boardId = chatState.selectedBoardId;

  if (!boardId) { empty.style.display = ''; header.hidden = true; return; }

  const messages = chatState.messages[boardId] || [];
  empty.style.display = 'none';
  header.hidden = false;
  document.getElementById('chat-board-id').textContent  = boardId;
  document.getElementById('chat-msg-count').textContent = `${messages.length} messages`;

  thread.innerHTML = '';
  messages.forEach(msg => appendChatBubble(thread, msg, messages));
  thread.scrollTop = thread.scrollHeight;
}

function appendChatBubble(container, msg, allMessages) {
  const isPass = /^pass/i.test(msg.content.trim());
  const color  = agentColor(msg.agent_name);
  const icon   = getAgentIcon(msg.agent_name);
  const parent = msg.reply_to ? allMessages.find(m => m.id === msg.reply_to) : null;

  const el = document.createElement('div');
  el.className = `chat-message${isPass ? ' pass-message' : ''}`;
  el.dataset.msgId = msg.id;

  const replyHtml = parent ? `
    <div class="chat-reply-preview">↳ ${escHtml(truncate(parent.content, 70))}</div>
  ` : '';

  el.innerHTML = `
    <div class="chat-message-meta">
      <span class="chat-agent-name" style="color:${color}">${icon} ${escHtml(msg.agent_name)}</span>
      <span class="chat-agent-time">${formatTime(msg.timestamp)}</span>
    </div>
    ${replyHtml}
    <div class="chat-bubble" style="border-left: 3px solid ${color}">${escHtml(msg.content)}</div>
  `;

  container.appendChild(el);
}

function renderChat() {
  loadBoards();
}

function switchView(view) {
  state.view = view;
  ['tree', 'timeline', 'flow', 'logs', 'chat'].forEach(v => {
    document.getElementById(`${v}-view`).classList.toggle('hidden', view !== v);
  });
  document.querySelectorAll('.view-tab')
    .forEach(t => t.classList.toggle('active', t.dataset.view === view));
  renderView();
}

function renderView() {
  if      (state.view === 'tree')     renderTree();
  else if (state.view === 'timeline') renderTimeline();
  else if (state.view === 'flow')     renderFlow();
  else if (state.view === 'logs')     renderLogs();
  else if (state.view === 'chat')     renderChat();
}

// =============================================================
// Flow graph — interconnections between agents
// =============================================================

// Group traces into "waves": agents that started within WAVE_GAP seconds of each other.
const WAVE_GAP = 8;

function computeWaves(traces) {
  const sorted = [...traces].sort((a, b) => a.started_at - b.started_at);
  const waves  = [];

  sorted.forEach(trace => {
    for (const wave of waves) {
      if (Math.abs(trace.started_at - wave[0].started_at) <= WAVE_GAP) {
        wave.push(trace);
        return;
      }
    }
    waves.push([trace]);
  });

  return waves;
}

function renderFlow() {
  const container = document.getElementById('flow-view');
  const empty     = document.getElementById('flow-empty');
  container.querySelectorAll('svg, .flow-legend').forEach(el => el.remove());

  if (!state.selectedSessionId || !state.traces.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const waves = computeWaves(state.traces);

  // --- Layout constants ---
  const CARD_W  = 170;
  const CARD_H  = 52;
  const COL_GAP = 100;   // horizontal space between wave columns
  const ROW_GAP = 72;    // vertical space between nodes in a wave

  // Compute (x, y) for every trace
  const pos = {};
  const colX = [];

  let xCursor = CARD_W / 2 + 32;
  waves.forEach((wave, wi) => {
    colX[wi] = xCursor;
    const totalH = (wave.length - 1) * ROW_GAP;
    wave.forEach((trace, ti) => {
      pos[trace.id] = {
        x: xCursor,
        y: -totalH / 2 + ti * ROW_GAP,
        wave: wi,
      };
    });
    xCursor += CARD_W + COL_GAP;
  });

  const { width: vW, height: vH } = container.getBoundingClientRect();
  const contentW = xCursor + 20;
  const allYs    = Object.values(pos).map(p => p.y);
  const minY     = Math.min(...allYs) - CARD_H;
  const maxY     = Math.max(...allYs) + CARD_H;
  const contentH = maxY - minY + 40;

  const svg = d3.select(container).append('svg')
    .attr('class', 'flow-svg')
    .attr('width',  Math.max(vW, contentW))
    .attr('height', Math.max(vH, contentH));

  addGlowFilters(svg);

  // Arrow marker defs
  const defs = svg.select('defs');

  ['spawn', 'context'].forEach(type => {
    const color = type === 'spawn' ? '#00d4ff' : '#ffb800';
    defs.append('marker')
      .attr('id', `arrow-${type}`)
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', color)
      .attr('opacity', type === 'spawn' ? 0.7 : 0.5);
  });

  const g = svg.append('g')
    .attr('transform', `translate(0,${vH / 2 - (minY + maxY) / 2})`);

  // Zoom
  const zoom = d3.zoom().scaleExtent([0.2, 2]).on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom);
  svg.call(zoom.transform, d3.zoomIdentity.translate(0, vH / 2 - (minY + maxY) / 2));

  // --- Wave column labels + separator lines ---
  waves.forEach((wave, wi) => {
    const x = colX[wi];
    g.append('text')
      .attr('class', 'flow-wave-label')
      .attr('x', x)
      .attr('y', minY - 10)
      .text(`wave ${wi + 1}`);

    if (wi > 0) {
      const sepX = colX[wi] - CARD_W / 2 - COL_GAP / 2;
      g.append('line')
        .attr('class', 'flow-wave-line')
        .attr('x1', sepX).attr('y1', minY - 20)
        .attr('x2', sepX).attr('y2', maxY);
    }
  });

  // --- Edges ---
  // 1. Spawn edges (parent → child, solid cyan)
  state.traces.forEach(t => {
    if (t.parent_id && pos[t.parent_id] && pos[t.id]) {
      const s = pos[t.parent_id];
      const d = pos[t.id];
      drawEdge(g, s, d, CARD_W, CARD_H, 'spawn');
    }
  });

  // 2. Context edges — agents in wave N → agents in wave N+1 that are NOT spawn children
  const spawnChildren = new Set(state.traces.filter(t => t.parent_id).map(t => t.id));
  for (let wi = 0; wi < waves.length - 1; wi++) {
    waves[wi].forEach(src => {
      waves[wi + 1].forEach(tgt => {
        if (!spawnChildren.has(tgt.id) || tgt.parent_id !== src.id) {
          if (pos[src.id] && pos[tgt.id]) {
            drawEdge(g, pos[src.id], pos[tgt.id], CARD_W, CARD_H, 'context');
          }
        }
      });
    });
  }

  // --- Nodes ---
  const ICON_W = 40;
  const cx     = -CARD_W / 2 + ICON_W + 8;

  const node = g.selectAll('.flow-node')
    .data(state.traces)
    .join('g')
    .attr('class', d => `flow-node${state.selectedTrace?.id === d.id ? ' selected' : ''}`)
    .attr('transform', d => `translate(${pos[d.id].x},${pos[d.id].y})`)
    .on('click', (event, d) => { event.stopPropagation(); selectTrace(d); });

  // Card background with glow
  node.append('rect')
    .attr('class', 'flow-node-card')
    .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2)
    .attr('width', CARD_W).attr('height', CARD_H).attr('rx', 5)
    .attr('filter', d => GLOW_FILTER[d.status] ? `url(#${GLOW_FILTER[d.status]})` : null);

  // Status stripe
  node.append('rect')
    .attr('class', d => `node-status-bar bar-${d.status}`)
    .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2 + 4)
    .attr('width', 3).attr('height', CARD_H - 8).attr('rx', 1.5);

  // Icon box
  node.append('rect')
    .attr('class', d => `node-icon-bg icon-bg-${d.status}`)
    .attr('x', -CARD_W / 2 + 4).attr('y', -CARD_H / 2 + 1)
    .attr('width', ICON_W - 2).attr('height', CARD_H - 2).attr('rx', 3);

  node.append('text')
    .attr('class', 'node-icon')
    .attr('x', -CARD_W / 2 + 4 + (ICON_W - 2) / 2).attr('y', 1)
    .attr('font-size', 17)
    .text(d => getAgentIcon(d.agent_type));

  // Name
  node.append('text')
    .attr('class', 'flow-node-label')
    .attr('x', cx).attr('y', -8)
    .text(d => truncate(agentLabel(d.agent_type), 16));

  // Status + duration
  node.append('text')
    .attr('class', d => `flow-node-meta flow-meta-${d.status}`)
    .attr('x', cx).attr('y', 8)
    .text(d => {
      if (d.status === 'running')     return '⟳ running';
      if (d.status === 'interrupted') return '⚠ interrupted';
      const dur  = formatDuration(d.duration_ms) || '';
      const cost = d.cost_usd != null ? `  ~${formatCost(d.cost_usd)}` : '';
      return dur + cost;
    });

  svg.on('click', () => { state.selectedTrace = null; renderDetail(null); });

  // --- Legend ---
  const legend = document.createElement('div');
  legend.className = 'flow-legend';
  legend.innerHTML = `
    <div class="flow-legend-item">
      <div class="flow-legend-line spawn"></div>
      <span>Spawned by</span>
    </div>
    <div class="flow-legend-item">
      <div class="flow-legend-line context"></div>
      <span>Context passed to</span>
    </div>
  `;
  container.appendChild(legend);
}

function drawEdge(g, src, tgt, cardW, cardH, type) {
  const sx = src.x + cardW / 2;
  const sy = src.y;
  const tx = tgt.x - cardW / 2 - 6;  // -6 for arrowhead clearance
  const ty = tgt.y;
  const mx = (sx + tx) / 2;

  g.append('path')
    .attr('class', `flow-edge-${type}`)
    .attr('d', `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`)
    .attr('marker-end', `url(#arrow-${type})`);
}

// =============================================================
// Logs — CLI terminal view
// =============================================================

function renderLogs() {
  const empty    = document.getElementById('logs-empty');
  const terminal = document.getElementById('log-terminal');

  if (!state.selectedSessionId || !state.traces.length) {
    empty.style.display = '';
    terminal.classList.add('hidden');
    return;
  }

  empty.style.display = 'none';
  terminal.classList.remove('hidden');

  const container = document.getElementById('log-entries');
  container.innerHTML = '';

  // Build log entries from traces, sorted by started_at
  const sorted = [...state.traces].sort((a, b) => a.started_at - b.started_at);
  const byId   = {};
  sorted.forEach(t => { byId[t.id] = t; });

  sorted.forEach(trace => {
    appendLogEntry(container, trace, byId);
  });

  scrollLogsIfEnabled();
}

function appendLogEntry(container, trace, byId) {
  const isTool = trace.kind === 'tool';
  const el = document.createElement('div');
  el.className = isTool ? 'log-entry log-entry-tool' : 'log-entry';
  el.dataset.id = trace.id;

  const timeStr = formatTime(trace.started_at);
  const durStr  = formatDuration(trace.duration_ms) || '';

  if (isTool) {
    // Compact single-line tool entry
    const icon      = getToolIcon(trace.agent_type);
    const color     = getToolColor(trace.agent_type);
    const statusStr = trace.status === 'running' ? '⟳' : (trace.status === 'interrupted' ? '⚠' : '');
    const inputLine = trace.prompt ? `<div class="log-section-title">Input</div><div class="log-code">${escHtml(trace.prompt)}</div>` : '';
    const outputLine= trace.response ? `<div class="log-section-title">Output</div><div class="log-code">${escHtml(trace.response)}</div>` : '';

    el.innerHTML = `
      <div class="log-entry-header log-tool-header">
        <span class="log-time">${timeStr}</span>
        <span class="log-tool-badge" style="color:${color};border-color:${color}">${icon} ${escHtml(trace.agent_type)}</span>
        <span class="log-tool-status">${statusStr}</span>
        <span class="log-entry-cost">${durStr}</span>
        <span class="log-chevron">▶</span>
      </div>
      <div class="log-entry-body">
        ${inputLine}
        ${outputLine}
      </div>
    `;
  } else {
    // Full agent entry
    const eventType   = trace.status === 'running' ? 'spawn' : (trace.status === 'interrupted' ? 'fail' : 'done');
    const parentTrace = trace.parent_id ? byId[trace.parent_id] : null;
    const children    = Object.values(byId).filter(t => t.parent_id === trace.id && t.kind !== 'tool');
    const costStr     = trace.cost_usd != null ? `~${formatCost(trace.cost_usd)}` : '';
    const icon        = getAgentIcon(trace.agent_type);
    const name        = agentLabel(trace.agent_type);

    const parentLine   = parentTrace ? `<div class="log-section-title">Spawned by</div><div class="log-code">${agentLabel(parentTrace.agent_type)}</div>` : '';
    const childrenLine = children.length ? `<div class="log-section-title">Spawned agents</div><div class="log-code">${children.map(c => `${getAgentIcon(c.agent_type)} ${agentLabel(c.agent_type)}`).join('\n')}</div>` : '';
    const promptLine   = trace.prompt ? `<div class="log-section-title">Prompt</div><div class="log-code">${escHtml(trace.prompt)}</div>` : '';
    const responseLine = trace.response ? `<div class="log-section-title">Response</div><div class="log-code">${escHtml(trace.response)}</div>` : '';

    el.innerHTML = `
      <div class="log-entry-header">
        <span class="log-time">${timeStr}</span>
        <span class="log-event-type log-event-${eventType}">${eventType.toUpperCase()}</span>
        <span class="log-agent-name">${icon} ${name}${trace.description && trace.description !== trace.agent_type ? ' <span style="color:var(--text-muted)">· ' + escHtml(truncate(trace.description, 40)) + '</span>' : ''}</span>
        <span class="log-entry-cost">${[durStr, costStr].filter(Boolean).join('  ·  ')}</span>
        <span class="log-chevron">▶</span>
      </div>
      <div class="log-entry-body">
        ${parentLine}
        ${childrenLine}
        ${promptLine}
        ${responseLine}
      </div>
    `;
  }

  el.querySelector('.log-entry-header').addEventListener('click', () => {
    el.classList.toggle('expanded');
  });

  container.appendChild(el);
}

function scrollLogsIfEnabled() {
  const autoscroll = document.getElementById('log-autoscroll');
  if (autoscroll?.checked) {
    const entries = document.getElementById('log-entries');
    if (entries) entries.scrollTop = entries.scrollHeight;
  }
}

function escHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =============================================================
// D3 — Call Tree (card nodes with icon boxes + SVG glow)
// =============================================================

const CARD_W   = 196;
const CARD_H   = 62;
const ICON_BOX      = 46;   // width of the icon area inside each card
const NODE_W        = 256;  // horizontal spacing between depth levels
const NODE_H        = 86;   // vertical spacing between siblings
const TOOL_CARD_W   = 130;  // smaller card for tool activity nodes
const TOOL_CARD_H   = 34;   // shorter card for tool activity nodes

function buildHierarchy(traces, session) {
  const map = {};
  traces.forEach(t => { map[t.id] = { ...t, children: [] }; });
  const roots = [];
  traces.forEach(t => {
    if (t.parent_id && map[t.parent_id]) map[t.parent_id].children.push(map[t.id]);
    else roots.push(map[t.id]);
  });
  // Always place a session-start root node at the top of the tree
  const sessionNode = {
    id: '__root__',
    kind: 'session',
    agent_type: 'Session',
    status: 'root',
    description: session ? truncate(session.id, 16) : '',
    started_at: session?.started_at,
    prompt: '', response: null,
    children: roots,
  };
  return sessionNode;
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

  if (!state.selectedSessionId) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const session  = state.sessions.find(s => s.id === state.selectedSessionId);
  const rootData = buildHierarchy(state.traces, session);
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
      const tokStr  = (d.data.input_tokens || d.data.output_tokens)
        ? `  ·  ~${formatTokens((d.data.input_tokens||0)+(d.data.output_tokens||0))} tok  ·  ~${formatCost(d.data.cost_usd)}`
        : '';
      tooltip.innerHTML = `
        <div class="tooltip-agent">${getAgentIcon(d.data.agent_type)} ${agentLabel(d.data.agent_type)}${tokStr}</div>
        <div class="tooltip-prompt">${truncate(d.data.prompt || d.data.description, 220)}</div>
      `;
    })
    .on('mousemove', event => {
      tooltip.style.left = `${event.clientX + 14}px`;
      tooltip.style.top  = `${event.clientY - 10}px`;
    })
    .on('mouseout', () => tooltip.classList.add('hidden'));

  // ---- Session root node ----
  const sessionNodes = node.filter(d => d.data.kind === 'session');

  sessionNodes.append('rect')
    .attr('class', 'node-card-bg')
    .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2)
    .attr('width', CARD_W).attr('height', CARD_H).attr('rx', 4)
    .attr('filter', 'url(#glow-cyan)');

  sessionNodes.append('rect')
    .attr('class', 'node-status-bar bar-root')
    .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2 + 4)
    .attr('width', 3).attr('height', CARD_H - 8).attr('rx', 1.5);

  sessionNodes.append('rect')
    .attr('class', 'node-icon-bg icon-bg-root')
    .attr('x', -CARD_W / 2 + 4).attr('y', -CARD_H / 2 + 1)
    .attr('width', ICON_BOX - 2).attr('height', CARD_H - 2).attr('rx', 3);

  sessionNodes.append('text')
    .attr('class', 'node-icon')
    .attr('x', -CARD_W / 2 + 4 + (ICON_BOX - 2) / 2).attr('y', 1)
    .text('🚀');

  const scx = -CARD_W / 2 + ICON_BOX + 10;
  sessionNodes.append('text')
    .attr('class', 'node-label').attr('x', scx).attr('y', -14)
    .text('Session');
  sessionNodes.append('text')
    .attr('class', 'node-desc').attr('x', scx).attr('y', 0)
    .text(d => d.data.description);
  sessionNodes.append('text')
    .attr('class', 'node-meta meta-root').attr('x', scx).attr('y', 14)
    .text(d => d.data.started_at ? formatTime(d.data.started_at) : '');

  // ---- Agent nodes ----
  const agentNodes = node.filter(d => d.data.kind !== 'tool' && d.data.kind !== 'session');

  agentNodes.append('rect')
    .attr('class', 'node-card-bg')
    .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2)
    .attr('width', CARD_W).attr('height', CARD_H).attr('rx', 4)
    .attr('filter', d => GLOW_FILTER[d.data.status] ? `url(#${GLOW_FILTER[d.data.status]})` : null);

  agentNodes.append('rect')
    .attr('class', d => `node-status-bar bar-${d.data.status}`)
    .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2 + 4)
    .attr('width', 3).attr('height', CARD_H - 8).attr('rx', 1.5);

  agentNodes.append('rect')
    .attr('class', d => `node-icon-bg icon-bg-${d.data.status}`)
    .attr('x', -CARD_W / 2 + 4).attr('y', -CARD_H / 2 + 1)
    .attr('width', ICON_BOX - 2).attr('height', CARD_H - 2).attr('rx', 3);

  agentNodes.append('text')
    .attr('class', 'node-icon')
    .attr('x', -CARD_W / 2 + 4 + (ICON_BOX - 2) / 2).attr('y', 1)
    .text(d => getAgentIcon(d.data.agent_type));

  const agentCx = -CARD_W / 2 + ICON_BOX + 10;
  agentNodes.append('text')
    .attr('class', 'node-label').attr('x', agentCx).attr('y', -14)
    .text(d => truncate(agentLabel(d.data.agent_type), 18));
  agentNodes.append('text')
    .attr('class', 'node-desc').attr('x', agentCx).attr('y', 0)
    .text(d => truncate(d.data.description, 22));
  agentNodes.append('text')
    .attr('class', d => `node-meta meta-${d.data.status}`).attr('x', agentCx).attr('y', 14)
    .text(d => {
      if (d.data.status === 'running')     return '⟳ running';
      if (d.data.status === 'interrupted') return '⚠ interrupted';
      if (d.data.status === 'root')        return '';
      const dur  = formatDuration(d.data.duration_ms) || '';
      const cost = d.data.cost_usd != null ? `  ~${formatCost(d.data.cost_usd)}` : '';
      return dur + cost;
    });

  // ---- Tool activity nodes (smaller pill-shaped cards) ----
  const toolNodes = node.filter(d => d.data.kind === 'tool');

  toolNodes.append('rect')
    .attr('class', 'node-card-bg node-tool-card')
    .attr('x', -TOOL_CARD_W / 2).attr('y', -TOOL_CARD_H / 2)
    .attr('width', TOOL_CARD_W).attr('height', TOOL_CARD_H).attr('rx', 6);

  toolNodes.append('rect')
    .attr('class', 'node-tool-stripe')
    .attr('x', -TOOL_CARD_W / 2).attr('y', -TOOL_CARD_H / 2 + 3)
    .attr('width', 3).attr('height', TOOL_CARD_H - 6).attr('rx', 1.5)
    .attr('fill', d => getToolColor(d.data.agent_type));

  toolNodes.append('text')
    .attr('class', 'node-tool-icon')
    .attr('x', -TOOL_CARD_W / 2 + 16).attr('y', 1)
    .attr('fill', d => getToolColor(d.data.agent_type))
    .text(d => getToolIcon(d.data.agent_type));

  toolNodes.append('text')
    .attr('class', 'node-tool-label')
    .attr('fill', '#e2e8f0')
    .attr('x', -TOOL_CARD_W / 2 + 30).attr('y', -5)
    .text(d => d.data.agent_type);

  toolNodes.append('text')
    .attr('class', 'node-tool-meta')
    .attr('fill', 'rgba(255,255,255,0.45)')
    .attr('x', -TOOL_CARD_W / 2 + 30).attr('y', 9)
    .text(d => {
      if (d.data.status === 'running') return '⟳';
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
    const isTool = trace.kind === 'tool';
    const y      = i * rowH;
    const yMid   = y + rowH / 2;
    const depth  = traceDepth(trace, byId);
    const indent = depth * 10;
    const isSelected = state.selectedTrace?.id === trace.id;

    // Icon + label
    const icon  = isTool ? getToolIcon(trace.agent_type) : getAgentIcon(trace.agent_type);
    const label = isTool ? trace.agent_type : truncate(agentLabel(trace.agent_type), 16);
    g.append('text')
      .attr('class', isTool ? 'tl-label tl-label-tool' : 'tl-label')
      .attr('fill', isTool ? getToolColor(trace.agent_type) : null)
      .attr('x', -10 - indent)
      .attr('y', yMid).attr('dy', '0.35em')
      .attr('text-anchor', 'end')
      .text(`${icon} ${label}`);

    const barX = xScale(new Date(trace.started_at * 1000)) + indent;
    const barW = Math.max(4, xScale(new Date((trace.completed_at || now) * 1000)) - xScale(new Date(trace.started_at * 1000)) - indent);

    // Tool bars: narrower, colored by tool type; agent bars: full height, colored by status
    if (isTool) {
      const barH   = Math.round((rowH - 14) * 0.55);
      const barTop = y + (rowH - barH) / 2;
      g.append('rect')
        .attr('class', `tl-bar tl-bar-tool${isSelected ? ' selected' : ''}`)
        .attr('fill', getToolColor(trace.agent_type))
        .attr('x', barX).attr('y', barTop)
        .attr('width', barW).attr('height', barH).attr('rx', 3)
        .attr('opacity', 0.7)
        .on('click', () => selectTrace(trace));
    } else {
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
  document.getElementById('detail-started').textContent      = formatTime(trace.started_at);
  document.getElementById('detail-completed').textContent    = formatTime(trace.completed_at);
  document.getElementById('detail-duration-val').textContent = formatDuration(trace.duration_ms) || '—';
  document.getElementById('detail-input-tokens').textContent = trace.input_tokens  != null ? `~${formatTokens(trace.input_tokens)}`  : '—';
  document.getElementById('detail-output-tokens').textContent= trace.output_tokens != null ? `~${formatTokens(trace.output_tokens)}` : '—';
  const costEl = document.getElementById('detail-cost');
  costEl.textContent = trace.cost_usd != null ? `~${formatCost(trace.cost_usd)}` : '—';
  costEl.className   = `meta-val${trace.cost_usd != null ? ' green' : ''}`;

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
// Continue in Claude Code
// =============================================================

function generateContinuePrompt(trace) {
  const byId = {};
  state.traces.forEach(t => { byId[t.id] = t; });

  const parent   = trace.parent_id ? byId[trace.parent_id] : null;
  const children = state.traces.filter(t => t.parent_id === trace.id);

  const lines = [];

  lines.push(`# Continue: ${agentLabel(trace.agent_type)}`);
  if (trace.description) lines.push(`# Task: ${trace.description}`);
  lines.push('');

  if (parent) {
    lines.push(`## Spawned by`);
    lines.push(agentLabel(parent.agent_type));
    lines.push('');
  }

  if (trace.prompt) {
    lines.push('## Original prompt');
    lines.push(trace.prompt.trim());
    lines.push('');
  }

  if (trace.response) {
    lines.push('## Agent response');
    lines.push(trace.response.trim());
    lines.push('');
  }

  if (children.length) {
    lines.push('## Agents it spawned');
    children.forEach(c => lines.push(`- ${agentLabel(c.agent_type)}: ${c.description || '—'}`));
    lines.push('');
  }

  lines.push('## Your follow-up');
  lines.push('');

  return lines.join('\n');
}

function setupContinueButton() {
  document.getElementById('btn-continue').addEventListener('click', () => {
    if (!state.selectedTrace) return;
    const prompt = generateContinuePrompt(state.selectedTrace);
    const btn    = document.getElementById('btn-continue');

    navigator.clipboard.writeText(prompt).then(() => {
      btn.textContent = '✓ Copied — paste into Claude Code';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '↗ Continue in Claude Code';
        btn.classList.remove('copied');
      }, 2500);
    }).catch(() => {});
  });
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
  setupContinueButton();
  connectSSE();
  await loadSessions();
  setInterval(loadSessions, 30_000);
}

document.addEventListener('DOMContentLoaded', init);
