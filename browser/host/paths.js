// Names and locations shared by the broker, its clients and the installer.
//
// Everything here is our own: the host name, socket folder and extension id must
// never collide with Anthropic's two native hosts (com.anthropic.*) or their
// /tmp/claude-mcp-browser-bridge-<user>/ sockets. See docs/browser-agent-research.md.

import os from 'node:os';
import path from 'node:path';

export const HOST_NAME = 'io.controlc.browser_bridge';
// Derived from the public `key` in browser/extension/manifest.json, so it is the
// same on every machine and in every browser. Change both together.
export const EXTENSION_ID = 'ecpfaoagmibnojbimdpkeaicdagojdho';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

// A fixed /tmp path rather than os.tmpdir(): the broker (spawned by the browser)
// and its clients (spawned by terminals, agents, the hub) must agree on the
// folder without depending on each process inheriting the same TMPDIR.
const user = (() => { try { return os.userInfo().username; } catch { return String(process.getuid?.()); } })();
export const SOCKET_DIR = process.env.CONTROL_C_BROWSER_DIR
  || path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `control-c-browser-${user.replace(/[^\w.-]/g, '_')}`);

/** One broker per running browser, named after its pid. */
export const socketPath = (pid, dir = SOCKET_DIR) => path.join(dir, `${pid}.sock`);
export const infoPath = (pid, dir = SOCKET_DIR) => path.join(dir, `${pid}.json`);
