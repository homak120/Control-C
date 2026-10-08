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
    selected: null,
    filter: 'all',
    query: '',
  };

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
    const groups = new Map();
    for (const s of visibleSessions()) {
      const key = projectName(s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    list.replaceChildren();
    if (!groups.size) list.append(el('p', 'muted pad', state.sessions.size ? 'No sessions match.' : 'No sessions found yet.'));
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
    const sub = el('div', 'row-sub');
    const bits = [rel(s.lastTs), `${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`, money(s.costUSD)].filter(Boolean);
    sub.append(el('span', `state ${st.key}`, st.label), el('span', null, ' · ' + bits.join(' · ')));
    a.append(top, sub);
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

  async function openSession(id) {
    state.selected = id;
    document.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
    document.querySelector(`.row[data-id="${id}"]`)?.classList.add('selected');
    document.body.classList.remove('sidebar-open');
    $('#empty').hidden = true;
    $('#session').hidden = false;
    $('#timeline').replaceChildren(el('p', 'muted pad', 'Loading…'));
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

    const actions = el('div', 'head-actions');
    const copyBtn = (label, text) => {
      const b = el('button', 'btn', label);
      b.onclick = async () => { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => (b.textContent = label), 1200); };
      return b;
    };
    actions.append(el('code', 'sid', s.id), copyBtn('Copy ID', s.id));
    if (s.cwd) actions.append(copyBtn('Copy resume command', `cd ${JSON.stringify(s.cwd)} && claude --resume ${s.id}`));
    if (s.continuedIn) {
      const a = el('a', 'btn', 'Go to continuation →');
      a.href = `#/s/${s.continuedIn}`;
      actions.append(a);
    }
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

  const main = () => $('#main');
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
    if (m && m[1] !== state.selected) openSession(m[1]);
    if (!m) {
      state.selected = null;
      $('#session').hidden = true;
      $('#empty').hidden = false;
    }
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
  $('#main').addEventListener('scroll', () => { if (nearBottom()) $('#jump').hidden = true; });
  $('#raw-close').onclick = () => $('#raw-dialog').close();
  $('#toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-open');
  window.addEventListener('hashchange', route);
  setInterval(() => { renderList(); if (state.selected) renderHead(); }, 30000);

  loadSessions().then(route).catch((err) => console.error(err));
  // Opening the stream before `load` keeps Chrome's page-loading indicator spinning forever.
  if (document.readyState === 'complete') connect(); else window.addEventListener('load', connect, { once: true });
})();
