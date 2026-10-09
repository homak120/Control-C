// Pane ↔ session matching: hooks, then the registry, then the folder guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linker, runsClaude } from '../src/links.js';

const T0 = '2026-10-09T10:00:00.000Z';
const T1 = '2026-10-09T11:00:00.000Z';

const pane = (over = {}) => ({ id: '%0', session: 'demo', cwd: '/p', command: '2.1.295', dead: false, createdAt: T0, ...over });
const session = (id, over = {}) => ({ id, cwd: '/p', closed: false, lastTs: T1, ...over });

function linker({ panes = [pane()], sessions = [], registry = [] } = {}) {
  const reg = { entries: registry, forPane: (p) => registry.find((e) => e.pane === p.id && e.tmuxSession === p.session) || null };
  return new Linker({ list: () => sessions }, {}, { list: () => panes }, reg);
}
const links = (l) => l.terminals().map((t) => [t.id, t.sessionId, t.linkedBy]);

test('recognises Claude by its process title', () => {
  for (const command of ['2.1.295', 'claude', 'node']) assert.ok(runsClaude({ command }), command);
  for (const command of ['bash', 'zsh', 'vim', '', undefined]) assert.ok(!runsClaude({ command }), String(command));
});

test('a plain shell pane is never guessed', () => {
  const l = linker({ panes: [pane({ command: 'bash' })], sessions: [session('a')] });
  assert.deepEqual(links(l), [['%0', null, null]]);
});

test('a pane running Claude is guessed by folder when nothing better exists', () => {
  const l = linker({ sessions: [session('a', { cwd: '/other' }), session('b'), session('c', { closed: true })] });
  assert.deepEqual(links(l), [['%0', 'b', 'folder']]);
});

test('sessions last active before the pane started are not guessed', () => {
  const l = linker({ panes: [pane({ createdAt: T1 })], sessions: [session('a', { lastTs: T0 })] });
  assert.deepEqual(links(l), [['%0', null, null]]);
});

test('the registry links a pane exactly', () => {
  const l = linker({
    sessions: [session('outside'), session('inside')],
    registry: [{ sessionId: 'inside', tmuxSession: 'demo', pane: '%0' }],
  });
  assert.deepEqual(links(l), [['%0', 'inside', 'registry']]);
});

test('a session the registry places outside tmux is never guessed', () => {
  // The demo bug: a second Claude in the same folder, running in a normal terminal.
  const l = linker({ sessions: [session('outside')], registry: [{ sessionId: 'outside', tmuxSession: null, pane: null }] });
  assert.deepEqual(links(l), [['%0', null, null]]);
});

test('a hook link wins over the registry', () => {
  const l = linker({ registry: [{ sessionId: 'from-registry', tmuxSession: 'demo', pane: '%0' }] });
  l.fromHook({ event: 'SessionStart', sessionId: 'from-hook', pane: '%0', tmux: '/tmp/tmux-501/control-c,1,0', at: T1 });
  assert.deepEqual(links(l), [['%0', 'from-hook', 'hook']]);
});

test('hooks from another tmux server are ignored', () => {
  const l = linker();
  assert.equal(l.fromHook({ event: 'SessionStart', sessionId: 'x', pane: '%0', tmux: '/tmp/tmux-501/default,1,0', at: T1 }), false);
});

test('after /clear, a late event from the old session does not undo the move', () => {
  const l = linker();
  const tmux = '/tmp/tmux-501/control-c,1,0';
  l.fromHook({ event: 'SessionStart', sessionId: 'new', pane: '%0', tmux, at: '2026-10-09T11:00:02.000Z' });
  l.fromHook({ event: 'Stop', sessionId: 'old', pane: '%0', tmux, at: '2026-10-09T11:00:01.000Z' });
  assert.deepEqual(links(l), [['%0', 'new', 'hook']]);
});

test('hook links older than the pane are ignored (pane ids reused after a tmux restart)', () => {
  const l = linker({ panes: [pane({ createdAt: T1, command: 'bash' })] });
  l.fromHook({ event: 'Stop', sessionId: 'stale', pane: '%0', tmux: '/tmp/tmux-501/control-c,1,0', at: T0 });
  assert.deepEqual(links(l), [['%0', null, null]]);
});
