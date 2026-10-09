# Control-C

A local control center for Claude Code sessions. It shows a live dashboard of every session, mirrors and controls the real terminals, and will later add remote access and multi-agent automation. The README covers usage; this file covers what you need to work on the code.

## Run and test

```bash
npm install
npm start                    # hub on http://127.0.0.1:7777, prints a one-time login link
PORT=7798 CONTROL_C_HOME=/tmp/cc-test npm start   # throwaway instance with its own token
ctrlc [folder]               # start Claude Code inside Control-C's tmux (bin/ctrlc.js)
npm run hooks                # preview the hook config; hooks:install / hooks:uninstall
npm test                     # unit tests (node:test, no dependencies)
```

- **Tests:** `npm test` covers the data layer: transcript parsing, file following, tmux output decoding, the session registry and pane linking. Fixtures in `test/` mirror real transcript shapes; update them when Claude Code's format changes. UI and live tmux behaviour still need checking by running the hub against the real `~/.claude/projects` and looking at the dashboard in a browser.
- **Testing in a browser:** use a throwaway instance (`CONTROL_C_HOME` pointing at a temp folder whose `token` file holds a test token) and open `/?token=<test token>`. Never put the real token from `~/.control-c/token` in a URL or a browser field.
- **Testing the terminal mirror:** start a pane on the Control-C socket, e.g. `tmux -L control-c -f tmux.conf new-session -d -s t1 'bash --norc'`. Clean up afterwards with `tmux -L control-c kill-server`. Note that this also ends any real `ctrlc` sessions.

## Architecture

```
Claude Code ─writes─▶ ~/.claude/projects/<project>/<session>.jsonl ─fs.watch─▶ src/transcripts.js ─┐
     │ hooks (curl + $TMUX_PANE)                                                                  ├▶ src/server.js ─SSE/WS─▶ public/ (browser)
     └───────────────────────────────────────────────────────────────────────▶ src/hooks.js ──────┤
tmux -L control-c (sessions started by ctrlc) ◀─control mode / send-keys─▶ src/tmux.js ───────────┘
                                                              src/links.js matches panes ↔ sessions
```

| File | Role |
|---|---|
| `src/server.js` | HTTP server, auth, JSON API, SSE (`append`, `session`, `hook`, `terminals`), terminal WebSocket |
| `src/transcripts.js` | Finds `*.jsonl` session files and follows them by byte offset; detects rewrites and new files (`/clear`) |
| `src/normalize.js` | Turns raw transcript lines into display items and session metadata |
| `src/hooks.js` | Derives each session's live state (working / attention / idle / ended) from hook events |
| `src/tmux.js` | Pane list, one control-mode client per tmux session (`%output` parsing), `send-keys -H` input, launch, viewer-driven resize |
| `src/links.js` | Pane ↔ session matching: exact via hooks or the registry, with a folder + start-time fallback for panes running Claude |
| `src/pricing.js` | Per-model API prices and the per-response cost estimate (a lower bound; see `docs/data-inventory.md`). Update when prices or models change |
| `src/registry.js` | Reads Claude Code's running-session list (`~/.claude/sessions/<pid>.json`, internal format): session id, folder, tmux pane. Never opens the `.key` files there |
| `bin/ctrlc.js` | Launcher CLI (`ctrlc`, `ls`, `attach`, `kill`) |
| `public/` | Dashboard in plain HTML/CSS/JS with no build step: `app.js` (UI), `terminal.js` (xterm.js wrapper), `markdown.js` (safe renderer) |
| `scripts/hooks.js` | Adds and removes the hooks in `~/.claude/settings.json` (marked `# control-c`, backed up first) |
| `docs/` | Design notes: `data-inventory.md` (what data exists and what's used), `remote-access.md` (undecided transport options) |

## Rules that matter

- **Transcript format.** The `.jsonl` format is internal to Claude Code and changes between versions, so every assumption about it belongs in `src/normalize.js` (and, for `~/.claude/sessions`, in `src/registry.js`). Hooks are the documented interface; prefer them for anything critical.
- **Security.** Control-C can type into agents that run shell commands, so treat every change here as security-sensitive.
  - Bind to `127.0.0.1` only, check the `Host` header, and require the token (cookie, `X-Control-C-Token` or Bearer) on every route.
  - The WebSocket must also check `Origin`.
  - Validate any path that comes from a request (see how the hook's `transcript_path` is handled).
- **Rendering.** Never insert transcript content as HTML. Use `textContent`, or `renderMarkdown`, which escapes everything first. The CSP allows inline *styles* only, because xterm.js needs them; scripts stay `'self'`.
- **tmux.** Control-C uses its own server: socket `control-c`, config in `tmux.conf`. Never touch the user's default tmux server.
  - Control clients attach with `ignore-size` so they don't shrink the real terminal.
  - `resizeForViewer` only acts when no real (non-control) client is attached, then sets `window-size latest` again.
- **Terminal input** is sent as UTF-8 bytes in hex (`send-keys -H`), so any key, escape sequence or emoji gets through intact.
- **Dependencies.** Only `ws` and `@xterm/xterm`. Keep them minimal; the frontend has no bundler.
- **Style.** ES modules, Node ≥ 20, small focused modules, comments that explain *why*. Match the surrounding code.

## Roadmap and status

1. Read-only dashboard: **done**
2. Terminal mirror and input: **done**
3. Remote access: secure access from other devices (never an open port), plus notifications for "needs permission" and "turn finished". **On hold** until the owner is ready; data-layer work comes first (see UI status below). The transport isn't decided yet: Tailscale vs. a custom Cloudflare Worker + Supabase relay with end-to-end encryption, and Tailscale may not be installable on every machine. See `docs/remote-access.md` and revisit it before starting.
4. Automation and agents: an MCP server in the hub, headless Agent SDK workers, and task handoff between agents.

**UI status:** the current dashboard is a **demo** that shows what's possible. The owner plans a presentation redesign: research, brainstorming around their own day-to-day challenges, and working with Claude Design. Until then:
- Put effort into the **data layer** (hub, API, tests). `docs/data-inventory.md` lists what's available.
- Keep UI changes minimal, and don't build new screens or visual features without asking.

**Known gaps:**
- Subagent conversations are served by the API (`/api/sessions/<id>/subagents`) but not shown in the UI, and aren't followed live.
- Live cost is an estimate (`costEstimateUSD`, a lower bound, typically 5–15% under) and is in the API only. The UI still shows cost only once a session ends (exact, from the `cost-state` line).
- Only `ctrlc` sessions can be mirrored.
- Dark mode hasn't been checked visually.

## Working with the owner

- **Asking questions:** use the question prompt only for clear choices, with the recommended option first. If they ask "why" or "what", explain in plain prose (what it is, the exact change, why it's needed, what happens without it) and don't send a question prompt.
- **Proposing something they didn't ask for:** explain the reason and offer an option that needs no change.
- **Commits:** commit or push only when asked. The remote is `git@github.com:homak120/Control-C.git`, over SSH.
