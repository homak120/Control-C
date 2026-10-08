#!/usr/bin/env node
// ctrlc — start Claude Code inside Control-C's tmux so the dashboard can mirror it.
//
//   ctrlc [folder] [-- claude args…]   start Claude Code in folder (default: here) and attach
//   ctrlc ls                           list Control-C sessions
//   ctrlc attach [name]                re-attach (default: most recent)
//   ctrlc kill <name>                  end a session
//
// Detach with Ctrl+B then D: Claude keeps running and the dashboard keeps showing it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SOCKET, TMUX_CONF } from '../src/tmux.js';

const base = ['-L', SOCKET, '-f', TMUX_CONF];
const run = (args, opts = {}) => spawnSync('tmux', [...base, ...args], { encoding: 'utf8', ...opts });

// Attaching from inside another tmux needs TMUX unset; our server is separate anyway.
function attach(name) {
  const env = { ...process.env };
  delete env.TMUX;
  const r = spawnSync('tmux', [...base, 'attach', '-t', name], { stdio: 'inherit', env });
  process.exit(r.status ?? 0);
}

function sessions() {
  const r = run(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_path}']);
  if (r.status !== 0) return [];
  // The dashboard's own control-mode connection doesn't count as "attached".
  const viewers = new Map();
  for (const l of (run(['list-clients', '-F', '#{session_name}\t#{client_control_mode}']).stdout || '').split('\n')) {
    const [name, control] = l.split('\t');
    if (name && control === '0') viewers.set(name, (viewers.get(name) || 0) + 1);
  }
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [name, created, , cwd] = l.split('\t');
    return { name, created: Number(created), attached: viewers.get(name) || 0, cwd };
  }).sort((a, b) => b.created - a.created);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'ls' || cmd === 'list') {
  const list = sessions();
  if (!list.length) console.log('No Control-C sessions running.');
  for (const s of list) {
    console.log(`${s.name.padEnd(32)} ${s.attached ? 'attached' : 'detached'}  ${new Date(s.created * 1000).toLocaleString()}  ${s.cwd}`);
  }
} else if (cmd === 'attach' || cmd === 'a') {
  const name = argv[1] || sessions()[0]?.name;
  if (!name) { console.error('No Control-C sessions running.'); process.exit(1); }
  attach(name);
} else if (cmd === 'kill') {
  if (!argv[1]) { console.error('usage: ctrlc kill <name>'); process.exit(1); }
  process.exit(run(['kill-session', '-t', argv[1]], { stdio: 'inherit' }).status ?? 1);
} else if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
} else {
  const sep = argv.indexOf('--');
  const folderArg = sep === 0 ? undefined : argv[0];
  const claudeArgs = sep >= 0 ? argv.slice(sep + 1) : argv.slice(1);
  const cwd = path.resolve(folderArg || '.');
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) { console.error(`Not a folder: ${cwd}`); process.exit(1); }

  const name = `${path.basename(cwd).replace(/[^\w-]/g, '-')}-${Date.now().toString(36).slice(-4)}`;
  const r = run(['new-session', '-d', '-s', name, '-c', cwd, 'claude', ...claudeArgs], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`Started ${name}. Detach with Ctrl+B then D; re-attach with: ctrlc attach ${name}`);
  attach(name);
}
