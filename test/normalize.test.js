// Transcript lines → display items and session metadata. The fixtures mirror the
// shapes Claude Code 2.1.x writes; when the format changes, update them here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLine, sessionSummary } from '../src/normalize.js';

const run = (lines) => {
  const meta = {};
  const items = lines.flatMap((d, i) => normalizeLine(d, i + 1, meta));
  return { meta, items };
};

const ts = (s) => `2026-10-09T10:00:${String(s).padStart(2, '0')}.000Z`;

test('a prompt opens a turn and records session facts', () => {
  const { meta, items } = run([
    { type: 'user', timestamp: ts(1), cwd: '/p', version: '2.1.295', gitBranch: 'main', message: { content: 'fix the bug' }, origin: { kind: 'human' } },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(
    { kind: items[0].kind, text: items[0].text, line: items[0].line, human: items[0].human },
    { kind: 'prompt', text: 'fix the bug', line: 1, human: true },
  );
  assert.equal(meta.prompts, 1);
  assert.equal(meta.turnOpen, true);
  assert.equal(meta.cwd, '/p');
  assert.equal(meta.gitBranch, 'main');
  assert.equal(meta.firstTs, ts(1));
});

test('a detached HEAD is not recorded as a branch', () => {
  const { meta } = run([{ type: 'user', gitBranch: 'HEAD', message: { content: 'x' } }]);
  assert.equal(meta.gitBranch, undefined);
});

test('long prompts are clipped and report how much was cut', () => {
  const { items } = run([{ type: 'user', message: { content: 'a'.repeat(20005) } }]);
  assert.equal(items[0].text.length, 20000);
  assert.equal(items[0].truncated, 5);
});

test('slash commands become command items, not prompts', () => {
  const { meta, items } = run([
    { type: 'user', message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
  ]);
  assert.deepEqual(items.map((i) => [i.kind, i.name, i.args]), [['command', '/model', 'opus']]);
  assert.equal(meta.prompts, undefined);
});

test('meta and sidechain lines produce no items', () => {
  const { items } = run([
    { type: 'user', isMeta: true, message: { content: 'hidden' } },
    { type: 'user', isSidechain: true, message: { content: 'subagent' } },
  ]);
  assert.equal(items.length, 0);
});

test('assistant text, thinking and tool calls; usage counted once per message', () => {
  const usage = { output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } };
  const { meta, items } = run([
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'Looking.' }] } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } }] } },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['thinking', 'text', 'tool_use']);
  assert.equal(items[0].tokens, 20);
  assert.equal(items[2].summary, 'ls');
  assert.equal(items[2].description, 'List files');
  assert.equal(meta.outputTokens, 50);
  assert.equal(meta.model, 'claude-opus-5-5');
});

test('synthetic model names are ignored', () => {
  const { meta } = run([{ type: 'assistant', message: { model: '<synthetic>', content: [] } }]);
  assert.equal(meta.model, undefined);
});

test('tool results carry the error flag, size and clipped output', () => {
  const { items } = run([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'x'.repeat(5000) }] }] } },
  ]);
  assert.equal(items[0].kind, 'tool_result');
  assert.equal(items[0].toolUseId, 't1');
  assert.equal(items[0].isError, true);
  assert.equal(items[0].size, 5000);
  assert.equal(items[0].text.length, 4000);
});

test('turn end, session end and titles update the metadata', () => {
  const { meta, items } = run([
    { type: 'user', message: { content: 'go' } },
    { type: 'system', subtype: 'turn_duration', durationMs: 1200, messageCount: 4 },
    { type: 'ai-title', aiTitle: 'Generated' },
    { type: 'custom-title', customTitle: 'Mine' },
    { type: 'cost-state', totalCostUSD: 1.25, totalAPIDuration: 900, modelUsage: { 'claude-opus-5-5': {} } },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['prompt', 'turn-end', 'session-end']);
  assert.equal(meta.turnOpen, false);
  assert.equal(meta.closed, true);
  assert.equal(meta.costUSD, 1.25);

  const summary = sessionSummary({ id: 's1', projectDir: 'p', meta, lineNo: 5, offset: 100, mtimeMs: 0 });
  assert.equal(summary.title, 'Mine');
  assert.equal(summary.costUSD, 1.25);
  assert.equal(summary.closed, true);
});

test('continued-in links to the next session', () => {
  const { meta, items } = run([{ type: 'continued-in', continuedInSessionId: 'next-id' }]);
  assert.equal(meta.continuedIn, 'next-id');
  assert.equal(items[0].sessionLink, 'next-id');
});

test('unknown line types are ignored', () => {
  const { items } = run([{ type: 'some-future-type', foo: 1 }, { type: 'system', subtype: 'new_subtype' }]);
  assert.equal(items.length, 0);
});
