// ~/.claude/sessions/<pid>.json: Claude Code's list of running sessions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntry, SessionRegistry } from '../src/registry.js';

const entry = (over = {}) => ({
  pid: process.pid, sessionId: 'bf5fc46a-56b5-4ee7-a26c-8cbd7edfea47', cwd: '/p',
  tmux: 'demo:@0.%3', status: 'idle', version: '2.1.295', ...over,
});

test('parses the session id, folder and tmux pane', () => {
  assert.deepEqual(parseEntry(JSON.stringify(entry())), {
    pid: process.pid, sessionId: 'bf5fc46a-56b5-4ee7-a26c-8cbd7edfea47', cwd: '/p',
    tmuxSession: 'demo', pane: '%3', status: 'idle',
  });
});

test('tmux session names may contain colons and dashes', () => {
  const e = parseEntry(JSON.stringify(entry({ tmux: 'my:proj-9dg7:@12.%40' })));
  assert.equal(e.tmuxSession, 'my:proj-9dg7');
  assert.equal(e.pane, '%40');
});

test('a session outside tmux has no pane', () => {
  const e = parseEntry(JSON.stringify(entry({ tmux: undefined })));
  assert.equal(e.pane, null);
  assert.equal(e.tmuxSession, null);
});

test('rejects malformed or unexpected content', () => {
  assert.equal(parseEntry('not json'), null);
  assert.equal(parseEntry('null'), null);
  assert.equal(parseEntry(JSON.stringify(entry({ pid: '12' }))), null);
  assert.equal(parseEntry(JSON.stringify(entry({ sessionId: '../../etc' }))), null);
  assert.equal(parseEntry(JSON.stringify(entry({ tmux: 'garbage' }))).pane, null);
});

test('keeps live processes only, reads only <pid>.json, and finds panes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-registry-'));
  try {
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(entry()));
    // A pid this high doesn't exist, so the file is a leftover from a crash.
    fs.writeFileSync(path.join(dir, '99999999.json'), JSON.stringify(entry({ pid: 99999999, sessionId: 'dead' })));
    fs.writeFileSync(path.join(dir, `${process.pid}.abc.key`), 'secret');
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(entry({ sessionId: 'other' })));

    const reg = new SessionRegistry(dir);
    let changes = 0;
    reg.on('change', () => changes++);
    await reg.refresh();
    assert.deepEqual(reg.entries.map((e) => e.sessionId), ['bf5fc46a-56b5-4ee7-a26c-8cbd7edfea47']);
    assert.equal(changes, 1);

    assert.equal(reg.forPane({ id: '%3', session: 'demo' })?.sessionId, 'bf5fc46a-56b5-4ee7-a26c-8cbd7edfea47');
    assert.equal(reg.forPane({ id: '%3', session: 'other' }), null, 'pane ids are only unique within a tmux session list');

    await reg.refresh();
    assert.equal(changes, 1, 'no change event when nothing changed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing folder means no entries', async () => {
  const reg = new SessionRegistry(path.join(os.tmpdir(), 'cc-registry-does-not-exist'));
  await reg.refresh();
  assert.deepEqual(reg.entries, []);
});
