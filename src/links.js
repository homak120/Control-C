// Work out which Claude session is running in which tmux pane.
//
// 1. Hooks (exact): a hook runs inside the session's terminal and reports
//    $TMUX_PANE, so every hook event names the pane. After /clear, the new
//    session's SessionStart hook moves the pane over to the new session id.
// 2. Registry (exact): Claude Code lists its running processes in
//    ~/.claude/sessions, including the tmux pane (see registry.js). This works
//    without hooks, e.g. on machines where hooks are locked down.
// 3. Fallback (best guess): a pane that is running Claude is matched to the most
//    recently active open session in the same folder that was active after the
//    pane started. A pane running anything else (a shell, an editor) is never
//    guessed, and neither is a session the registry places somewhere else, such
//    as a normal terminal window in the same folder.

import { SOCKET } from './tmux.js';

// tmux reports the foreground process name. Claude Code sets its process title to
// its version (e.g. "2.1.295"); older builds show up as "claude" or "node".
const CLAUDE_COMMAND = /^(claude|node|\d+\.\d+\.\d+)$/;
export const runsClaude = (pane) => CLAUDE_COMMAND.test(pane.command || '');

const ourSocket = (tmuxVar) => typeof tmuxVar === 'string' && tmuxVar.split(',')[0].endsWith(`/${SOCKET}`);

export class Linker {
  constructor(store, hooks, tmux, registry) {
    this.store = store;
    this.hooks = hooks;
    this.tmux = tmux;
    this.registry = registry;
    this.byPane = new Map(); // pane id -> { sessionId, at, source: 'hook' }
  }

  /** Record a hook event. Returns true if a link changed. */
  fromHook(event) {
    if (!event?.pane || !ourSocket(event.tmux)) return false;
    const prev = this.byPane.get(event.pane);
    if (prev?.sessionId === event.sessionId) { prev.at = event.at; return false; }
    // Only a SessionStart may move a pane to another session; stray late events from
    // the previous session must not undo a /clear.
    if (prev && event.event !== 'SessionStart' && prev.at > event.at) return false;
    this.byPane.set(event.pane, { sessionId: event.sessionId, at: event.at, source: 'hook' });
    return true;
  }

  /** Every live pane with the session it's running, if known. */
  terminals() {
    const panes = this.tmux.list();
    const sessions = this.store.list();
    // Sessions the registry knows are running are never guessed: they're either linked
    // exactly below or running outside Control-C's tmux.
    const claimed = new Set(this.registry?.entries.map((e) => e.sessionId));
    const out = [];

    for (const pane of panes) {
      const link = this.byPane.get(pane.id);
      const listed = pane.dead ? null : this.registry?.forPane(pane);
      // Pane ids are reused when the tmux server restarts; ignore links older than the pane.
      if (link && link.at >= pane.createdAt) {
        out.push({ ...pane, sessionId: link.sessionId, linkedBy: 'hook' });
        claimed.add(link.sessionId);
      } else if (listed) {
        out.push({ ...pane, sessionId: listed.sessionId, linkedBy: 'registry' });
      } else {
        out.push({ ...pane, sessionId: null, linkedBy: null });
      }
    }
    for (const t of out) {
      if (t.sessionId || t.dead || !runsClaude(t)) continue;
      const guess = sessions.find((s) =>
        !claimed.has(s.id) && !s.closed && s.cwd === t.cwd && s.lastTs && s.lastTs >= t.createdAt);
      if (guess) {
        t.sessionId = guess.id;
        t.linkedBy = 'folder';
        claimed.add(guess.id);
      }
    }
    return out;
  }
}
