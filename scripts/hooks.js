#!/usr/bin/env node
// Add or remove the Control-C hooks in ~/.claude/settings.json.
//
//   node scripts/hooks.js              print the hook config (changes nothing)
//   node scripts/hooks.js --install    back up settings.json, then add the hooks
//   node scripts/hooks.js --uninstall  back up settings.json, then remove them
//
// Each hook pipes the event JSON to the hub with curl. It's silent and always
// exits 0, so Claude Code keeps working normally when the hub isn't running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PORT } from '../src/config.js';

const SETTINGS = process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const MARKER = '# control-c';
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', ...TOOL_EVENTS, 'Notification', 'Stop', 'SubagentStop', 'PreCompact'];

const command =
  `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' ` +
  `-H "X-Control-C-Token: $(cat "$HOME/.control-c/token" 2>/dev/null)" ` +
  `--data-binary @- http://127.0.0.1:${PORT}/api/hooks >/dev/null 2>&1 || true ${MARKER}`;

const entry = (event) => ({
  ...(TOOL_EVENTS.includes(event) ? { matcher: '*' } : {}),
  hooks: [{ type: 'command', command, timeout: 5 }],
});

const isOurs = (group) => group?.hooks?.some((h) => h.command?.includes(MARKER));

function strip(settings) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].filter((g) => !isOurs(g));
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

function writeSettings(settings) {
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(SETTINGS, backup);
    console.log(`backup  ${backup}`);
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`wrote   ${SETTINGS}`);
}

const mode = process.argv[2];
if (mode === '--install') {
  const settings = strip(readSettings());
  settings.hooks ??= {};
  for (const ev of EVENTS) (settings.hooks[ev] ??= []).push(entry(ev));
  writeSettings(settings);
  console.log(`installed Control-C hooks for: ${EVENTS.join(', ')}`);
  console.log('New Claude Code sessions pick this up; restart running sessions (or run /hooks) to load it.');
} else if (mode === '--uninstall') {
  writeSettings(strip(readSettings()));
  console.log('removed Control-C hooks');
} else {
  console.log(JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((ev) => [ev, [entry(ev)]])) }, null, 2));
  console.log(`\n(run with --install to merge this into ${SETTINGS})`);
}
