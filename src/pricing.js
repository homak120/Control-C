// Estimated API cost of one Claude response, from the usage block in the transcript.
//
// Claude Code only writes the exact session cost when a session exits, so live
// cost is an estimate: tokens × list price. Prices are Anthropic first-party API
// rates in USD per million tokens, taken from the Claude API reference on
// 2026-10-09. Update this table when prices change or new models ship; a model
// that isn't listed is reported as unpriced rather than guessed.
//
// Cache writes cost 1.25× input (5-minute TTL) or 2× input (1-hour TTL). Cache
// reads differ by model, so each row states its own read price.

const M = 1e6;

const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  // Haiku 5.5 doubles in price tier above 100K prompt tokens.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** "claude-opus-5-5[1m]" or a dated id → the base model id used in the table. */
export const baseModel = (model) => String(model || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');

/** Cost in USD of one response, or null if the model, or its speed, has no known price. */
export function responseCost(model, usage) {
  const row = PRICES[baseModel(model)];
  if (!row || !usage) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const input = n(usage.input_tokens);
  const read = n(usage.cache_read_input_tokens);
  const write = n(usage.cache_creation_input_tokens);
  const w1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  const w5m = usage.cache_creation ? n(usage.cache_creation.ephemeral_5m_input_tokens) : write;

  const p = row.long && input + read + write > row.long.above ? row.long : row;
  let speed = 1;
  if (usage.speed === 'fast') {
    if (!row.fast) return null;
    speed = row.fast;
  }
  const usd = input * p.input + read * p.cacheRead + w5m * p.input * 1.25 + w1h * p.input * 2 + n(usage.output_tokens) * p.output;
  return (usd * speed) / M;
}
