# Control-C

A local control center for [Claude Code](https://code.claude.com) sessions. It watches every session on your Mac and shows them in a live, organized dashboard, while you keep working in the normal terminal.

> Status: **Phase 2, live terminal mirror and input.** Later phases add secure remote access and automation with other agents (see [Roadmap](#roadmap)).

## Features

- **Every session in one place.** The sidebar lists all sessions from `~/.claude/projects`, grouped by project, with search and filters.
- **Conversations laid out in turns.** Each turn shows your prompt, Claude's rendered reply, thinking markers, and collapsible tool calls with their input and result. Turn duration and the session's final cost are shown too.
- **Live updates.** New transcript lines stream in as Claude Code writes them. The header shows whether each write was a single line or a burst (`SINGLE` / `MULTI ×n`).
- **Session tracking.** Picks up sessions created by `/clear`, resume or a new terminal automatically, and links a session to its continuation.
- **Raw view.** Click any `L<n>` marker to see the exact JSON of that transcript line.
- **Live state via hooks.** With hooks installed, each session shows whether it's *working*, *running a tool*, *needs you* (waiting for a permission prompt) or *idle*.
- **Live terminal (Phase 2).** Sessions started with `ctrlc` (or **＋ New** in the dashboard) run inside tmux. The dashboard mirrors the real terminal next to the chat (Chat / Split / Terminal views), and you can type into it, use the key buttons (Esc, Enter, arrows, Shift+Tab, Ctrl+C), or send a message from the input box.

## Quick start

Requires Node.js 20 or later.

```bash
npm install
npm start
```

Open the link printed in the terminal (`http://127.0.0.1:7777/?token=…`). The token is swapped for a cookie on first visit, so after that `http://127.0.0.1:7777` is enough.

### Mirrored terminals: `ctrlc`

Start Claude Code through `ctrlc` instead of `claude` to also see and control its terminal in the dashboard:

```bash
ctrlc                      # start Claude Code in this folder (same as running `claude`, but inside tmux)
ctrlc ~/Documents/Projects/HoMakPersonalWeb -- --resume   # folder plus any claude arguments after --
ctrlc ls                   # list running Control-C sessions
ctrlc attach [name]        # re-attach (default: most recent)
ctrlc kill <name>          # end one
```

Detach with **Ctrl+B then D**. Claude keeps running, and the dashboard keeps showing it. Sessions started with **＋ New** in the dashboard run detached until you `ctrlc attach` them.

To make `ctrlc` available everywhere, link it onto your PATH, e.g. `ln -s "$PWD/bin/ctrlc.js" ~/.local/bin/ctrlc` (or `npm link`). This needs [tmux](https://github.com/tmux/tmux) (`brew install tmux`). Control-C runs its own tmux server (socket `control-c`, config in `tmux.conf`), so your own tmux setup is untouched.

**Terminal size:** while a real terminal is attached, it decides the size and the browser scales its font to match. With no terminal attached, the browser sizes the session to fit its panel.

### Live state hooks

```bash
npm run hooks              # preview the hook config (changes nothing)
npm run hooks:install      # back up ~/.claude/settings.json and add the hooks
npm run hooks:uninstall    # remove them again
```

Each hook sends the event JSON, plus the tmux pane it ran in, to the hub with `curl`. The pane lets the hub link each terminal to its exact Claude session, even after `/clear`. Without hooks, it falls back to matching by folder. The command prints nothing and always exits 0, so Claude Code behaves normally when the hub isn't running. New sessions load the hooks automatically; for sessions already running, restart them or open `/hooks`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7777` | Hub port (reinstall hooks after changing it) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where transcripts are read from |
| `CONTROL_C_HOME` | `~/.control-c` | Where the access token is stored |

## Security

- **Local only.** The hub listens on `127.0.0.1` only and rejects requests for any other `Host`, which blocks DNS-rebinding attacks.
- **Token required.** Every request needs the token from `~/.control-c/token` (file mode 600), sent as an HttpOnly cookie or an `X-Control-C-Token` header.
- **Transcript content is escaped.** It's always rendered as text or through an escaping Markdown renderer, and the page uses a strict Content-Security-Policy.
- **Nothing is written to your transcripts.**
- **Terminal input can be sent to Control-C sessions only.** The terminal WebSocket also checks the page's `Origin`, so other websites can't connect to it (cross-site WebSocket hijacking).

Anyone with the token can type into your Claude sessions, which can run commands on your Mac. Treat the token like a password.

Transcripts contain everything from your sessions, including file contents and command output. Don't expose the port to a network. For remote access, wait for Phase 3 or use an SSH tunnel.

## How it works

```
Claude Code ──writes──▶ ~/.claude/projects/<project>/<session>.jsonl ──fs.watch──┐
     │                                                                            ▼
     └──hooks (curl POST)──────────────────────────────────────────────▶ Node hub (127.0.0.1)
                                                                                  │ SSE
                                                                                  ▼
                                                                         Browser dashboard
```

| File | Role |
|---|---|
| `src/server.js` | HTTP server, auth, JSON API, SSE stream, hook receiver |
| `src/transcripts.js` | Finds session files and follows them incrementally by byte offset; detects rewrites |
| `src/normalize.js` | Turns raw transcript lines into display items. **All format assumptions live here.** |
| `src/hooks.js` | Derives each session's live state from hook events |
| `src/tmux.js` | Lists panes, streams their output (tmux control mode), sends keys, launches sessions |
| `src/links.js` | Matches tmux panes to Claude sessions (hooks first, folder fallback) |
| `bin/ctrlc.js` | The `ctrlc` launcher |
| `tmux.conf` | Settings for Control-C's own tmux server |
| `public/` | Dashboard (plain HTML/CSS/JS, no build step) |
| `scripts/hooks.js` | Installs and uninstalls the hooks |

The transcript format is internal to Claude Code and may change between versions. Hooks are the documented interface.

### API

| Endpoint | Description |
|---|---|
| `GET /api/sessions` | All sessions plus their live hook state |
| `GET /api/sessions/:id` | One session's summary and normalized items |
| `GET /api/sessions/:id/lines/:n` | Raw JSON of transcript line *n* |
| `GET /api/events` | SSE stream: `append`, `session`, `hook` |
| `GET /api/hooks` | Recent hook events |
| `POST /api/hooks` | Hook intake (used by the installed hooks) |
| `GET /api/terminals` | tmux panes and the session each one runs |
| `POST /api/terminals` | Start Claude Code in a folder: `{ "cwd": "…" }` |
| `WS /ws/terminal?pane=N` | Live pane output (binary) and snapshots; send `{type:"input", data}` or `{type:"resize", cols, rows}` |

## Roadmap

1. **Read-only dashboard** ✅
2. **Terminal mirror and input** ✅
3. **Remote access.** Secure access from other devices, plus notifications such as "needs permission" or "turn finished".
4. **Automation and agents.** An MCP server, headless Claude Agent SDK workers, and task handoff between agents.
