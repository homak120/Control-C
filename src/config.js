// Runtime configuration and the local auth token.
//
// The token lives in ~/.control-c/token (mode 600). The dashboard URL carries it
// once and the server swaps it for a cookie; Claude Code hooks send it as a header.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME_DIR = process.env.CONTROL_C_HOME || path.join(os.homedir(), '.control-c');
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
// Claude Code's list of running sessions (read-only; see registry.js).
export const CLAUDE_SESSIONS_DIR =
  process.env.CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT) || 7777;
export const TOKEN_FILE = path.join(HOME_DIR, 'token');

export function loadToken() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}
