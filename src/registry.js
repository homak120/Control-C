// Claude Code's own list of running sessions: ~/.claude/sessions/<pid>.json.
//
// Each running Claude process keeps one file there with its session id, folder
// and, inside tmux, its pane ("<tmux session>:@<window>.%<pane>"). That links a
// pane to its session exactly, without hooks. The file is internal and
// undocumented, so every assumption about it lives here, and anything unexpected
// just means "unknown". Only the *.json files are read; the .key files next to
// them hold secrets and are never opened.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const POLL_MS = 2000;
const ENTRY_FILE = /^\d+\.json$/;
const PANE_REF = /^(.+):@\d+\.(%\d+)$/;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

/** Parse one registry file; returns null unless it has the fields we rely on. */
export function parseEntry(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!Number.isInteger(d?.pid) || typeof d.sessionId !== 'string' || !/^[\w-]+$/.test(d.sessionId)) return null;
  const pane = typeof d.tmux === 'string' ? d.tmux.match(PANE_REF) : null;
  return {
    pid: d.pid,
    sessionId: d.sessionId,
    cwd: typeof d.cwd === 'string' ? d.cwd : null,
    tmuxSession: pane?.[1] ?? null,
    pane: pane?.[2] ?? null,
    status: typeof d.status === 'string' ? d.status : null,
  };
}

export class SessionRegistry extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.entries = []; // live processes only
    this.sig = '';
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), POLL_MS).unref();
  }

  async refresh() {
    let files = [];
    try { files = (await fsp.readdir(this.dir)).filter((f) => ENTRY_FILE.test(f)); } catch { files = []; }
    const entries = [];
    for (const f of files) {
      const e = parseEntry(await fsp.readFile(path.join(this.dir, f), 'utf8').catch(() => ''));
      // Files from crashed processes can linger; only trust ones whose process still runs.
      if (e && alive(e.pid)) entries.push(e);
    }
    this.entries = entries;
    const sig = JSON.stringify(entries.map((e) => [e.pid, e.sessionId, e.tmuxSession, e.pane]));
    if (sig !== this.sig) { this.sig = sig; this.emit('change'); }
  }

  /** The session running in a pane of Control-C's tmux server, if Claude reported it. */
  forPane(pane) {
    return this.entries.find((e) => e.pane === pane.id && e.tmuxSession === pane.session) || null;
  }
}
