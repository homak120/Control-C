// Browser bridge: framing, and the broker routing between a fake extension and clients.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { encode, FrameReader, MAX_FRAME } from '../browser/host/framing.js';
import { createBroker } from '../browser/host/broker.js';
import { connect, listBrokers } from '../browser/host/client.js';

test('frames survive being split and joined across chunks', () => {
  const got = [];
  const r = new FrameReader((m) => got.push(m));
  const bytes = Buffer.concat([encode({ a: 1 }), encode({ b: 'é😀' })]);
  for (let i = 0; i < bytes.length; i += 3) r.push(bytes.subarray(i, i + 3));
  assert.deepEqual(got, [{ a: 1 }, { b: 'é😀' }]);
});

test('a bad length stops the reader instead of desyncing', () => {
  const errors = [];
  const r = new FrameReader(() => assert.fail('no message expected'), (e) => errors.push(e));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(MAX_FRAME + 1, 0);
  r.push(head);
  r.push(encode({ late: true }));
  assert.equal(errors.length, 1);
  assert.throws(() => encode({ big: 'x'.repeat(MAX_FRAME) }), /too large/);
});

/** A broker in a temp folder, wired to a fake extension on in-memory streams. */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-'));
  const toBroker = new PassThrough();
  const fromBroker = new PassThrough();
  const extGot = [];
  const waiters = [];
  const reader = new FrameReader((m) => {
    extGot.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  fromBroker.on('data', (d) => reader.push(d));
  const broker = createBroker({ input: toBroker, output: fromBroker, dir, pid: 4242 });
  const ext = {
    send: (m) => toBroker.write(encode(m)),
    got: extGot,
    next: (pred) => {
      const hit = extGot.find(pred);
      return hit ? Promise.resolve(hit) : new Promise((resolve) => waiters.push({ pred, resolve }));
    },
  };
  t.after(() => { broker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, broker, ext, toBroker };
}

const ready = (broker) => broker.ready;

test('the socket and folder are private to the user', async (t) => {
  const { dir, broker } = setup(t);
  await ready(broker);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(broker.socket).mode & 0o777, 0o600);
});

test('ext_hello registers the browser so clients can find it', async (t) => {
  const { dir, broker, ext } = setup(t);
  await ready(broker);
  ext.send({ type: 'ext_hello', browser: 'Chrome', extVersion: '0.1.0' });
  await new Promise((r) => setTimeout(r, 20));
  const list = listBrokers(dir);
  // pid 4242 is fake, so liveness filtering drops it; the file itself must be right.
  assert.equal(list.length, 0);
  const info = JSON.parse(fs.readFileSync(broker.info, 'utf8'));
  assert.equal(info.browser, 'Chrome');
  assert.equal(info.socket, broker.socket);
});

test('each client gets its own session and only its own results', async (t) => {
  const { broker, ext } = setup(t);
  await ready(broker);
  const a = await connect({ name: 'codex', socket: broker.socket });
  const b = await connect({ name: 'claude', socket: broker.socket });
  assert.notEqual(a.welcome.sessionId, b.welcome.sessionId);
  const open = await ext.next((m) => m.type === 'session_open' && m.label === 'claude');
  assert.equal(open.sessionId, b.welcome.sessionId);

  const pa = a.call('read_page', { tabId: 1 });
  const pb = b.call('read_page', { tabId: 2 });
  const ra = await ext.next((m) => m.type === 'tool_request' && m.args.tabId === 1);
  const rb = await ext.next((m) => m.type === 'tool_request' && m.args.tabId === 2);
  assert.equal(ra.sessionId, a.welcome.sessionId);
  assert.equal(rb.sessionId, b.welcome.sessionId);

  // Answer B first, and send A's answer twice: the duplicate must be dropped.
  ext.send({ type: 'tool_result', id: rb.id, content: [{ type: 'text', text: 'for b' }] });
  ext.send({ type: 'tool_result', id: ra.id, content: [{ type: 'text', text: 'for a' }] });
  ext.send({ type: 'tool_result', id: ra.id, content: [{ type: 'text', text: 'dup' }] });
  assert.equal((await pa).content[0].text, 'for a');
  assert.equal((await pb).content[0].text, 'for b');
  a.close(); b.close();
});

test('request ids are chosen by the broker, not the client', async (t) => {
  const { broker, ext } = setup(t);
  await ready(broker);
  const a = await connect({ name: 'a', socket: broker.socket });
  a.call('navigate', { tabId: 1 });
  const req = await ext.next((m) => m.type === 'tool_request');
  // Ids are broker-chosen, not client-chosen.
  assert.match(req.id, /^\d+:[0-9a-f]{12}$/);
  a.close();
});

test('disconnecting closes the session in the extension', async (t) => {
  const { broker, ext } = setup(t);
  await ready(broker);
  const a = await connect({ name: 'a', socket: broker.socket });
  a.close();
  const closed = await ext.next((m) => m.type === 'session_close');
  assert.equal(closed.sessionId, a.welcome.sessionId);
});

test('a reconnecting client can resume its session, but not one in use', async (t) => {
  const { broker } = setup(t);
  await ready(broker);
  const a = await connect({ name: 'a', socket: broker.socket });
  const stolen = await connect({ name: 'b', socket: broker.socket, resume: a.welcome.sessionId });
  assert.notEqual(stolen.welcome.sessionId, a.welcome.sessionId);
  const sid = a.welcome.sessionId;
  a.close();
  await new Promise((r) => setTimeout(r, 20));
  const again = await connect({ name: 'a', socket: broker.socket, resume: sid });
  assert.equal(again.welcome.sessionId, sid);
  stolen.close(); again.close();
});

test('bad tool names are refused without reaching the extension', async (t) => {
  const { broker, ext } = setup(t);
  await ready(broker);
  const a = await connect({ name: 'a', socket: broker.socket });
  const r = await a.call('../evil', {});
  assert.equal(r.isError, true);
  assert.equal(ext.got.some((m) => m.type === 'tool_request'), false);
  a.close();
});

test('losing the browser fails in-flight calls and is never replayed', async (t) => {
  const { broker, ext, toBroker } = setup(t);
  await ready(broker);
  const a = await connect({ name: 'a', socket: broker.socket });
  const p = a.call('navigate', { tabId: 1, url: 'https://example.com' });
  await ext.next((m) => m.type === 'tool_request');
  toBroker.end(); // the browser closed the native port
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /may already have taken effect/);
  assert.equal(fs.existsSync(broker.socket), false);
  assert.equal(ext.got.filter((m) => m.type === 'tool_request').length, 1);
});

