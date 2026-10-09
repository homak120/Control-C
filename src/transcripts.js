// Discover Claude Code session transcripts and follow them as they grow.
//
// Layout: ~/.claude/projects/<project-dir>/<session-id>.jsonl
// Only top-level session files are followed live. Subagent transcripts live in
// <session-id>/subagents/agent-<id>.jsonl and are read on request.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { normalizeLine, sessionSummary, subagentSummary } from './normalize.js';

const DEBOUNCE_MS = 40;
const POLL_MS = 2000;
const RESCAN_MS = 5000;
const TAIL_BYTES = 256;
const SESSION_FILE = /^[^/\\]+[/\\][^/\\]+\.jsonl$/;
const SUBAGENT_FILE = /^agent-([\w-]+)\.jsonl$/;
const AGENT_ID = /^[\w-]+$/;

/** Read a transcript file from scratch: items, metadata and line count. */
async function readTranscript(file, opts) {
  const text = await fsp.readFile(file, 'utf8');
  const meta = {};
  const items = [];
  let line = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    line++;
    try { items.push(...normalizeLine(JSON.parse(raw), line, meta, opts)); } catch { /* skip bad line */ }
  }
  return { items, meta, lineNo: line, bytes: Buffer.byteLength(text) };
}

export class SessionStore extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.sessions = new Map(); // id -> session record
    this.timers = new Map();
  }

  list() {
    return [...this.sessions.values()].map(sessionSummary).sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  }

  get(id) {
    return this.sessions.get(id);
  }

  async start() {
    await this.scan(true);
    try {
      fs.watch(this.root, { recursive: true }, (_, rel) => {
        if (rel && SESSION_FILE.test(rel)) this.schedule(path.join(this.root, rel));
      });
    } catch (err) {
      console.warn('recursive fs.watch unavailable, relying on polling:', err.message);
    }
    setInterval(() => { for (const s of this.sessions.values()) this.schedule(s.file); }, POLL_MS).unref();
    setInterval(() => this.scan(false).catch(() => {}), RESCAN_MS).unref();
  }

  async scan(initial) {
    let dirs = [];
    try { dirs = await fsp.readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let files = [];
      try { files = await fsp.readdir(path.join(this.root, dir.name)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(this.root, dir.name, f);
        if (!this.byFile(file)) await this.add(file, dir.name, initial);
      }
    }
  }

  byFile(file) {
    return this.sessions.get(path.basename(file, '.jsonl'));
  }

  newRecord(file, projectDir) {
    return { id: path.basename(file, '.jsonl'), file, projectDir, offset: 0, lineNo: 0, partial: '', meta: {}, ino: null, mtimeMs: 0, tail: '' };
  }

  async add(file, projectDir, initial) {
    const s = this.newRecord(file, projectDir);
    this.sessions.set(s.id, s);
    await this.readNew(s, { silent: true });
    if (!initial) this.emit('session', { type: 'new', summary: sessionSummary(s) });
  }

  schedule(file) {
    let s = this.byFile(file);
    if (!s) {
      if (!fs.existsSync(file)) return;
      const projectDir = path.basename(path.dirname(file));
      s = this.newRecord(file, projectDir);
      this.sessions.set(s.id, s);
      this.emit('session', { type: 'new', summary: sessionSummary(s) });
    }
    clearTimeout(this.timers.get(s.id));
    this.timers.set(s.id, setTimeout(() => this.readNew(s).catch((e) => console.warn(s.id, e.message)), DEBOUNCE_MS));
  }

  async fingerprint(file, end) {
    if (end === 0) return '';
    const fh = await fsp.open(file, 'r');
    try {
      const start = Math.max(0, end - TAIL_BYTES);
      const b = Buffer.alloc(end - start);
      await fh.read(b, 0, b.length, start);
      return crypto.createHash('sha1').update(b).digest('hex');
    } finally { await fh.close(); }
  }

  async readNew(s, { silent = false } = {}) {
    let st;
    try { st = await fsp.stat(s.file); } catch { return; }
    if (st.ino === s.ino && st.size === s.offset && st.mtimeMs === s.mtimeMs) return; // nothing changed

    const replaced = s.ino !== null && st.ino !== s.ino;
    const rewritten = replaced || st.size < s.offset ||
      (s.offset > 0 && (await this.fingerprint(s.file, s.offset)) !== s.tail);
    if (rewritten) {
      Object.assign(s, { offset: 0, lineNo: 0, partial: '', meta: {} });
      if (!silent) this.emit('session', { type: 'reset', id: s.id });
    }
    s.ino = st.ino;
    if (st.size === s.offset) { s.mtimeMs = st.mtimeMs; return; }

    const fh = await fsp.open(s.file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(st.size - s.offset);
      await fh.read(buf, 0, buf.length, s.offset);
    } finally { await fh.close(); }
    const startOffset = s.offset;
    s.offset = st.size;
    s.mtimeMs = st.mtimeMs;
    s.tail = await this.fingerprint(s.file, s.offset);

    const pieces = (s.partial + buf.toString('utf8')).split('\n');
    s.partial = pieces.pop(); // wait for the rest of an unterminated line
    const items = [];
    let lines = 0;
    for (const raw of pieces) {
      if (!raw.trim()) continue;
      s.lineNo++;
      lines++;
      let d;
      try { d = JSON.parse(raw); } catch { continue; }
      const out = normalizeLine(d, s.lineNo, s.meta);
      if (!silent) items.push(...out);
    }
    if (silent || !lines) return;
    this.emit('append', {
      id: s.id,
      update: { lines, firstLine: s.lineNo - lines + 1, lastLine: s.lineNo, bytes: buf.length, offset: startOffset, kind: lines === 1 ? 'single' : 'multi' },
      items,
      summary: sessionSummary(s),
    });
  }

  /** Full normalized history of one session (read fresh from disk). */
  async items(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return (await readTranscript(s.file)).items;
  }

  subagentDir(id) {
    const s = this.sessions.get(id);
    return s ? path.join(path.dirname(s.file), s.id, 'subagents') : null;
  }

  /** Subagents a session started, oldest first (read fresh from disk). */
  async subagents(id) {
    const dir = this.subagentDir(id);
    if (!dir) return null;
    let files = [];
    try { files = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const f of files) {
      const agentId = f.match(SUBAGENT_FILE)?.[1];
      if (!agentId) continue;
      const t = await readTranscript(path.join(dir, f), { sidechain: true }).catch(() => null);
      if (!t) continue;
      const metaFile = await fsp.readFile(path.join(dir, `agent-${agentId}.meta.json`), 'utf8').then(JSON.parse).catch(() => null);
      out.push(subagentSummary(agentId, metaFile, t));
    }
    return out.sort((a, b) => (a.firstTs || '').localeCompare(b.firstTs || ''));
  }

  /** Full normalized history of one subagent, or null if there's no such subagent. */
  async subagentItems(id, agentId) {
    const dir = this.subagentDir(id);
    if (!dir || !AGENT_ID.test(agentId)) return null;
    const t = await readTranscript(path.join(dir, `agent-${agentId}.jsonl`), { sidechain: true }).catch(() => null);
    return t ? t.items : null;
  }

  /** Raw JSON text of one transcript line (1-based, blank lines skipped). */
  async rawLine(id, n) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const text = await fsp.readFile(s.file, 'utf8');
    let line = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      if (++line === n) return raw;
    }
    return null;
  }
}
