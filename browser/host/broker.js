#!/usr/bin/env node
// The native-messaging host: Chrome starts one per browser when the extension
// connects, and it owns a Unix socket that any number of agents can join.
//
//   extension ⇄ (stdio, length-prefixed JSON) ⇄ broker ⇄ (socket, same framing) ⇄ clients
//
// Each client gets its own session (the extension gives it its own tab group),
// and every result goes back only to the client that asked — never broadcast.
// A call that is in flight when the link drops is failed, never replayed: the
// action may already have happened (a replayed click is a double click).

import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encode, FrameReader } from './framing.js';
import { EXTENSION_ORIGIN, SOCKET_DIR, infoPath, socketPath } from './paths.js';

const SESSION_ID = /^[\w-]{16,64}$/;
const TOOL_NAME = /^[a-z][a-z_]{0,63}$/;

/**
 * Prepare the socket folder: ours, a real folder, and 0700. Refuse anything else,
 * because a folder another user controls could swap in their own socket.
 */
export function prepareDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

export function createBroker({
  input, output, dir = SOCKET_DIR, pid = process.pid,
  heartbeatMs = 15000, silenceMs = 60000, helloMs = 2000,
  log = () => {}, onExit = () => {},
}) {
  prepareDir(dir);
  const sockFile = socketPath(pid, dir);
  const infoFile = infoPath(pid, dir);
  fs.rmSync(sockFile, { force: true });

  const clients = new Map(); // clientId -> { sock, sessionId, name, kind, meta, inflight:Set }
  let nextClient = 1;
  let ext = null;            // what the extension said in ext_hello
  let lastSeen = Date.now();
  let closed = false;

  const toExt = (msg) => {
    try { output.write(encode(msg)); return true; } catch (err) { log(`to extension: ${err.message}`); return false; }
  };
  const toClient = (c, msg) => { if (!c.sock.destroyed) c.sock.write(encode(msg)); };

  // --- browser side -------------------------------------------------------
  const extReader = new FrameReader((msg) => {
    lastSeen = Date.now();
    switch (msg?.type) {
      case 'ext_hello':
        ext = { browser: String(msg.browser || 'unknown'), extVersion: String(msg.extVersion || '') };
        fs.writeFileSync(infoFile, JSON.stringify({ pid, socket: sockFile, ...ext, startedAt: Date.now() }), { mode: 0o600 });
        // Sessions opened before the extension (re)announced itself need their groups back.
        for (const c of clients.values()) toExt({ type: 'session_open', sessionId: c.sessionId, label: c.name });
        break;
      case 'ping': toExt({ type: 'pong', t: msg.t }); break;
      case 'tool_result': {
        const [cid, ...rest] = String(msg.id).split(':');
        const c = clients.get(cid);
        const id = rest.join(':');
        if (!c || !c.inflight.delete(id)) return; // caller gone, or not its call
        toClient(c, { type: 'result', id: c.ids.get(id), content: msg.content || [], isError: !!msg.isError });
        c.ids.delete(id);
        break;
      }
      case 'event':
        for (const c of clients.values()) if (c.sessionId === msg.sessionId) toClient(c, msg);
        break;
    }
  }, (err) => { log(`extension stream: ${err.message}`); shutdown(); });
  input.on('data', (d) => extReader.push(d));
  input.on('end', () => shutdown());
  input.on('error', () => shutdown());

  // --- client side --------------------------------------------------------
  const server = net.createServer((sock) => {
    const c = { sock, id: String(nextClient++), sessionId: null, inflight: new Set(), ids: new Map() };
    const helloTimer = setTimeout(() => { if (!c.sessionId) sock.destroy(); }, helloMs);
    const reader = new FrameReader((msg) => onClient(c, msg), () => sock.destroy());
    sock.on('data', (d) => reader.push(d));
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(helloTimer);
      if (!c.sessionId) return;
      clients.delete(c.id);
      toExt({ type: 'session_close', sessionId: c.sessionId });
    });
  });

  function onClient(c, msg) {
    if (!c.sessionId) {
      if (msg?.type !== 'hello') return c.sock.destroy();
      const inUse = (s) => [...clients.values()].some((o) => o.sessionId === s);
      // A client may resume its earlier session (and so its tab group) after a
      // reconnect. The id is a random secret, so knowing it is the permission.
      c.sessionId = SESSION_ID.test(msg.resume) && !inUse(msg.resume) ? msg.resume : crypto.randomBytes(16).toString('base64url');
      c.name = String(msg.client?.name || 'client').slice(0, 40);
      c.kind = String(msg.client?.kind || 'script').slice(0, 20);
      c.meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
      clients.set(c.id, c);
      toClient(c, { type: 'welcome', clientId: c.id, sessionId: c.sessionId, browser: ext });
      toExt({ type: 'session_open', sessionId: c.sessionId, label: c.name });
      return;
    }
    if (msg?.type !== 'call') return;
    const reply = (text) => toClient(c, { type: 'result', id: msg.id, content: [{ type: 'text', text }], isError: true });
    if (!TOOL_NAME.test(msg.tool || '')) return reply('invalid tool name');
    // Our own id, so a client can't pick one that collides with another client's.
    const id = crypto.randomBytes(6).toString('hex');
    c.inflight.add(id);
    c.ids.set(id, msg.id);
    const ok = toExt({ type: 'tool_request', id: `${c.id}:${id}`, sessionId: c.sessionId, tool: msg.tool, args: msg.args || {} });
    if (!ok) { c.inflight.delete(id); c.ids.delete(id); reply('request too large for the browser link (1 MiB)'); }
  }

  // Resolves once the socket is 0600. (The 0700 folder already keeps other users out.)
  const ready = new Promise((resolve) => server.listen(sockFile, () => {
    fs.chmodSync(sockFile, 0o600);
    log(`listening on ${sockFile}`);
    resolve();
  }));

  const beat = setInterval(() => {
    if (Date.now() - lastSeen > silenceMs) { log('extension silent, exiting'); return shutdown(); }
    toExt({ type: 'ping', t: Date.now() });
  }, heartbeatMs);

  function shutdown() {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    for (const c of clients.values()) {
      toClient(c, { type: 'link_lost', inFlight: [...c.inflight].map((i) => c.ids.get(i)) });
      c.sock.end();
    }
    clients.clear();
    server.close();
    fs.rmSync(sockFile, { force: true });
    fs.rmSync(infoFile, { force: true });
    onExit();
  }

  return { socket: sockFile, info: infoFile, ready, clients, close: shutdown };
}

// Run as the native host. Chrome passes the calling extension's origin as the
// first argument; refuse to serve anyone else's.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const log = (m) => process.stderr.write(`[control-c broker] ${m}\n`);
  if (process.argv[2] !== EXTENSION_ORIGIN) {
    log(`refusing caller ${process.argv[2] || '(none)'}`);
    process.exit(1);
  }
  createBroker({ input: process.stdin, output: process.stdout, log, onExit: () => setTimeout(() => process.exit(0), 50) });
}
