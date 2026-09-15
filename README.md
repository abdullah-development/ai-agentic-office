# Harness Floor — Agent Offices 3D

Next.js port of `Agent Offices 3D.dc.html` with **real Claude Code sessions** attached: each
agent desk is backed by its own `claude` CLI process running in a server-side PTY, streamed to
the browser over WebSocket and rendered with xterm.js.

## Run

```bash
npm install
npm run dev          # http://localhost:3000
# or production:
npm run build && npm start
```

### First run after a clone

The floor is per-machine, so `data/` is git-ignored and you start from a blank one.
On first boot the server copies `data/state.example.json` to `data/state.json` — a
single office with a lead and a dev, and no project folder yet. From there:

1. **Point the office at a project.** Click the office, hit ✎ on its nameplate, then
   **browse** — Finder's own folder sheet opens (use its *New Folder* button if the
   project doesn't exist yet). That folder is the office's one project.
2. **Add your agents.** `+ agent` inside the office. Name them whatever you like; an
   agent whose role *or name* says lead/manager/architect/boss gets the LEAD protocol,
   everyone else gets WORKER.
3. **Add more offices** with `+ office` — one per project.

Skills seed themselves into `<project>/.claude/skills/` the first time a session
spawns in an office that has a folder, and existing skills in that repo are never
overwritten. Nothing of yours is written anywhere until you set a project folder.

You need the `claude` CLI installed and signed in; every agent on the floor gets a
session on boot (`AUTOSTART=0` turns that off).

### What is and isn't in the repo

`.gitignore` keeps the personal half out, because a floor doesn't travel between
machines:

| Ignored | Why |
|---|---|
| `data/state.json` | your offices, their project folders, your agents |
| `data/agent-sessions.json` | Claude session UUIDs, meaningless on another machine |
| `data/memory/*.md` | the agents' accumulated notes about *your* projects |

Committed instead: `data/state.example.json` (the starting floor) and
`data/memory/README.md`.

Options (env vars):

- `PORT` — server port (default 3000)
- `CLAUDE_CMD` — command launched per agent (default `claude`; e.g. `claude --continue`, or
  `zsh` if you just want plain shells)
- `AUTOSTART` — set to `0` to go back to lazy spawning (terminal starts on first open)
- `AUTOSTART_STAGGER_MS` — delay between autostarted sessions (default `600`)

## Every terminal is live on boot

On startup the server reads `data/state.json` and spawns a PTY for **every** agent on the
floor, staggered by `AUTOSTART_STAGGER_MS` so the machine isn't hit with N `claude` launches
at once. By the time you open a desk the session is already up (and, thanks to the stable
session UUIDs below, already resumed). Agents you add later in the UI get a terminal too —
the server watches `data/state.json` and starts anything new. `GET /api/start-all` re-runs
the sweep on demand (useful after killing a session), and `AUTOSTART=0` disables all of it.

## How it maps

| Design concept | Real thing |
|---|---|
| Office | One project folder — one office = one project (`~` is expanded) |
| Agent desk | One persistent `claude` PTY session in that office's cwd |
| Click agent sign | Opens the live terminal panel and attaches (spawns on first open) |
| Desk light / status | Live: orange = session running, grey = not started, yellow = exited |
| Shared memory card | Office info: cwd, agent count, live session count |

## Layout — two rails around the floor

```
┌────────────┬──────────────────────────────┬──────────────┐
│  OFFICES   │                              │  TASK BOARD  │
│  ────────  │            3D floor          │  ──────────  │
│  skills    │      (drag / zoom / fly in)  │  agents·live │
│  memory    │                              │  queued      │
│            │                              │  completed   │
└────────────┴──────────────────────────────┴──────────────┘
```

**Left rail** — every office with its agent count, project folder, and a live-session
count; click to fly in. Below it, the current office's skills card and the shared
memory card (floor memory in top view). This replaces the old bottom tab strip and
the cards that used to float over the floor.

**Right rail** — the live task board, polled every 4s:

| Section | Shows |
|---|---|
| `agents · N live` | every agent with a running session, sorted working → needs you → idle, each with its status dot, the office it's in, its `done` count, and the `[TASK]` text assigned to it |
| `queued · N` | `[TASK]` entries whose agent has no session running |
| `completed · N` | recent `[DONE]` reports across the whole floor |

Colours are the same ones the desk lights use — blue working, yellow needs you,
green done, red not running — so a glance at the rail and a glance at the floor
agree. Clicking an agent row opens its terminal.

The board is parsed from the offices' own memory files by `/api/tasks`; it reads
both `[TASK] <agent>: …` and the arrow form leads tend to write,
`[TASK] <lead> -> <agent> (DISPLAY NAME): …`.

## Status colours

The dot on each agent's name tag (and the desk light) shows what that agent is doing, polled
from `/api/sessions` every 1.5s:

| Colour | State | Meaning |
|---|---|---|
| red | `not running` / `stopped` | no session, or it exited |
| blue | `starting` / `working` | booting, or Claude is actively working (`esc to interrupt` on screen) |
| yellow | `needs you` | a prompt/dialog is waiting, or the last turn ended on a question |
| green | `done` | alive, idle, nothing pending |

