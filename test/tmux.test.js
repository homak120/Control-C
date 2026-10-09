// tmux control mode escapes bytes below 0x20 and backslash as \ooo octal in %output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput } from '../src/tmux.js';

const decode = (s) => decodeOutput(Buffer.from(s, 'latin1'));

test('octal escapes become the original bytes', () => {
  assert.deepEqual([...decode('a\\015\\012b')], [0x61, 0x0d, 0x0a, 0x62]);
  assert.equal(decode('\\033[31mred\\033[0m').toString(), '\x1b[31mred\x1b[0m');
});

test('an escaped backslash decodes to one backslash', () => {
  assert.equal(decode('C:\\134dir').toString(), 'C:\\dir');
});

test('a backslash not followed by three octal digits is kept', () => {
  assert.equal(decode('\\x \\09 \\1').toString(), '\\x \\09 \\1');
});

test('raw UTF-8 bytes pass through untouched', () => {
  const emoji = Buffer.from('✓ 你好 🚀', 'utf8');
  assert.deepEqual(decodeOutput(emoji), emoji);
});

test('a UTF-8 sequence split across two chunks survives', () => {
  const bytes = Buffer.from('🚀', 'utf8');
  const joined = Buffer.concat([decodeOutput(bytes.subarray(0, 2)), decodeOutput(bytes.subarray(2))]);
  assert.equal(joined.toString('utf8'), '🚀');
});
