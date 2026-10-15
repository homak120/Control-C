// Registers the broker as a native-messaging host with each installed Chromium
// browser, or removes it again.
//
// The manifest points at a small wrapper script with an absolute node path,
// because browsers start hosts with a minimal PATH. Browsers read these
// manifests at startup, so restart the browser after the first install.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from '../../src/config.js';
import { EXTENSION_ORIGIN, HOST_NAME } from './paths.js';

const BROKER = fileURLToPath(new URL('./broker.js', import.meta.url));
const WRAPPER = path.join(HOME_DIR, 'browser-host.sh');

// Per-user profile roots. Arc, Vivaldi and Opera are unconfirmed by their vendors
// (see docs/browser-agent-research.md) but cost nothing to try.
function browserRoots() {
  const h = os.homedir();
  if (process.platform === 'darwin') {
    const s = path.join(h, 'Library', 'Application Support');
    return {
      Chrome: path.join(s, 'Google', 'Chrome'),
      'Chrome Canary': path.join(s, 'Google', 'Chrome Canary'),
      Chromium: path.join(s, 'Chromium'),
      Edge: path.join(s, 'Microsoft Edge'),
      Brave: path.join(s, 'BraveSoftware', 'Brave-Browser'),
      Arc: path.join(s, 'Arc', 'User Data'),
      Vivaldi: path.join(s, 'Vivaldi'),
      Opera: path.join(s, 'com.operasoftware.Opera'),
    };
  }
  if (process.platform === 'linux') {
    const c = path.join(h, '.config');
    return {
      Chrome: path.join(c, 'google-chrome'),
      Chromium: path.join(c, 'chromium'),
      Edge: path.join(c, 'microsoft-edge'),
      Brave: path.join(c, 'BraveSoftware', 'Brave-Browser'),
      Vivaldi: path.join(c, 'vivaldi'),
    };
  }
  return {}; // Windows needs registry keys; not supported by the prototype yet.
}

const manifestPath = (root) => path.join(root, 'NativeMessagingHosts', `${HOST_NAME}.json`);

export function install() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(WRAPPER, `#!/bin/sh\nexec "${process.execPath}" "${BROKER}" "$@"\n`, { mode: 0o700 });
  const manifest = {
    name: HOST_NAME,
    description: 'Control-C browser bridge',
    path: WRAPPER,
    type: 'stdio',
    allowed_origins: [EXTENSION_ORIGIN],
  };
  const done = [];
  for (const [name, root] of Object.entries(browserRoots())) {
    if (!fs.existsSync(root)) continue; // browser not installed
    const file = manifestPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    done.push(`${name}: ${file}`);
  }
  return done;
}

export function uninstall() {
  const done = [];
  for (const [name, root] of Object.entries(browserRoots())) {
    const file = manifestPath(root);
    if (fs.existsSync(file)) { fs.rmSync(file); done.push(`${name}: ${file}`); }
  }
  fs.rmSync(WRAPPER, { force: true });
  return done;
}
