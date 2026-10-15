// Service worker: holds the native-messaging link to the broker and runs tools.
//
// Each broker session (one per agent) owns one tab group, and every tool refuses
// tabs outside the caller's group, so agents can't see or drive each other's
// tabs. The worker can be evicted at any time, so the session map lives in
// chrome.storage.session, not in memory alone.
//
// No externally_connectable and no messages from pages or content scripts are
// accepted: the native port is the only way in.

const HOST = 'io.controlc.browser_bridge';
const MAX_EDGE = 1568;           // long edge of screenshots sent to models
const MAX_IMAGE_B64 = 900_000;   // stay under the 1 MiB host→extension cap
const CDP_TIMEOUT_MS = 20_000;
const COLORS = ['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'yellow', 'red'];

// --- native link -----------------------------------------------------------

let port = null;
let retryMs = 1000;

function connect() {
  if (port) return;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    console.warn('[control-c] broker disconnected:', chrome.runtime.lastError?.message);
    port = null;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  });
  send({ type: 'ext_hello', v: 1, browser: browserName(), extVersion: chrome.runtime.getManifest().version });
}

function send(msg) {
  try { port?.postMessage(msg); } catch (err) { console.warn('[control-c] send failed:', err.message); }
}

function browserName() {
  if (navigator.brave) return 'Brave';
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  return brands.find((b) => !/Chromium|Not.?A.?Brand/i.test(b)) || 'Chromium';
}

// The alarm is a backstop: if the worker was evicted (or the host wasn't
// installed yet), the next wake reconnects.
chrome.alarms.create('control-c-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();

async function onMessage(msg) {
  retryMs = 1000;
  switch (msg?.type) {
    case 'ping': return send({ type: 'pong', t: msg.t });
    case 'session_open': return openSession(msg.sessionId, msg.label);
    case 'session_close': return closeSession(msg.sessionId);
    case 'tool_request': {
      let result;
      try {
        const session = (await loadSessions())[msg.sessionId];
        if (!session) throw new Error('unknown session');
        const fn = TOOLS[msg.tool];
        if (!fn) throw new Error(`unknown tool: ${msg.tool}`);
        result = await fn(session, msg.args || {}, msg.sessionId);
      } catch (err) {
        result = { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
      }
      return send({ type: 'tool_result', id: msg.id, ...result });
    }
  }
}

// --- sessions ----------------------------------------------------------------

let sessions = null; // sessionId -> { label, color, groupId }
let loading = null;

// One shared read: on a fresh worker, session_open and the first tool_request
// arrive together, and two separate reads would let one overwrite the other.
function loadSessions() {
  if (sessions) return Promise.resolve(sessions);
  loading ||= chrome.storage.session.get('sessions').then((r) => (sessions = r.sessions || {}));
  return loading;
}
const saveSessions = () => chrome.storage.session.set({ sessions });

async function openSession(id, label) {
  const all = await loadSessions();
  // A resumed session keeps its group; a new one gets a colour from its id.
  all[id] = { groupId: null, color: COLORS[parseInt(id.slice(0, 2), 36) % COLORS.length] || 'grey', ...all[id], label: String(label || 'agent') };
  await saveSessions();
}

async function closeSession(id) {
  const all = await loadSessions();
  const s = all[id];
  if (!s) return;
  delete all[id];
  await saveSessions();
  // Leave the tabs for the user, but mark the group as no longer driven.
  if (s.groupId != null) chrome.tabGroups.update(s.groupId, { title: `${s.label} (ended)`, color: 'grey' }).catch(() => {});
}

async function sessionTabs(s) {
  if (s.groupId == null) return [];
  return chrome.tabs.query({ groupId: s.groupId }).catch(() => []);
}

/** The tab, if it belongs to this session's group; throws otherwise. */
async function ownedTab(s, tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab || s.groupId == null || tab.groupId !== s.groupId) {
    throw new Error(`Tab ${tabId} is not in this session's tab group. Call tabs_context to see your tabs.`);
  }
  return tab;
}

// --- site policy ---------------------------------------------------------------

/** Only http(s) pages, and nothing on the user's blocklist (storage.local.blockedHosts). */
async function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Not a valid URL: ${raw}`); }
  if (url.href === 'about:blank') return url;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) URLs are allowed, not ${url.protocol}`);
  const { blockedHosts = [] } = await chrome.storage.local.get('blockedHosts');
  const host = url.hostname.toLowerCase();
  if (blockedHosts.some((b) => host === b || host.endsWith(`.${b}`))) throw new Error(`${host} is blocked by your Control-C settings`);
  return url;
}

// --- per-tab lock and debugger -----------------------------------------------

const locks = new Map();
/** Run fn with exclusive use of a tab, so two calls never interleave CDP input. */
function withTab(tabId, fn) {
  const prev = locks.get(tabId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(tabId, run);
  run.finally(() => { if (locks.get(tabId) === run) locks.delete(tabId); });
  return run;
}

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

// Attach only for the duration of one call: the "is debugging this browser"
// bar shows while attached, and the page stays usable for the user otherwise.
async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  const cdp = (method, params) => timeout(chrome.debugger.sendCommand(target, method, params), CDP_TIMEOUT_MS, method);
  try { return await fn(cdp); } finally { await chrome.debugger.detach(target).catch(() => {}); }
}

function waitForLoad(tabId, ms = 15_000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, ms); // slow pages still return what loaded
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const tabInfo = (t) => ({ tabId: t.id, url: t.url || t.pendingUrl, title: t.title, active: t.active });

