// Client side of the broker socket, shared by the MCP shim, scripts and (later)
// the Control-C hub.
//
//   const b = await connect({ name: 'my-script' });
//   const r = await b.call('tabs_context', { createIfEmpty: true });

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { encode, FrameReader } from './framing.js';
import { SOCKET_DIR } from './paths.js';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

/** Running brokers (one per browser), newest first. Stale files are ignored. */
export function listBrokers(dir = SOCKET_DIR) {
  let names = [];
  try {
    // Same checks as the broker: never trust a folder another user could control.
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) return [];
    names = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch { return []; }
  const out = [];
  for (const f of names) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Number.isInteger(info.pid) && alive(info.pid) && fs.existsSync(info.socket)) out.push(info);
    } catch { /* half-written or garbage: skip */ }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export class BrokerClient extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.nextId = 1;
    this.welcome = null;
    const reader = new FrameReader((m) => this.onMessage(m), (err) => sock.destroy(err));
    sock.on('data', (d) => reader.push(d));
    sock.on('error', () => {});
    sock.on('close', () => this.failAll('browser link closed'));
  }

  onMessage(m) {
    if (m.type === 'welcome') { this.welcome = m; this.emit('welcome', m); return; }
    if (m.type === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve({ content: m.content, isError: m.isError });
      return;
    }
    if (m.type === 'link_lost') return this.failAll('browser link lost');
    if (m.type === 'event') this.emit('event', m);
  }

  // No retries: a call that was sent may already have taken effect.
  failAll(why) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ isError: true, content: [{ type: 'text', text: `${why}. The action may already have taken effect; check the page state before retrying.` }] });
    }
    this.pending.clear();
    this.emit('closed');
  }

  call(tool, args = {}, { timeoutMs = 60000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ isError: true, content: [{ type: 'text', text: `timed out after ${timeoutMs / 1000}s; the action may still complete` }] });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(encode({ type: 'call', id, tool, args }));
    });
  }

  get closed() { return this.sock.destroyed; }
  close() { this.sock.end(); }
}

/**
 * Connect to a broker and register. `socket` picks one explicitly; otherwise the
 * newest running browser is used.
 */
export function connect({ name, kind = 'script', meta = {}, resume, socket, dir } = {}) {
  const target = socket || listBrokers(dir)[0]?.socket;
  if (!target) return Promise.reject(new Error('No browser connected. Is the Control-C extension installed and the browser running?'));
  return new Promise((resolve, reject) => {
    const sock = net.connect(target);
    const client = new BrokerClient(sock);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('broker did not answer')); }, 3000);
    sock.once('error', (err) => { clearTimeout(timer); reject(err); });
    sock.once('connect', () => {
      sock.write(encode({ type: 'hello', v: 1, client: { name, kind }, meta: { pid: process.pid, ppid: process.ppid, cwd: process.cwd(), ...meta }, resume }));
    });
    client.once('welcome', () => { clearTimeout(timer); resolve(client); });
  });
}
