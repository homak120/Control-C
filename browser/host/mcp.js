#!/usr/bin/env node
// stdio MCP server that drives the browser through the broker. Any MCP client can
// launch it (Claude Code, Codex CLI, Gemini CLI, Cursor…); each one gets its own
// session and tab group.
//
//   claude mcp add control-c-browser -- node /path/to/browser/host/mcp.js
//
// Only the slice of MCP a tool server needs is implemented by hand (initialize,
// tools/list, tools/call, ping) to keep Control-C's dependency list short.
// Messages are newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr.

import readline from 'node:readline';
import { connect } from './client.js';

const PROTOCOL = '2025-06-18';
const tabId = { type: 'integer', description: 'Tab id from tabs_context. Must be a tab in this session\'s group.' };

export const TOOLS = [
  {
    name: 'tabs_context',
    description: 'List the tabs in this session\'s tab group. Call this first. With createIfEmpty, opens a blank tab (and the group) when there is none.',
    inputSchema: { type: 'object', properties: { createIfEmpty: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'navigate',
    description: 'Load an http(s) URL in a tab of this session\'s group and wait for it to finish loading.',
    inputSchema: { type: 'object', properties: { tabId, url: { type: 'string' } }, required: ['tabId', 'url'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'screenshot',
    description: 'Screenshot the visible part of a tab. One image pixel equals one CSS pixel unless the text says it was scaled.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_page',
    description: 'Read the page as an accessibility-style outline with element refs (ref_N). filter "interactive" lists only controls and links.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        filter: { type: 'string', enum: ['all', 'interactive'] },
        max_chars: { type: 'integer', description: 'Truncate the outline (default 50000).' },
      },
      required: ['tabId'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const log = (m) => process.stderr.write(`[control-c browser-mcp] ${m}\n`);

let clientName = 'mcp';
let broker = null;
let session = null; // kept across reconnects so the same tab group comes back

async function getBroker() {
  if (broker && !broker.closed) return broker;
  broker = await connect({ name: clientName, kind: 'mcp', resume: session, meta: { tmuxPane: process.env.TMUX_PANE } });
  session = broker.welcome.sessionId;
  log(`connected to ${broker.welcome.browser?.browser || 'browser'}, session ${session.slice(0, 6)}`);
  return broker;
}

async function handle(req) {
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      clientName = String(params?.clientInfo?.name || 'mcp').replace(/[^\w .-]/g, '').slice(0, 30) || 'mcp';
      return out({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'control-c-browser', version: '0.1.0' },
      } });
    case 'ping':
      return out({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call': {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) {
        return out({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      }
      let result;
      try {
        result = await (await getBroker()).call(name, params.arguments || {});
      } catch (err) {
        result = { isError: true, content: [{ type: 'text', text: err.message }] };
      }
      return out({ jsonrpc: '2.0', id, result: { content: result.content, isError: !!result.isError } });
    }
    default:
      // Notifications (no id) such as notifications/initialized need no answer.
      if (isRequest) out({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(req).catch((err) => log(err.stack));
});
rl.on('close', () => { broker?.close(); process.exit(0); });
