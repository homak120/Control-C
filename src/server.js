// Control-C hub: a localhost-only HTTP server that serves the dashboard,
// a JSON API, a Server-Sent Events stream, and the Claude Code hook receiver.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, CLAUDE_PROJECTS_DIR, TOKEN_FILE, loadToken } from './config.js';
import { SessionStore } from './transcripts.js';
import { HookHub } from './hooks.js';
import { sessionSummary } from './normalize.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'control_c_token';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_HOOK_BODY = 1024 * 1024;

const token = loadToken();
const store = new SessionStore(CLAUDE_PROJECTS_DIR);
const hooks = new HookHub();
const clients = new Set();

// ---- auth --------------------------------------------------------------------

const safeEqual = (a, b) => {
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
      if (size > MAX_HOOK_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, { error: 'not found' });
  try {
    const body = await fsp.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
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
    const event = hooks.receive(payload);
    // A hook usually means the transcript just changed; read it now instead of waiting for fs events.
    if (event?.transcriptPath) {
      const rel = path.relative(CLAUDE_PROJECTS_DIR, path.resolve(event.transcriptPath));
      if (/^[^/\\.][^/\\]*[/\\][^/\\]+\.jsonl$/.test(rel)) store.schedule(path.join(CLAUDE_PROJECTS_DIR, rel));
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

  if (p === '/') return serveStatic(res, 'index.html');
  if (/^\/[\w.-]+\.(js|css|svg)$/.test(p)) return serveStatic(res, p.slice(1));

  if (p === '/api/sessions') {
    return send(res, 200, { sessions: store.list(), live: hooks.states(), hooksSeen: hooks.events.length > 0 });
  }

  let m;
  if ((m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
    const s = store.get(m[1]);
    if (!s) return send(res, 404, { error: 'unknown session' });
    const items = await store.items(m[1]);
    return send(res, 200, { summary: sessionSummary(s), live: hooks.live.get(m[1]) || null, items });
  }

  if ((m = p.match(/^\/api\/sessions\/([\w-]+)\/lines\/(\d+)$/))) {
    const raw = await store.rawLine(m[1], Number(m[2]));
    return raw == null ? send(res, 404, { error: 'no such line' }) : send(res, 200, raw, 'text/plain; charset=utf-8');
  }

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

// ---- wiring ------------------------------------------------------------------

store.on('append', (data) => broadcast('append', data));
store.on('session', (data) => broadcast('session', data));
hooks.on('hook', (data) => broadcast('hook', data));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

const t0 = Date.now();
await store.start();
const server = http.createServer((req, res) => handle(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) send(res, 500, { error: 'internal error' });
}));
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