test('the MCP shim lists tools and relays a call through the broker', async (t) => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-'));
  const toBroker = new PassThrough();
  const fromBroker = new PassThrough();
  // The real pid, so the shim's liveness check finds this broker.
  const broker = createBroker({ input: toBroker, output: fromBroker, dir });
  t.after(() => { broker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await broker.ready;
  toBroker.write(encode({ type: 'ext_hello', browser: 'TestBrowser' }));
  const ext = new FrameReader((m) => {
    if (m.type === 'tool_request') toBroker.write(encode({ type: 'tool_result', id: m.id, content: [{ type: 'text', text: `did ${m.tool}` }] }));
  });
  fromBroker.on('data', (d) => ext.push(d));

  const shim = spawn(process.execPath, [new URL('../browser/host/mcp.js', import.meta.url).pathname], {
    env: { ...process.env, CONTROL_C_BROWSER_DIR: dir }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  t.after(() => shim.kill());
  const replies = new Map();
  let buf = '';
  shim.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.get(m.id)?.(m);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client' } });
  assert.equal(init.result.serverInfo.name, 'control-c-browser');
  shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc(2, 'tools/list');
  assert.deepEqual(list.result.tools.map((x) => x.name), ['tabs_context', 'navigate', 'screenshot', 'read_page']);
  const call = await rpc(3, 'tools/call', { name: 'tabs_context', arguments: {} });
  assert.deepEqual(call.result, { content: [{ type: 'text', text: 'did tabs_context' }], isError: false });
  const bad = await rpc(4, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(bad.error.code, -32602);
});