State comes from the server's headless mirror of each PTY screen, plus the session transcript
for the "ended on a question" case.

## One office = one project

Each office owns exactly one directory, and every agent in that office runs its
`claude` session there. Set it from the office form — **browse** opens Finder's own
folder sheet (the server runs `osascript` on this Mac, because a web page can never
hand back a real filesystem path), so you can pick an existing repo or use Finder's
**New Folder** button to make a fresh one. If the native sheet isn't available — not
macOS, or `osascript` blocked — the button falls back to an in-page browser with its
own *create here* field. Offices that look like projects (a `package.json`, `.git`,
`CLAUDE.md`, `go.mod`, …) are flagged in that fallback list.

The office nameplate shows the folder, and so does the terminal panel header.
Repointing an office only affects sessions started afterwards — kill a live session
to move it.

An office with no folder still works: its agents fall back to the app directory, and
it gets no office skills (the UI says so rather than writing skills into this repo).

## Office skills

Skills live where Claude Code already looks for them — `<project>/.claude/skills/<name>/SKILL.md`
— so an agent running in the office's folder discovers them natively, no injection
needed. The **office skills** card (top-left, inside an office) lists them with their
descriptions; click one to edit it, `+` to write a new one, delete from the editor.

The first time a session spawns in an office with a project folder, the role-aware
starters are seeded (and never overwrite a file that already exists — your own skills
in that repo are left alone):

| Skill | Seeded when | What it carries |
|---|---|---|
| `project-brief` | always | how the office maps to its one project, where memory lives, the house rules |
| `office-lead` | the office has a lead | the delegate → track `[DONE]` → write `[SUMMARY]` procedure |
| `office-worker` | the office has non-leads | check the board for `[TASK]`, do it, report back with `[DONE]` |

"Has a lead" is read from the agent's **role or its name**, so an agent named
`REH LEAD` that was left at the default `agent` role still leads its office — the
same rule now decides which memory protocol that agent's system prompt gets.

Spawned sessions also get `OFFICE_SKILLS` and `OFFICE_PROJECT` in their environment.

## Shared memory

Hive-style shared memory backed by markdown files in `data/memory/`:

- `data/memory/<officeId>.md` — office memory, shared by every agent in that office
- `data/memory/floor.md` — floor memory, shared across ALL offices

The office memory file doubles as the team's task board. Agents whose role matches
lead/manager/architect/boss get the LEAD protocol: delegate with `- [TASK] <agent>: ...`,
review workers' `[DONE]` reports, then write `- [SUMMARY] ...`. Everyone else gets the
WORKER protocol: check for `[TASK]` entries assigned to them, and always report back with
`- [DONE] [office/agent] <task>: ...` when finished — a task isn't done until it's written.

Every spawned session gets the memory protocol injected via `--append-system-prompt`
(read both files at task start, append durable facts, never rewrite others' entries,
prefix with `[office/agent]`) plus `--add-dir` access to the memory folder, and env vars
`OFFICE_MEMORY` / `FLOOR_MEMORY` / `HARNESS_OFFICE` / `HARNESS_AGENT`. The bottom-left
card shows the live tail (office memory when inside, floor memory in top view; polled
every 4s) and its ✎ opens an editor. Note: a custom `CLAUDE_CMD` is run as-is, without
the injection.

## Persistence — nothing starts over

Each agent owns a stable Claude session UUID (stored in `data/agent-sessions.json`). The
first spawn claims it with `--session-id`; every spawn after that — after **kill**, a server
restart, or a full reboot — runs `claude --resume <uuid>` and continues the same
conversation. Closing the terminal panel doesn't even end the process; reopening reattaches
and the server repaints the session's *current screen* at your panel's width (it mirrors each
PTY in a headless terminal, resizes the PTY to the attaching client, then sends a snapshot —
replaying raw scrollback would scramble a full-screen TUI drawn at a different width). Only **removing** an agent (× or delete in the edit modal) forgets
its session, so a recreated agent starts a fresh chat. Floor layout persists in
`data/state.json`, shared memory in `data/memory/`.

## Architecture

- `server.js` — custom Next server + `ws` WebSocket bridge at `/pty` + `node-pty` session
  registry (`GET /api/sessions` reports live statuses for the desk lights)
- `lib/skills.js` — office → project folder → `.claude/skills` resolution, skill read/write,
  and the shared `isLead` rule (required by `server.js`, imported by the API routes)
- `lib/seed-skills.js` — the role-aware starter skills and the idempotent seeder
- `app/api/skills/route.js` — list/read/write/delete/seed an office's skills
- `app/api/pick-folder/route.js` — native macOS folder sheet via `osascript`
- `app/api/fs/route.js` — the in-page folder browser fallback (`GET` lists, `POST` mkdirs)
- `app/api/tasks/route.js` — parses every office's memory board into task rows for the right rail
- `components/Floor.jsx` — the 3D CSS floor (camera fly-in, offices, desks, forms, tabs)
- `components/TerminalPane.jsx` — xterm.js terminal wired to the `/pty` socket
- `app/api/state/route.js` — persists the floor layout to `data/state.json`

Note: npm strips the exec bit from node-pty's prebuilt `spawn-helper` on macOS; the
`postinstall` script restores it (fixes `posix_spawnp failed`).