// --- tools -------------------------------------------------------------------

const TOOLS = {
  async tabs_context(s, { createIfEmpty }) {
    let tabs = await sessionTabs(s);
    if (!tabs.length) {
      s.groupId = null;
      if (createIfEmpty) {
        // Its own unfocused window: the agent's active tab keeps being painted
        // (needed for screenshots) and the user's window and focus stay as they are.
        const tab = (await chrome.windows.create({ url: 'about:blank', focused: false })).tabs[0];
        s.groupId = await chrome.tabs.group({ tabIds: tab.id });
        await chrome.tabGroups.update(s.groupId, { title: s.label, color: s.color, collapsed: false });
        tabs = [tab];
      }
      await saveSessions();
    }
    return text({ group: s.label, tabs: tabs.map(tabInfo), note: tabs.length ? undefined : 'No tabs yet. Call again with createIfEmpty: true.' });
  },

  async navigate(s, { tabId, url }) {
    await ownedTab(s, tabId);
    const target = await checkUrl(url);
    return withTab(tabId, async () => {
      const loaded = waitForLoad(tabId);
      await chrome.tabs.update(tabId, { url: target.href });
      await loaded;
      const tab = await chrome.tabs.get(tabId);
      // A redirect may have landed somewhere the policy forbids.
      try { await checkUrl(tab.url || target.href); } catch (err) {
        await chrome.tabs.update(tabId, { url: 'about:blank' });
        throw err;
      }
      return text(tabInfo(tab));
    });
  },

  async screenshot(s, { tabId }) {
    let tab = await ownedTab(s, tabId);
    await checkUrl(tab.url);
    // Each step is recorded so a stuck capture says where it stuck, instead of
    // the caller just timing out.
    const steps = [];
    const step = (name) => steps.push(`${name}@${Date.now() - t0}ms`);
    const t0 = Date.now();
    const work = withTab(tabId, async () => {
      // Chrome doesn't paint tabs that aren't showing, and capturing one gives a
      // tiled image or hangs. Make it the active tab of its window (the session's
      // own window, so the user's focus is untouched).
      if (!tab.active) { await chrome.tabs.update(tabId, { active: true }); tab = await chrome.tabs.get(tabId); }
      const win = await chrome.windows.get(tab.windowId);
      step(`window:${win.state}${win.focused ? ',focused' : ''}`);
      return withDebugger(tabId, async (cdp) => {
        step('attached');
        await new Promise((r) => setTimeout(r, 300)); // let the page settle after attach
        const page = (await cdp('Runtime.evaluate', { expression: '({ v: document.visibilityState, dpr: devicePixelRatio })', returnByValue: true })).result?.value || {};
        const dpr = page.dpr || 1;
        step(`visibility:${page.v}`);
        const { cssVisualViewport: vv } = await cdp('Page.getLayoutMetrics');
        step('metrics');
        // One image pixel = one CSS pixel (clicks use CSS pixels), shrunk further
        // if the viewport is larger than models handle well. Chrome scales and
        // encodes; doing it here (PNG decode + canvas) is far slower.
        const fit = Math.min(1, MAX_EDGE / Math.max(vv.clientWidth, vv.clientHeight));
        const clip = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale: fit / dpr };
        const opts = { format: 'jpeg', clip, fromSurface: true, captureBeyondViewport: false };
        // A throwaway capture first makes the compositor produce a fresh frame.
        await timeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { ...opts, quality: 10 }), 5000, 'warm-up')
          .then(() => step('warm-up'), () => step('warm-up-timeout'));
        let data;
        for (let quality = 80; quality >= 30; quality -= 15) {
          ({ data } = await cdp('Page.captureScreenshot', { ...opts, quality }));
          if (data.length <= MAX_IMAGE_B64) break;
        }
        if (data.length > MAX_IMAGE_B64) throw new Error('screenshot too large to send');
        step('captured');
        const note = fit < 1
          ? `Viewport ${Math.round(vv.clientWidth)}x${Math.round(vv.clientHeight)} CSS px, image scaled by ${fit.toFixed(3)}: divide image coordinates by that to get CSS px.`
          : `Viewport ${Math.round(vv.clientWidth)}x${Math.round(vv.clientHeight)} CSS px; image pixels = CSS pixels.`;
        const slow = Date.now() - t0 > 5000 ? ` (slow capture: ${steps.join(' → ')})` : '';
        return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: note + slow }] };
      });
    });
    const stuck = new Promise((resolve) => setTimeout(() => resolve({
      isError: true,
      content: [{ type: 'text', text: `Screenshot did not finish in 40s. Steps: ${steps.join(' → ') || 'none'}. The tab's window may be minimized or hidden; Chrome doesn't paint hidden pages.` }],
    }), 40_000));
    return Promise.race([work, stuck]);
  },

  async read_page(s, { tabId, filter = 'all', max_chars = 50_000 }) {
    const tab = await ownedTab(s, tabId);
    await checkUrl(tab.url);
    if (tab.url === 'about:blank') return text('about:blank (empty page)');
    const target = { tabId };
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target,
      func: (opts) => globalThis.__controlC.readPage(opts),
      args: [{ filter: filter === 'interactive' ? 'interactive' : 'all', maxChars: Math.min(Number(max_chars) || 50_000, 200_000) }],
    });
    return text(result);
  },
};
