// Control-C dashboard: session list + live, organized conversation view.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const state = {
    sessions: new Map(), // id -> summary
    live: {},            // id -> hook-derived live state
    hooksSeen: false,
    selected: null,       // session id shown, or null
    selectedPane: null,   // pane id shown on its own (terminal not yet linked to a session)
    terminals: [],        // tmux panes from the hub, each with the session it runs (if known)
    filter: 'all',
    query: '',
    mode: pref('mode', 'split'), // chat | terminal | split, when a terminal is available
  };

  function pref(key, fallback) {
    try { return localStorage.getItem(`control-c.${key}`) || fallback; } catch { return fallback; }
  }
  function savePref(key, value) {
    try { localStorage.setItem(`control-c.${key}`, value); } catch {}
  }

  const termForSession = (id) => state.terminals.find((t) => t.sessionId === id && !t.dead);
  const paneNum = (id) => id.replace('%', '');

  // ---- formatting ------------------------------------------------------------

  const rel = (iso) => {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  };
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
  const secs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
  const money = (n) => (n == null ? null : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
  const num = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const projectName = (s) => (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : s.project.replace(/^-Users-[^-]+-/, ''));

  // Overall status: live hook state wins, then what the transcript says.
  function status(s) {
    const live = state.live[s.id];
    if (live && live.state !== 'ended' && !s.closed) {
      if (live.state === 'attention') return { key: 'attention', label: 'needs you' };
      if (live.state === 'working') return { key: 'working', label: live.tool ? `running ${live.tool}` : 'working' };
      if (live.state === 'compacting') return { key: 'working', label: 'compacting' };
      return { key: 'idle', label: 'idle' };
    }
    if (s.closed || live?.state === 'ended') return { key: 'closed', label: s.continuedIn ? 'continued' : 'closed' };
    if (s.turnOpen && Date.now() - s.modifiedMs < 120000) return { key: 'working', label: 'working' };
    return { key: 'open', label: 'open' };
  }

  // ---- API ---------------------------------------------------------------------

  async function api(p) {
    const r = await fetch(p, { credentials: 'same-origin' });
    if (r.status === 401) { location.reload(); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status} ${p}`);
    return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
  }

  async function loadSessions() {
    const data = await api('/api/sessions');
    state.sessions = new Map(data.sessions.map((s) => [s.id, s]));
    state.live = data.live;
    state.hooksSeen = data.hooksSeen;
    state.terminals = data.terminals || [];
    renderHookStatus();
    renderList();
  }

  // ---- sidebar -----------------------------------------------------------------

  function visibleSessions() {
    const q = state.query.toLowerCase();
    const today = new Date().toDateString();
    return [...state.sessions.values()]
      .filter((s) => s.lines > 0)
      .filter((s) => state.filter !== 'open' || !['closed'].includes(status(s).key))
      .filter((s) => state.filter !== 'today' || (s.lastTs && new Date(s.lastTs).toDateString() === today))
      .filter((s) => !q || [s.title, s.lastPrompt, s.cwd, s.id, s.project].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  }

  function renderList() {
    const list = $('#session-list');
    list.replaceChildren();

    // Terminals whose Claude session isn't known yet (just started, no prompt sent).
    const pending = state.terminals.filter((t) => !t.sessionId && !t.dead);
    if (pending.length) {
      const g = el('div', 'group');
      const h = el('div', 'group-head');
      h.append(el('span', null, 'New terminals'), el('span', 'count', String(pending.length)));
      g.append(h);
      for (const t of pending) g.append(paneRow(t));
      list.append(g);
    }

    const groups = new Map();
    for (const s of visibleSessions()) {
      const key = projectName(s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    if (!groups.size && !pending.length) list.append(el('p', 'muted pad', state.sessions.size ? 'No sessions match.' : 'No sessions found yet.'));
    for (const [name, sessions] of groups) {
      const g = el('div', 'group');
      const h = el('div', 'group-head');
      h.append(el('span', null, name), el('span', 'count', String(sessions.length)));
      g.append(h);
      for (const s of sessions) g.append(sessionRow(s));
      list.append(g);
    }
  }

  function sessionRow(s) {
    const st = status(s);
    const a = el('a', `row${s.id === state.selected ? ' selected' : ''}`);
    a.href = `#/s/${s.id}`;
    a.dataset.id = s.id;
    const top = el('div', 'row-top');
    top.append(el('span', `dot ${st.key}`), el('span', 'row-title', s.title || '(untitled)'));
    if (termForSession(s.id)) top.append(el('span', 'term-badge', '▣'));
    const sub = el('div', 'row-sub');
    const bits = [rel(s.lastTs), `${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`, money(s.costUSD)].filter(Boolean);
    sub.append(el('span', `state ${st.key}`, st.label), el('span', null, ' · ' + bits.join(' · ')));
    a.append(top, sub);
    return a;
  }

  function paneRow(t) {
    const a = el('a', `row${t.id === state.selectedPane ? ' selected' : ''}`);
    a.href = `#/t/${paneNum(t.id)}`;
    a.dataset.pane = t.id;
    const top = el('div', 'row-top');
    top.append(el('span', 'dot idle'), el('span', 'row-title', t.cwd.split('/').filter(Boolean).pop() || t.cwd), el('span', 'term-badge', '▣'));
    a.append(top, el('div', 'row-sub', `${t.session} · waiting for first prompt`));
    return a;
  }

  function updateRow(id) {
    const s = state.sessions.get(id);
    const old = document.querySelector(`.row[data-id="${id}"]`);
    if (!s || !old) return renderList();
    old.replaceWith(sessionRow(s));
  }

  // ---- session view --------------------------------------------------------------

  let view = null; // per-session render state

  function showSessionUI() {
    document.body.classList.remove('sidebar-open');
    $('#empty').hidden = true;
    $('#session').hidden = false;
  }

  function markSelected() {
    document.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
    const row = state.selected
      ? document.querySelector(`.row[data-id="${state.selected}"]`)
      : document.querySelector(`.row[data-pane="${state.selectedPane}"]`);
    row?.classList.add('selected');
  }

  async function openSession(id) {
    state.selected = id;
    state.selectedPane = null;
    markSelected();
    showSessionUI();
    $('#timeline').replaceChildren(el('p', 'muted pad', 'Loading…'));
    syncTerminal();
    try {
      const data = await api(`/api/sessions/${id}`);
      if (state.selected !== id) return;
      state.sessions.set(id, data.summary);
      if (data.live) state.live[id] = data.live;
      renderHead();
      view = { id, turn: null, turnBody: null, tools: new Map(), turnStats: null };
      const tl = $('#timeline');
      tl.replaceChildren();
      for (const item of data.items) addItem(item);
      if (!data.items.length) tl.append(el('p', 'muted pad', 'Nothing in this session yet.'));
      scrollToBottom();
    } catch (err) {
      $('#timeline').replaceChildren(el('p', 'muted pad', `Couldn't load session: ${err.message}`));
    }
  }

  // A terminal that isn't linked to a session yet: show just the terminal.
  function openPane(paneId) {
    state.selected = null;
    state.selectedPane = paneId;
    view = null;
    markSelected();
    showSessionUI();
    $('#timeline').replaceChildren();
    renderPaneHead();
    syncTerminal();
  }

  function renderPaneHead() {
    const t = state.terminals.find((x) => x.id === state.selectedPane);
    const head = $('#session-head');
    head.replaceChildren();
    const titleRow = el('div', 'head-title');
    titleRow.append(el('span', 'dot idle'), el('h1', null, t ? `New session · ${t.cwd.split('/').pop()}` : 'Terminal closed'), el('span', 'badge idle', 'terminal'));
    head.append(titleRow);
    if (!t) return;
    head.append(el('p', 'muted small head-note', 'The chat view appears here as soon as you send the first prompt.'));
    const facts = el('dl', 'facts');
    for (const [k, v] of [['Folder', t.cwd], ['Terminal', `${t.session} (${t.cols}×${t.rows})`]]) {
      const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); facts.append(d);
    }
    head.append(facts);
    head.append(headActions([['Copy attach command', `ctrlc attach ${t.session}`]]));
  }

  function headActions(copies, extra = []) {
    const actions = el('div', 'head-actions');
    for (const [label, text] of copies) {
      const b = el('button', 'btn', label);
      b.onclick = async () => { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => (b.textContent = label), 1200); };
      actions.append(b);
    }
    actions.append(...extra);
    return actions;
  }

  // ---- terminal panel ----------------------------------------------------------------

  let termView = null;

  function currentTerminal() {
    if (state.selectedPane) return state.terminals.find((t) => t.id === state.selectedPane && !t.dead) || null;
    return state.selected ? termForSession(state.selected) || null : null;
  }

  // Show, hide or switch the live terminal to match the current selection.
  function syncTerminal() {
    const t = currentTerminal();
    const body = $('#session-body');
    const mode = !t ? 'chat' : state.selectedPane ? 'terminal' : state.mode;
    body.dataset.mode = mode;
    if (!t || mode === 'chat') {
      if (termView && !t) { termView.dispose(); termView = null; }
      return;
    }
    if (termView?.paneId !== t.id) {
      termView?.dispose();
      $('#term').replaceChildren();
      termView = new window.TerminalView($('#term'), t.id, {
        onStatus: (s) => { $('#term-status').textContent = { live: '● live', connecting: 'connecting…', reconnecting: 'reconnecting…', closed: 'terminal closed' }[s] || s; $('#term-status').dataset.state = s; },
      });
    }
    requestAnimationFrame(() => termView?.fit());
  }

  function setMode(mode) {
    state.mode = mode;
    savePref('mode', mode);
    syncTerminal();
    renderHead();
    if (mode !== 'terminal') scrollToBottom();
  }

  const KEYS = { esc: '\x1b', enter: '\r', up: '\x1b[A', down: '\x1b[B', shifttab: '\x1b[Z', ctrlc: '\x03' };

  function sendPrompt(text) {
    if (!termView || !text.trim()) return;
    // Multi-line text goes in as a bracketed paste so newlines don't submit early.
    termView.send(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
    setTimeout(() => termView?.send('\r'), 60);
  }

  function renderHead() {
    const s = state.sessions.get(state.selected);
    if (!s) return;
    const st = status(s);
    const live = state.live[s.id];
    const head = $('#session-head');
    head.replaceChildren();

    const titleRow = el('div', 'head-title');
    titleRow.append(el('span', `dot ${st.key}`), el('h1', null, s.title || '(untitled session)'), el('span', `badge ${st.key}`, st.label));
    head.append(titleRow);

    if (live?.attention && st.key === 'attention') head.append(el('div', 'attention', `⚠ ${live.attention}`));

    const facts = el('dl', 'facts');
    const fact = (k, v, cls) => { if (v == null || v === '') return; const d = el('div', cls); d.append(el('dt', null, k), el('dd', null, v)); facts.append(d); };
    fact('Project', s.cwd || s.project);
    fact('Started', dateTime(s.firstTs));
    fact('Last activity', `${dateTime(s.lastTs)} (${rel(s.lastTs)})`);
    fact('Prompts', String(s.prompts));
    fact('Lines', `${s.lines} · ${num(Math.round(s.bytes / 1024))} KB`);
    fact('Output tokens', num(s.outputTokens));
    fact('Cost', money(s.costUSD) ?? (s.closed ? null : 'shown when the session ends'));
    fact('Model', s.model);
    fact('CLI', s.version);
    fact('Branch', s.gitBranch);
    head.append(facts);

    const extra = [];
    const t = termForSession(s.id);
    if (t) {
      const seg = el('div', 'seg mode-switch');
      for (const [mode, label] of [['chat', 'Chat'], ['split', 'Split'], ['terminal', 'Terminal']]) {
        const b = el('button', state.mode === mode ? 'on' : '', label);
        b.onclick = () => setMode(mode);
        seg.append(b);
      }
      extra.push(seg);
    }
    if (s.continuedIn) {
      const a = el('a', 'btn', 'Go to continuation →');
      a.href = `#/s/${s.continuedIn}`;
      extra.push(a);
    }
    const copies = [['Copy ID', s.id]];
    if (t) copies.push(['Copy attach command', `ctrlc attach ${t.session}`]);
    else if (s.cwd) copies.push(['Copy resume command', `cd ${JSON.stringify(s.cwd)} && claude --resume ${s.id}`]);
    const actions = headActions(copies, extra);
    actions.prepend(el('code', 'sid', s.id));
    head.append(actions);
  }

  // Items are fed one by one, both on first load and for live updates,
  // so the incremental and full renders always match.
  function addItem(it) {
    const tl = $('#timeline');
    const startsTurn = it.kind === 'prompt' || it.kind === 'command';
    if (startsTurn || !view.turn) newTurn(it);
    const body = view.turnBody;

    switch (it.kind) {
      case 'prompt': {
        const card = el('div', 'prompt');
        const meta = el('div', 'item-meta');
        meta.append(el('span', null, 'You'), el('span', 'muted', clock(it.ts)), lineLink(it.line));
        const text = el('div', 'prompt-text', it.text);
        card.append(meta, text);
        if (it.images) card.append(el('div', 'muted small', `+ ${it.images} image${it.images > 1 ? 's' : ''}`));
        if (it.truncated) card.append(el('div', 'muted small', `… ${num(it.truncated)} more characters`));
        view.turn.querySelector('.turn-head').append(card);
        break;
      }
      case 'command': {
        const card = el('div', 'command');
        card.append(el('code', null, `${it.name}${it.args ? ' ' + it.args : ''}`), el('span', 'muted', clock(it.ts)), lineLink(it.line));
        view.turn.querySelector('.turn-head').append(card);
        break;
      }
      case 'command-output':
        body.append(el('pre', 'output', it.text));
        break;
      case 'thinking': {
        const t = el('div', 'step thinking');
        t.append(el('span', 'step-icon', '✻'), el('span', null, it.tokens ? `Thought · ${it.tokens} tokens` : 'Thought'), lineLink(it.line));
        body.append(t);
        break;
      }
      case 'text': {
        const t = el('div', 'reply');
        const md = el('div', 'md');
        md.innerHTML = window.renderMarkdown(it.text); // renderer escapes all input
        const meta = el('div', 'item-meta');
        meta.append(el('span', null, 'Claude'), el('span', 'muted', clock(it.ts)), lineLink(it.line));
        t.append(meta, md);
        body.append(t);
        break;
      }
      case 'tool_use': {
        const d = el('details', 'step tool pending');
        const sum = el('summary');
        sum.append(el('span', 'step-icon', '⏺'), el('span', 'tool-name', it.name), el('span', 'tool-sum', it.description || it.summary || ''), el('span', 'tool-status', '…'), lineLink(it.line));
        const inner = el('div', 'tool-body');
        if (it.summary && it.description) inner.append(el('div', 'label', 'Command'), el('pre', 'code', it.summary));
        inner.append(el('div', 'label', 'Input'), el('pre', 'code', it.input));
        d.append(sum, inner);
        body.append(d);
        view.tools.set(it.id, d);
        view.turnStats.tools++;
        break;
      }
      case 'tool_result': {
        const d = view.tools.get(it.toolUseId);
        if (!d) break;
        d.classList.remove('pending');
        d.classList.toggle('error', it.isError);
        d.querySelector('.tool-status').textContent = it.isError ? '✗ error' : `✓ ${num(it.size)} chars`;
        const inner = d.querySelector('.tool-body');
        const label = el('div', 'label');
        label.append(el('span', null, 'Result '), lineLink(it.line));
        inner.append(label, el('pre', `code${it.isError ? ' err' : ''}`, it.text + (it.truncated ? `\n… ${num(it.truncated)} more characters (open the raw line)` : '')));
        break;
      }
      case 'turn-end': {
        const f = el('div', 'turn-foot');
        const n = view.turnStats.tools;
        f.append(el('span', null, `Done in ${secs(it.durationMs)}${n ? ` · ${n} tool call${n > 1 ? 's' : ''}` : ''}`), lineLink(it.line));
        body.append(f);
        view.turn.classList.add('done');
        break;
      }
      case 'recap':
        body.append(sysRow('↺', `Recap: ${it.text}`, it));
        break;
      case 'compact':
        body.append(sysRow('⇣', `Conversation compacted (${it.trigger}) · ${num(it.preTokens || 0)} → ${num(it.postTokens || 0)} tokens`, it));
        break;
      case 'compact-summary': {
        const d = el('details', 'step');
        const sum = el('summary');
        sum.append(el('span', 'step-icon', '≡'), el('span', null, 'Summary carried over from before compaction'), lineLink(it.line));
        const md = el('div', 'md tool-body');
        md.innerHTML = window.renderMarkdown(it.text);
        d.append(sum, md);
        body.append(d);
        break;
      }
      case 'notice':
        body.append(sysRow(it.level === 'warning' ? '⚠' : 'ℹ', it.text, it));
        break;
      case 'session-end':
        body.append(sysRow('■', `Session ended${it.costUSD != null ? ` · total cost ${money(it.costUSD)}` : ''}`, it, 'end'));
        break;
    }
  }

  function newTurn(it) {
    const turn = el('article', 'turn');
    turn.append(el('div', 'turn-head'), el('div', 'turn-body'));
    $('#timeline').append(turn);
    view.turn = turn;
    view.turnBody = turn.querySelector('.turn-body');
    view.turnStats = { tools: 0 };
  }

  function sysRow(icon, text, it, extra = '') {
    const r = el('div', `sys ${extra}`);
    r.append(el('span', 'step-icon', icon), el('span', null, text), el('span', 'muted', clock(it.ts)), lineLink(it.line));
    return r;
  }

  function lineLink(n) {
    const b = el('button', 'line-link', `L${n}`);
    b.title = 'Show raw JSON for this transcript line';
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showRaw(n); };
    return b;
  }

  async function showRaw(n) {
    const id = state.selected;
    const dlg = $('#raw-dialog');
    $('#raw-title').textContent = `${id.slice(0, 8)}… · line ${n}`;
    $('#raw-body').textContent = 'Loading…';
    dlg.showModal();
    try {
      const raw = await api(`/api/sessions/${id}/lines/${n}`);
      let pretty = raw;
      try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
      $('#raw-body').textContent = pretty;
      $('#raw-copy').onclick = () => navigator.clipboard.writeText(raw);
    } catch (err) {
      $('#raw-body').textContent = err.message;
    }
  }

  // ---- scrolling -----------------------------------------------------------------

  const main = () => $('#chat-col');
  const nearBottom = () => main().scrollHeight - main().scrollTop - main().clientHeight < 120;
  const scrollToBottom = () => { main().scrollTop = main().scrollHeight; $('#jump').hidden = true; };

  // ---- live updates ----------------------------------------------------------------

  function renderHookStatus() {
    const pill = $('#hook-status');
    pill.textContent = state.hooksSeen ? 'hooks: live' : 'hooks: not seen';
    pill.classList.toggle('ok', state.hooksSeen);
  }

  function setConn(ok, label) {
    const p = $('#conn-status');
    p.classList.toggle('ok', ok);
    p.classList.toggle('bad', !ok);
    p.querySelector('.label').textContent = label;
  }

  function showWrite(u, id) {
    const s = state.sessions.get(id);
    const p = $('#last-write');
    p.hidden = false;
    p.textContent = `${(s?.title || id).slice(0, 24)} · ${u.kind === 'single' ? 'SINGLE' : `MULTI ×${u.lines}`} · L${u.firstLine}${u.lines > 1 ? `–${u.lastLine}` : ''}`;
    p.title = `Last transcript write: ${u.bytes} bytes at ${new Date().toLocaleTimeString()}`;
    p.classList.remove('flash');
    void p.offsetWidth;
    p.classList.add('flash');
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => { setConn(true, 'live'); loadSessions().catch(() => {}); };
    es.onerror = () => setConn(false, 'reconnecting');

    es.addEventListener('append', (e) => {
      const { id, items, summary, update } = JSON.parse(e.data);
      state.sessions.set(id, summary);
      showWrite(update, id);
      if (id === state.selected && view?.id === id) {
        const stick = nearBottom();
        $('#timeline').querySelector(':scope > p.muted')?.remove();
        for (const it of items) addItem(it);
        renderHead();
        if (stick) scrollToBottom(); else if (items.length) $('#jump').hidden = false;
      }
      // Resort the list when activity changes the order; otherwise patch the row.
      const first = visibleSessions()[0];
      if (first?.id === id && document.querySelector('.row')?.dataset.id !== id) renderList(); else updateRow(id);
    });

    es.addEventListener('session', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'new') { state.sessions.set(msg.summary.id, msg.summary); renderList(); }
      if (msg.type === 'reset' && msg.id === state.selected) openSession(msg.id);
    });

    es.addEventListener('terminals', (e) => {
      state.terminals = JSON.parse(e.data).terminals;
      // A new terminal just got its first prompt: switch from the bare terminal to the full session view.
      if (state.selectedPane) {
        const t = state.terminals.find((x) => x.id === state.selectedPane);
        if (t?.sessionId && state.sessions.has(t.sessionId)) { location.replace(`#/s/${t.sessionId}`); return renderList(); }
        renderPaneHead();
      }
      renderList();
      if (state.selected) { renderHead(); syncTerminal(); } else if (state.selectedPane) syncTerminal();
    });

    es.addEventListener('hook', (e) => {
      const { live } = JSON.parse(e.data);
      state.live[live.sessionId] = live;
      if (!state.hooksSeen) { state.hooksSeen = true; renderHookStatus(); }
      updateRow(live.sessionId);
      if (live.sessionId === state.selected) renderHead();
    });
  }

  // ---- wiring ------------------------------------------------------------------------

  function route() {
    const m = location.hash.match(/^#\/s\/([\w-]+)/);
    const t = location.hash.match(/^#\/t\/(\d+)/);
    if (m && m[1] !== state.selected) openSession(m[1]);
    else if (t && `%${t[1]}` !== state.selectedPane) openPane(`%${t[1]}`);
    else if (!m && !t) {
      state.selected = null;
      state.selectedPane = null;
      termView?.dispose();
      termView = null;
      $('#session').hidden = true;
      $('#empty').hidden = false;
    }
  }

  // ---- new session dialog ----------------------------------------------------------

  function openNewDialog() {
    const cwds = [...new Set([...state.sessions.values()].sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')).map((s) => s.cwd).filter(Boolean))];
    $('#cwd-options').replaceChildren(...cwds.map((c) => Object.assign(document.createElement('option'), { value: c })));
    $('#new-cwd').value = cwds[0] || '';
    $('#new-error').hidden = true;
    $('#new-dialog').showModal();
    $('#new-cwd').select();
  }

  async function startSession(e) {
    e.preventDefault();
    const r = await fetch('/api/terminals', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: $('#new-cwd').value.trim() }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { $('#new-error').textContent = data.error || `Failed (${r.status})`; $('#new-error').hidden = false; return; }
    $('#new-dialog').close();
    const list = await api('/api/terminals');
    state.terminals = list.terminals;
    renderList();
    if (data.paneId) location.hash = `#/t/${paneNum(data.paneId)}`;
  }

  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  $('#filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.filter;
    $('#filter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  });
  $('#jump').onclick = scrollToBottom;
  $('#chat-col').addEventListener('scroll', () => { if (nearBottom()) $('#jump').hidden = true; });
  $('#raw-close').onclick = () => $('#raw-dialog').close();
  $('#new-session').onclick = openNewDialog;
  $('#new-cancel').onclick = () => $('#new-dialog').close();
  $('#new-form').addEventListener('submit', startSession);
  $('#keys').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (b && termView) { termView.send(KEYS[b.dataset.key]); termView.focus(); }
  });
  $('#term-send').addEventListener('submit', (e) => {
    e.preventDefault();
    sendPrompt($('#term-input').value);
    $('#term-input').value = '';
    $('#term-input').style.height = '';
  });
  $('#term-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#term-send').requestSubmit(); }
  });
  $('#term-input').addEventListener('input', (e) => {
    e.target.style.height = '';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  });
  $('#toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-open');
  window.addEventListener('hashchange', route);
  setInterval(() => { renderList(); if (state.selected) renderHead(); else if (state.selectedPane) renderPaneHead(); }, 30000);

  loadSessions().then(route).catch((err) => console.error(err));
  // Opening the stream before `load` keeps Chrome's page-loading indicator spinning forever.
  if (document.readyState === 'complete') connect(); else window.addEventListener('load', connect, { once: true });
})();
