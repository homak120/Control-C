# Data inventory

What Control-C can know about Claude Code sessions, where each piece comes from, and whether the hub uses it yet. It's the starting point for the UI redesign: map a challenge ("I want to see X") to the data that would answer it.

Surveyed on 2026-10-09 from the hub's code and 44 real transcripts (Claude Code 2.1.x). **Status:** **Used** = parsed and served by the hub's API today (not necessarily shown in the UI yet); **Available** = present in the source but not used yet; **Derived** = can be computed from the above.

## Sources at a glance

| Source | What it is | Strengths | Weaknesses |
|---|---|---|---|
| **Transcripts** | `~/.claude/projects/<project>/<session>.jsonl`, one JSON line per event, written by Claude Code | Complete history of every session, including closed ones; no setup | Internal format that changes between versions; can't tell "waiting for permission" from "running a long command" |
| **Hooks** | Claude Code runs a command on each event; ours POSTs the event to the hub | Documented interface; exact live state; reports the tmux pane | Live only (nothing for past sessions); needs a settings change, which a managed machine may block; hub must be running to receive them |
| **Session registry** | `~/.claude/sessions/<pid>.json`, one file per running Claude process | Exact session ↔ tmux pane link without hooks; follows `/clear`; coarse live status | Internal format; running sessions only; `.key` files beside it are secrets and never read |
| **tmux** | Control-C's own tmux server, for sessions started with `ctrlc` | The real screen and keyboard | Only `ctrlc` sessions; nothing for plain `claude` |

## 1. Transcripts

### Session facts
| Data | Status | Notes |
|---|---|---|
| Session id, project folder, working directory | Used | |
| Title (custom title, AI-generated title, agent name, or first prompt) | Used | |
| First and last activity time | Used | |
| Model, Claude Code version, git branch | Used | |
| Permission mode (default, plan, auto…) | Used | Parsed into the session summary; not shown prominently |
| Prompt count, transcript size | Used | |
| `/clear` and resume chains (`continued-in`) | Used | Links a session to its continuation |
| Closed or still open | Used | "Closed" means a `cost-state` line was written at exit |
| Entry point (CLI, IDE, SDK…) and user type | Available | |
| Effort level, per turn | Available | |
| Remote/bridge session info | Available | When a session is driven from claude.ai |

### Conversation content
| Data | Status | Notes |
|---|---|---|
| Your prompts, including image count and whether a human typed them | Used | Clipped at 20,000 characters |
| Slash commands and their output | Used | |
| Claude's replies (text) | Used | |
| Thinking blocks and thinking token counts | Used | Shown as a marker, not the content |
| Tool calls: name, a one-line summary, full input | Used | Input clipped at 4,000 characters |
| Tool results: output, error flag, size | Used | Clipped at 4,000 characters |
| Turn duration and message count | Used | From `turn_duration` |
| Compaction events (before/after tokens) and summaries | Used | |
| "While you were away" recaps | Used | |
| Message threading (`uuid` / `parentUuid`) | Available | Shows branches, edits and retries |
| Interrupted messages, API errors | Available | |
| Queued prompts (typed while Claude was busy) | Available | `queue-operation` lines |
| Attachments (files, IDE selections, reminders added to context) | Available | `attachment` lines, very frequent |

### Tool detail (structured results)
| Data | Status | Notes |
|---|---|---|
| File edits: path, old/new text, a structured diff, original file | Available | Enough to show real diffs and a "files changed" list |
| Bash: stdout, stderr, interrupted, background task id | Available | |
| Git operations run through Bash | Available | |
| Permission decisions and denials (`permissionDecision`, `toolDenialKind`) | Available | Which tools you approve or reject, and how often |
| Questions Claude asked you and your answers | Available | |
| Which skill or MCP server and tool was used | Available | |
| File history snapshots (backups before edits) | Available | What `/rewind` uses |

### Usage and cost
| Data | Status | Notes |
|---|---|---|
| Output tokens per reply | Used | Summed per session |
| Input, cache-read and cache-write tokens per reply | Used | Summed per session; feed the live cost estimate (`src/pricing.js`) |
| Live cost estimate, unpriced-response count | Used | API only. A **lower bound**, see Limits |
| Final cost, API time, models used | Used | Only at session end (`cost-state`) |
| Lines added and removed, total tool time, total duration, per-model usage | Available | Also in `cost-state`, at session end only |
| Thinking time per reply | Available | |

