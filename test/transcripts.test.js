// Following a transcript file by byte offset. Uses readNew() directly; start()
// would add a file watcher and timers that keep the test process alive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/transcripts.js';

const line = (text) => JSON.stringify({ type: 'user', timestamp: '2026-10-09T10:00:00.000Z', cwd: '/p', message: { content: text } }) + '\n';

async function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-transcripts-'));
  const dir = path.join(root, '-p');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'sess-1.jsonl');
  const store = new SessionStore(root);
  const events = [];
  store.on('append', (e) => events.push(['append', e]));
  store.on('session', (e) => events.push(['session', e]));
  try {
    await fn({ store, file, events });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('loads existing lines silently, then reports new ones as single or multi', () => withStore(async ({ store, file, events }) => {
  fs.writeFileSync(file, line('one'));
  await store.add(file, '-p', true);
  assert.equal(events.length, 0);
  const s = store.get('sess-1');
  assert.equal(s.meta.prompts, 1);

  fs.appendFileSync(file, line('two'));
  await store.readNew(s);
  fs.appendFileSync(file, line('three') + line('four'));
  await store.readNew(s);

  const appends = events.filter(([t]) => t === 'append').map(([, e]) => e);
  assert.deepEqual(appends.map((e) => [e.update.kind, e.update.firstLine, e.update.lastLine]), [['single', 2, 2], ['multi', 3, 4]]);
  assert.deepEqual(appends[1].items.map((i) => i.text), ['three', 'four']);
  assert.equal(appends[1].summary.prompts, 4);
}));

test('waits for the rest of a half-written line', () => withStore(async ({ store, file, events }) => {
  fs.writeFileSync(file, '');
  await store.add(file, '-p', true);
  const s = store.get('sess-1');
  const full = line('split');
  fs.appendFileSync(file, full.slice(0, 20));
  await store.readNew(s);
  assert.equal(events.length, 0);
  fs.appendFileSync(file, full.slice(20));
  await store.readNew(s);
  assert.equal(events.length, 1);
  assert.equal(events[0][1].items[0].text, 'split');
}));

test('a rewritten file is re-read from the start', () => withStore(async ({ store, file, events }) => {
  fs.writeFileSync(file, line('old one') + line('old two'));
  await store.add(file, '-p', true);
  const s = store.get('sess-1');
  fs.writeFileSync(file, line('new'));
  await store.readNew(s);
  assert.deepEqual(events.map(([t, e]) => [t, e.type || e.update.kind]), [['session', 'reset'], ['append', 'single']]);
  assert.equal(s.meta.prompts, 1);
  assert.equal(s.lineNo, 1);
}));

test('items() and rawLine() read the history fresh, skipping blank and bad lines', () => withStore(async ({ store, file }) => {
  fs.writeFileSync(file, line('a') + '\n' + '{broken\n' + line('b'));
  await store.add(file, '-p', true);
  const items = await store.items('sess-1');
  assert.deepEqual(items.map((i) => [i.line, i.text]), [[1, 'a'], [3, 'b']]);
  assert.equal(await store.rawLine('sess-1', 2), '{broken');
  assert.equal(await store.rawLine('sess-1', 9), null);
}));

test('subagents are listed with their metadata and read with sidechain lines', () => withStore(async ({ store, file }) => {
  fs.writeFileSync(file, line('parent'));
  await store.add(file, '-p', true);
  assert.deepEqual(await store.subagents('sess-1'), [], 'no subagents folder');

  const dir = path.join(path.dirname(file), 'sess-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const sub = (text) => JSON.stringify({ type: 'user', isSidechain: true, timestamp: '2026-10-09T10:05:00.000Z', message: { content: text } }) + '\n';
  const reply = JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'm1', model: 'claude-sonnet-5', usage: { output_tokens: 7 }, content: [{ type: 'text', text: 'done' }] } }) + '\n';
  fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), sub('do the thing') + reply);
  fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find files', toolUseId: 'toolu_1', spawnDepth: 1 }));
  fs.writeFileSync(path.join(dir, 'agent-a2.jsonl'), sub('no meta file'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

  const list = await store.subagents('sess-1');
  assert.deepEqual(list.map((a) => [a.agentId, a.agentType, a.toolUseId, a.model, a.outputTokens, a.lines]),
    [['a1', 'Explore', 'toolu_1', 'claude-sonnet-5', 7, 2], ['a2', null, null, null, 0, 1]]);

  const items = await store.subagentItems('sess-1', 'a1');
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [['prompt', 'do the thing'], ['text', 'done']]);
  assert.equal(await store.subagentItems('sess-1', 'missing'), null);
  assert.equal(await store.subagentItems('sess-1', '../sess-1'), null, 'agent ids cannot walk out of the folder');
  assert.equal(await store.subagents('no-such-session'), null);
}));
