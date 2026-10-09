// Live cost estimate from transcript usage blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseCost, baseModel } from '../src/pricing.js';
import { normalizeLine, sessionSummary } from '../src/normalize.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('prices input, output, cache reads and both cache-write durations', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read; writes 1.25× (5m) and 2× (1h) input.
  const usage = {
    input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100000, cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  };
  close(responseCost('claude-opus-5-5', usage), (1000 * 4 + 500 * 20 + 100000 * 0.2 + 1000 * 5 + 2000 * 8) / 1e6);
});

test('cache writes without a breakdown are priced as 5-minute writes', () => {
  close(responseCost('claude-sonnet-5', { cache_creation_input_tokens: 1000 }), (1000 * 2 * 1.25) / 1e6);
});

test('fast mode doubles the price where it is known, and is unpriced elsewhere', () => {
  const usage = { output_tokens: 1000, speed: 'fast' };
  close(responseCost('claude-opus-5-5', usage), (1000 * 40) / 1e6);
  assert.equal(responseCost('claude-opus-4-8', usage), null);
});

test('Haiku 5.5 switches to its long-prompt price above 100K prompt tokens', () => {
  close(responseCost('claude-haiku-5-5', { input_tokens: 100000, output_tokens: 1000 }), (100000 * 0.1 + 1000 * 0.5) / 1e6);
  close(responseCost('claude-haiku-5-5', { input_tokens: 50000, cache_read_input_tokens: 60000, output_tokens: 1000 }),
    (50000 * 0.5 + 60000 * 0.05 + 1000 * 2.5) / 1e6);
});

test('unknown models are unpriced, and ids are normalized first', () => {
  assert.equal(responseCost('claude-future-9', { output_tokens: 1 }), null);
  assert.equal(responseCost('claude-opus-5-5', null), null);
  assert.equal(baseModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(baseModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
});

test('sessions accumulate the estimate once per response and count unpriced ones', () => {
  const meta = {};
  const reply = (id, model) => ({ type: 'assistant', message: { id, model, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }, content: [] } });
  [reply('m1', 'claude-opus-5-5'), reply('m1', 'claude-opus-5-5'), reply('m2', 'claude-sonnet-5'), reply('m3', 'claude-future-9'),
    { type: 'assistant', message: { id: 'm4', model: '<synthetic>', usage: { output_tokens: 0 }, content: [] } }]
    .forEach((d, i) => normalizeLine(d, i + 1, meta));
  const s = sessionSummary({ id: 's', projectDir: 'p', meta, lineNo: 5, offset: 0, mtimeMs: 0 });
  close(s.costEstimateUSD, (10 * 4 + 100 * 20 + 1000 * 0.2 + 10 * 2 + 100 * 10 + 1000 * 0.2) / 1e6);
  assert.equal(s.unpricedResponses, 1);
  assert.equal(s.outputTokens, 300);
  assert.equal(s.cacheReadTokens, 3000);
  assert.equal(s.costUSD, null, 'the exact cost stays empty until the session ends');
});