### Related files
| Data | Status | Notes |
|---|---|---|
| Subagent transcripts (`<session>/subagents/`) | Used | API only: `/api/sessions/<id>/subagents` lists them, `/api/sessions/<id>/subagents/<agentId>` returns the conversation. Read on request, not followed live |
| Subagent metadata (`agent-<id>.meta.json`): type, description, launching tool call, spawn depth, fork flag | Used | `toolUseId` ties a subagent to the parent's Agent tool call |
| Per-project memory (`<project>/memory/`) | Available | What Claude remembers about each project |

## 2. Hooks

Installed events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, PreCompact.

| Data | Status | Notes |
|---|---|---|
| Live state: working, running a tool, needs you, compacting, idle, ended | Used | |
| Current tool name | Used | |
| "Needs you" message (e.g. which permission is being asked for) and notification type | Used | |
| Session start reason (new, resume, `/clear`, compact) and end reason | Used | |
| tmux pane of the session | Used | Exact pane ↔ session link |
| Transcript path | Used | Triggers an immediate read |
| Recent event log (last 500) | Used | `/api/hooks`; kept in memory only, lost on hub restart |
| Full tool input before it runs (PreToolUse) | Available | Payload has it; we keep only the tool name |
| Tool output after it runs (PostToolUse) | Available | |
| Subagent finished | Available | Event installed, not interpreted |
| Permission mode at each event | Available | |

## 3. Session registry (running processes)

| Data | Status | Notes |
|---|---|---|
| Process id, session id, folder | Used | Session id switches to the new one after `/clear` (verified 2026-10-09) |
| tmux pane (`<session>:@<window>.%<pane>`) | Used | Exact pane ↔ session link without hooks |
| Coarse status (`busy` / `idle`) and when it changed | Available | A hook-free live-state signal |
| Version, entry point, kind (interactive…), start time, derived name | Available | |
| Whether a session is running in a normal terminal, not tmux | Used | Stops the folder guess from borrowing it |

## 4. tmux (`ctrlc` sessions only)

| Data | Status | Notes |
|---|---|---|
| Live screen output and current screen snapshot | Used | |
| Sending any key or text | Used | |
| Pane size, folder, running command, process id, created time | Used | |
| Whether a real terminal is attached | Used | |
| Pane exited (dead) | Used | Kept on screen after Claude exits |
| Scrollback history (50,000 lines) | Available | |

## 5. Derived (can be computed, not built)

- **Waiting on you:** how long sessions sit in "needs you" before you respond, per session and per day.
- **Live cost estimate:** built per session (API only). Still to derive: per turn, project or day.
- **Activity over time:** sessions, prompts, turns and cost per day or project; busiest hours.
- **Turn profile:** how long turns take, how many tool calls each one makes, and which tools dominate.
- **Permission patterns:** which tools and commands you approve or deny most. That's useful for tuning permission settings.
- **Files touched:** per session and project, with diffs and lines added/removed.
- **Errors and friction:** failed tools, interruptions, API errors, compactions.
- **Session lineage:** the chain of `/clear`, resume and continuation across sessions.
- **Running now:** every live session with its state, across all projects at once.

## Limits to design around

- **The transcript format is unofficial.** Fields appear, change or disappear between Claude Code versions. All parsing stays in `src/normalize.js`, and features should degrade gracefully when a field is missing.
- **Hooks may be unavailable.** On a machine you don't control, an organization can lock Claude Code so that only hooks it approves will run. Control-C then falls back to transcripts only:
  - status is less precise
  - "needs permission" can't be detected reliably
  - terminal links come from the session registry, or the folder-based guess if that's missing too
- **Hook history isn't stored.** Live state starts empty when the hub restarts, and past sessions have no hook data.
- **Exact cost arrives only at exit.** Anything earlier is an estimate, and a **lower bound**:
  - Not every API call Claude Code makes appears in the transcript, e.g. compaction summaries and background classifier calls.
  - Subagent usage is in separate files and isn't added to the session estimate.
  - Checked on 2026-10-09 against 39 closed sessions: the estimate was 19% under the exact total overall, typically 5–15% per session, and up to 39% on long sessions with compactions.
  - Applied to Claude Code's own token totals, the price table reproduces its exact cost to within about 1%, so the gap is in the missing usage, not the prices.
  - Prices live in `src/pricing.js` and need updating when prices change or new models ship.
- **Terminal data exists only for `ctrlc` sessions.**
- **Sensitive content.** Transcripts contain file contents, command output and anything pasted into a session. Any feature that stores, summarizes or sends this data elsewhere must be designed with that in mind.
