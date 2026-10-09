// Control-C hub: a localhost-only HTTP server that serves the dashboard,
// a JSON API, a Server-Sent Events stream, the Claude Code hook receiver,
// and a WebSocket that mirrors tmux terminals and types into them.

import http from 'node:http';

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { HOST, PORT, CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR, TOKEN_FILE, loadToken } from './config.js';
import { SessionStore } from './transcripts.js';
import { HookHub } from './hooks.js';
import { TmuxManager } from './tmux.js';
import { Linker } from './links.js';
import { SessionRegistry } from './registry.js';
import { sessionSummary } from './normalize.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR = {
  'xterm.js': path.join(ROOT, 'node_modules/@xterm/xterm/lib/xterm.js'),
  'xterm.css': path.join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css'),
};
const COOKIE = 'control_c_token';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 1024 * 1024;
// xterm.js adds its own <style> element, so inline styles are allowed; scripts stay strict.
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

const token = loadToken();
const store = new SessionStore(CLAUDE_PROJECTS_DIR);
const hooks = new HookHub();
const tmux = new TmuxManager();
const registry = new SessionRegistry(CLAUDE_SESSIONS_DIR);
const linker = new Linker(store, hooks, tmux, registry);
const clients = new Set();

// ---- auth --------------------------------------------------------------------

const safeEqual = (a) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(token);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const cookieToken = (req) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];

const authorized = (req) =>
  safeEqual(cookieToken(req)) ||
  safeEqual(req.headers['x-control-c-token']) ||
  safeEqual((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

// Reject requests whose Host isn't us, which blocks DNS-rebinding attacks from web pages.
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

// ---- helpers -----------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveFile(res, full) {
  try {
    const body = await fsp.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
    });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Control-C</title>
<body style="font:15px system-ui;padding:40px;max-width:560px;margin:auto">
<h1>Control-C is locked</h1><p>Open the link printed in the terminal where the hub is running.
It contains your access token (stored in <code>~/.control-c/token</code>).</p></body>`;

let terminalsSig = '';
function publishTerminals(force = false) {
  const terminals = linker.terminals();
  const sig = JSON.stringify(terminals.map((t) => [t.id, t.sessionId, t.dead, t.cols, t.rows, t.attached]));
  if (force || sig !== terminalsSig) {
    terminalsSig = sig;
    broadcast('terminals', { terminals });
  }
}

// ---- routes ------------------------------------------------------------------

async function handle(req, res) {
  if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // One-time login: /?token=… sets a cookie and redirects to a clean URL.
  if (p === '/' && url.searchParams.has('token')) {
    if (!safeEqual(url.searchParams.get('token'))) return send(res, 401, LOCKED_PAGE, 'text/html; charset=utf-8');
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      Location: '/',
    });
    return res.end();
  }

  if (!authorized(req)) {
    return p === '/' ? send(res, 401, LOCKED_PAGE, 'text/html; charset=utf-8') : send(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'POST' && p === '/api/hooks') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const event = hooks.receive(payload, {
      pane: /^%\d+$/.test(req.headers['x-control-c-pane'] || '') ? req.headers['x-control-c-pane'] : null,
      tmux: req.headers['x-control-c-tmux'] || null,
    });
    // A hook usually means the transcript just changed; read it now instead of waiting for fs events.
    if (event?.transcriptPath) {
      const rel = path.relative(CLAUDE_PROJECTS_DIR, path.resolve(event.transcriptPath));
      if (/^[^/\\.][^/\\]*[/\\][^/\\]+\.jsonl$/.test(rel)) store.schedule(path.join(CLAUDE_PROJECTS_DIR, rel));
    }
    if (linker.fromHook(event)) publishTerminals();
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && p === '/api/terminals') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const cwd = path.resolve(String(body.cwd || '').replace(/^~(?=$|\/)/, process.env.HOME));
    const st = await fsp.stat(cwd).catch(() => null);
    if (!st?.isDirectory()) return send(res, 400, { error: `not a folder: ${cwd}` });
    try {
      const session = await tmux.launch({ cwd });
      publishTerminals(true);
      const pane = tmux.list().find((x) => x.session === session);
      return send(res, 201, { session, paneId: pane?.id || null });
    } catch (err) {
      return send(res, 500, { error: `couldn't start tmux: ${err.stderr || err.message}` });
    }
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

  if (p === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (/^\/vendor\/[\w.-]+$/.test(p) && VENDOR[p.slice(8)]) return serveFile(res, VENDOR[p.slice(8)]);
  if (/^\/[\w.-]+\.(js|css|svg)$/.test(p)) return serveFile(res, path.join(PUBLIC_DIR, p.slice(1)));

  if (p === '/api/sessions') {
    return send(res, 200, { sessions: store.list(), live: hooks.states(), hooksSeen: hooks.events.length > 0, terminals: linker.terminals() });
  }

  let m;
  if ((m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
    const s = store.get(m[1]);
    if (!s) return send(res, 404, { error: 'unknown session' });
    const items = await store.items(m[1]);
    return send(res, 200, { summary: sessionSummary(s), live: hooks.live.get(m[1]) || null, items });
  }

  if ((m = p.match(/^\/api\/sessions\/([\w-]+)\/subagents$/))) {
    const subagents = await store.subagents(m[1]);
    return subagents ? send(res, 200, { subagents }) : send(res, 404, { error: 'unknown session' });
  }

  if ((m = p.match(/^\/api\/sessions\/([\w-]+)\/subagents\/([\w-]+)$/))) {
    const items = await store.subagentItems(m[1], m[2]);
    return items ? send(res, 200, { items }) : send(res, 404, { error: 'unknown subagent' });
  }

  if ((m = p.match(/^\/api\/sessions\/([\w-]+)\/lines\/(\d+)$/))) {
    const raw = await store.rawLine(m[1], Number(m[2]));
    return raw == null ? send(res, 404, { error: 'no such line' }) : send(res, 200, raw, 'text/plain; charset=utf-8');
  }

  if (p === '/api/terminals') return send(res, 200, { terminals: linker.terminals() });
  if (p === '/api/hooks') return send(res, 200, { events: hooks.events.slice(-200), live: hooks.states() });

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  send(res, 404, { error: 'not found' });
}

// ---- terminal WebSocket ------------------------------------------------------
// /ws/terminal?pane=3 → binary frames carry pane output; JSON frames carry
// snapshots ({type:'snapshot'}) and resizes. The browser sends {type:'input', data}.

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
const viewers = new Map(); // pane id -> Set<ws>

tmux.on('output', ({ paneId, data }) => {
  for (const ws of viewers.get(paneId) || []) if (ws.readyState === 1) ws.send(data, { binary: true });
});
tmux.on('pane', ({ type, pane }) => {
  if (type === 'resized') for (const ws of viewers.get(pane.id) || []) sendSnapshot(ws, pane.id);
  if (type === 'removed') for (const ws of viewers.get(pane.id) || []) ws.close(4404, 'pane closed');
  publishTerminals();
});

async function sendSnapshot(ws, paneId) {
  try {
    const snap = await tmux.snapshot(paneId);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'snapshot', ...snap }));
  } catch (err) {
    ws.close(4404, 'pane not found');
  }
}

function upgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const deny = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); socket.destroy(); };
  if (!allowedHosts.has(req.headers.host)) return deny(403, 'Forbidden');
  // Browsers always send Origin on WebSocket requests; refuse other sites (cross-site WebSocket hijacking).
  if (!allowedOrigins.has(req.headers.origin)) return deny(403, 'Forbidden');
  if (!authorized(req)) return deny(401, 'Unauthorized');
  if (url.pathname !== '/ws/terminal' || !/^\d+$/.test(url.searchParams.get('pane') || '')) return deny(404, 'Not Found');

  const paneId = `%${url.searchParams.get('pane')}`;
  if (!tmux.panes.has(paneId)) return deny(404, 'Not Found');

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!viewers.has(paneId)) viewers.set(paneId, new Set());
    viewers.get(paneId).add(ws);
    sendSnapshot(ws, paneId);
    ws.on('message', (msg, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(msg.toString()); } catch { return; }
      if (m.type === 'input' && typeof m.data === 'string' && m.data.length <= 100000) tmux.sendInput(paneId, m.data);
      if (m.type === 'refresh') sendSnapshot(ws, paneId);
      if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
        tmux.resizeForViewer(paneId, Math.max(40, Math.min(400, m.cols)), Math.max(10, Math.min(200, m.rows))).catch(() => {});
      }
    });
    ws.on('close', () => viewers.get(paneId)?.delete(ws));
  });
}

// ---- wiring ------------------------------------------------------------------

store.on('append', (data) => { broadcast('append', data); publishTerminals(); });
store.on('session', (data) => broadcast('session', data));
registry.on('change', () => publishTerminals());
hooks.on('hook', (data) => broadcast('hook', data));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

const t0 = Date.now();
await store.start();
tmux.start();
registry.start();
const server = http.createServer((req, res) => handle(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) send(res, 500, { error: 'internal error' });
}));
server.on('upgrade', upgrade);
server.listen(PORT, HOST, () => {
  console.log(`Control-C hub  ·  ${store.sessions.size} sessions loaded in ${Date.now() - t0} ms`);
  console.log(`  watching  ${CLAUDE_PROJECTS_DIR}`);
  console.log(`  token     ${TOKEN_FILE}`);
  console.log(`\n  Open:  http://${HOST}:${PORT}/?token=${token}\n`);
});
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Set PORT=… to pick another.` : err.message);
  process.exit(1);
});
