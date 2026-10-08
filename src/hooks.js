// Receive Claude Code hook events and derive a live state for each session.
//
// Hooks are Claude Code's documented extension point, so they're the reliable
// source for "what is this session doing right now" and for mapping a session
// to its transcript file (including after /clear, which starts a new session).

import { EventEmitter } from 'node:events';

const MAX_EVENTS = 500;

const STATE_BY_EVENT = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  PreCompact: 'compacting',
  Notification: 'attention',
  Stop: 'idle',
  SessionEnd: 'ended',
};

export class HookHub extends EventEmitter {
  constructor() {
    super();
    this.events = [];
    this.live = new Map(); // session_id -> live state
  }

  receive(payload) {
    const name = payload.hook_event_name;
    const id = payload.session_id;
    if (!name || !id) return null;

    const event = {
      at: new Date().toISOString(),
      event: name,
      sessionId: id,
      cwd: payload.cwd || null,
      transcriptPath: payload.transcript_path || null,
      tool: payload.tool_name || null,
      source: payload.source || payload.reason || null,
      message: payload.message || (name === 'UserPromptSubmit' ? payload.prompt?.slice(0, 200) : null) || null,
      notificationType: payload.notification_type || null,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();

    const prev = this.live.get(id) || {};
    const next = {
      sessionId: id,
      state: STATE_BY_EVENT[name] || prev.state || 'idle',
      lastEvent: name,
      lastEventAt: event.at,
      cwd: event.cwd || prev.cwd || null,
      transcriptPath: event.transcriptPath || prev.transcriptPath || null,
      tool: name === 'PreToolUse' ? event.tool : null,
      attention: name === 'Notification' ? event.message : null,
      startSource: name === 'SessionStart' ? event.source : prev.startSource || null,
    };
    this.live.set(id, next);
    this.emit('hook', { event, live: next });
    return event;
  }

  states() {
    return Object.fromEntries(this.live);
  }
}
