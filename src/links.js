// Work out which Claude session is running in which tmux pane.
//
// 1. Hooks (exact): a hook runs inside the session's terminal and reports
//    $TMUX_PANE, so every hook event names the pane. After /clear, the new
//    session's SessionStart hook moves the pane over to the new session id.
// 2. Fallback (best guess): with no hook yet, a pane is matched to the most
//    recently active open session in the same folder that started after the pane.

import { SOCKET } from './tmux.js';

const ourSocket = (tmuxVar) => typeof tmuxVar === 'string' && tmuxVar.split(',')[0].endsWith(`/${SOCKET}`);

export class Linker {
  constructor(store, hooks, tmux) {
    this.store = store;
    this.hooks = hooks;
    this.tmux = tmux;
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
    const claimed = new Set();
    const out = [];

    for (const pane of panes) {
      const link = this.byPane.get(pane.id);
      // Pane ids are reused when the tmux server restarts; ignore links older than the pane.
      if (link && link.at >= pane.createdAt) {
        out.push({ ...pane, sessionId: link.sessionId, linkedBy: 'hook' });
        claimed.add(link.sessionId);
      } else {
        out.push({ ...pane, sessionId: null, linkedBy: null });
      }
    }
    for (const t of out) {
      if (t.sessionId || t.dead) continue;
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
