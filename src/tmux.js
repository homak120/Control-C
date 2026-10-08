// Talk to the dedicated Control-C tmux server: list panes, stream their output,
// and type into them.
//
// Sessions launched by `ctrlc` run on their own tmux socket (-L control-c), so
// your personal tmux setup is never touched. For each tmux session the hub keeps
// one control-mode client (`tmux -C attach`), which streams `%output` for every
// pane and accepts commands such as send-keys on stdin. The client attaches with
// `ignore-size`, so it never shrinks the window you're looking at in Terminal.

import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

export const SOCKET = process.env.CONTROL_C_TMUX_SOCKET || 'control-c';
export const TMUX_CONF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmux.conf');
const POLL_MS = 1500;
const PANE_FORMAT = ['#{session_name}', '#{pane_id}', '#{pane_current_path}', '#{pane_pid}', '#{pane_width}', '#{pane_height}',
  '#{pane_current_command}', '#{pane_dead}', '#{session_created}', '#{session_attached}', '#{pane_start_command}'].join('\t');

export function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCKET, '-f', TMUX_CONF, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
    });
  });
}

// %output data escapes bytes below 0x20 and backslash as \ooo octal; all other
// bytes are passed through raw. Work on bytes so split UTF-8 sequences survive.
const isOct = (b) => b >= 0x30 && b <= 0x37;
function decodeOutput(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x5c && isOct(buf[i + 1]) && isOct(buf[i + 2]) && isOct(buf[i + 3])) {
      out[n++] = (buf[i + 1] - 0x30) * 64 + (buf[i + 2] - 0x30) * 8 + (buf[i + 3] - 0x30);
      i += 3;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

export class TmuxManager extends EventEmitter {
  constructor() {
    super();
    this.panes = new Map();   // pane id (%3) -> pane info
    this.clients = new Map(); // session name -> control-mode child process
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), POLL_MS).unref();
  }

  list() {
    return [...this.panes.values()];
  }

  async refresh() {
    let out = '';
    try {
      out = await tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
    } catch {
      out = ''; // no server running = no panes
    }
    const seen = new Set();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [session, id, cwd, pid, width, height, command, dead, created, attached] = line.split('\t');
      seen.add(id);
      const pane = {
        id, session, cwd, pid: Number(pid), cols: Number(width), rows: Number(height), command,
        dead: dead === '1', createdAt: new Date(Number(created) * 1000).toISOString(), attached: Number(attached),
      };
      const prev = this.panes.get(id);
      this.panes.set(id, { ...prev, ...pane });
      if (!prev) this.emit('pane', { type: 'added', pane: this.panes.get(id) });
      else if (prev.cols !== pane.cols || prev.rows !== pane.rows) this.emit('pane', { type: 'resized', pane: this.panes.get(id) });
      else if (prev.dead !== pane.dead || prev.attached !== pane.attached || prev.cwd !== pane.cwd) this.emit('pane', { type: 'changed', pane: this.panes.get(id) });
      this.ensureClient(session);
    }
    for (const id of [...this.panes.keys()]) {
      if (!seen.has(id)) {
        const pane = this.panes.get(id);
        this.panes.delete(id);
        this.emit('pane', { type: 'removed', pane });
      }
    }
  }

  ensureClient(session) {
    if (this.clients.has(session)) return;
    const child = spawn('tmux', ['-L', SOCKET, '-f', TMUX_CONF, '-C', 'attach', '-t', session, '-f', 'ignore-size'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.clients.set(session, child);
    let buf = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (line.subarray(0, 8).toString() === '%output ') {
          const sp = line.indexOf(0x20, 8);
          this.emit('output', { paneId: line.subarray(8, sp).toString(), data: decodeOutput(line.subarray(sp + 1)) });
        } else {
          const head = line.subarray(0, 24).toString();
          if (head.startsWith('%layout-change') || head.startsWith('%window-pane-changed')) this.refresh();
        }
      }
    });
    const drop = () => { if (this.clients.get(session) === child) this.clients.delete(session); };
    child.on('exit', drop);
    child.on('error', drop);
    child.stdin.on('error', () => {});
  }

  /** Current screen with colors, plus the cursor position, for a fresh viewer. */
  async snapshot(paneId) {
    const [screen, cursor] = await Promise.all([
      tmux(['capture-pane', '-p', '-e', '-N', '-t', paneId]),
      tmux(['display-message', '-p', '-t', paneId, '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}']),
    ]);
    const [x, y, cols, rows] = cursor.trim().split(' ').map(Number);
    return { screen: screen.replace(/\n$/, '').split('\n').join('\r\n'), cursor: { x, y }, cols, rows };
  }

  /** Type raw terminal input (as produced by xterm.js) into a pane. */
  sendInput(paneId, data) {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    const child = this.clients.get(pane.session);
    const hex = [...Buffer.from(data, 'utf8')].map((b) => b.toString(16));
    // send-keys -H takes bytes as hex, so any key, escape sequence or Unicode text gets through intact.
    for (let i = 0; i < hex.length; i += 256) {
      const cmd = `send-keys -t ${paneId} -H ${hex.slice(i, i + 256).join(' ')}`;
      if (child?.stdin.writable) child.stdin.write(cmd + '\n');
      else tmux(cmd.split(' ')).catch(() => {});
    }
    return true;
  }

  /**
   * Let a browser size the window, but only while no real terminal is attached;
   * once you attach from Terminal, your window decides the size.
   */
  async resizeForViewer(paneId, cols, rows) {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    const clients = await tmux(['list-clients', '-t', pane.session, '-F', '#{client_control_mode}']).catch(() => '');
    if (clients.split('\n').some((c) => c.trim() === '0')) return false;
    if (pane.cols === cols && pane.rows === rows) return false;
    await tmux(['resize-window', '-t', pane.session, '-x', String(cols), '-y', String(rows)]);
    // resize-window switches the window to manual sizing; go back so a real terminal can take over later.
    await tmux(['set-option', '-w', '-t', pane.session, 'window-size', 'latest']);
    await this.refresh();
    return true;
  }

  /** Start Claude Code in a new detached tmux session. */
  async launch({ cwd, name, args = [], settingsFile }) {
    const session = name || `${path.basename(cwd).replace(/[^\w-]/g, '-')}-${Date.now().toString(36).slice(-4)}`;
    const claudeArgs = ['claude', ...(settingsFile ? ['--settings', settingsFile] : []), ...args];
    await tmux(['new-session', '-d', '-s', session, '-c', cwd, '-x', '160', '-y', '45', ...claudeArgs]);
    await this.refresh();
    return session;
  }
}
