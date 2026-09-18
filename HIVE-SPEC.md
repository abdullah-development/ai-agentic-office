# Hive spec — porting Munder Difflin's agent layer into `agent-offices`

Status: **implemented** (branch `feat/floor-hive`). Phases 0-6 all shipped, plus
the hook plane this spec originally argued against — see §5. Code is the source of
truth for what is built; this document now records *why* it is built that way.

Run `node test/floor.js` to exercise the four loop guards and the hook plane end
to end.

`server.js:53` already says `// ---- shared memory (Munder Difflin-style) ----`. We
took the memory idea and stopped there. This spec covers the rest of it — and,
more usefully, the parts of it we should **not** copy.

---

## 0. Provenance

| | |
|---|---|
| Upstream | https://github.com/chaitanyagiri/munder-difflin |
| Read at commit | `e0d4c3b` (2026-09-15) |
| Primary sources | `HIVE.md` (design), `src/main/hive.ts` (3,494 lines — the on-disk layer + prompt injection), `src/main/hooks.ts`, `src/shared/hiveNudge.ts` |
| Their stack | Electron + `node-pty` + xterm.js. Ours is Next.js + `node-pty` + xterm.js — close enough that most of it ports directly. |

**Read this before trusting `HIVE.md`.** Their design doc and their shipped code
disagree on one important point (§1.5). Where they disagree, this spec follows the
code.

---

## 1. What Munder Difflin actually does

### 1.1 Two planes

- **Terminal plane** — PTYs, the filesystem, the visible office floor. Each agent
  is a genuine CLI process (`claude`, `codex`, `grok`, `gemini`, …) in a pseudo-terminal.
- **Event plane** — the hive: routing, coordination, the event log.

The split that matters: **the agent process is the intelligence, the harness is the
mechanism.** Agents never route, never commit, never deliver. They only read and
write files inside their own directory. Every cross-agent operation is done *for*
them by the main process.

### 1.2 On-disk layout

Lives under `<harnessHome>/hive/`, a git repo:

```
hive/
  PROTOCOL.md            # the agent-facing contract
  COMMANDS.md            # CLI/slash reference handed to agents
  registry.json          # roster: id, role, capabilities, status, seat
  board.md               # shared narrative plan (single scribe: god)
  tasks.json             # structured ledger: todo/doing/blocked/done
  fleet.json             # live per-agent tokens, cost, status, breaker, backlog
  log.jsonl              # append-only event feed
  agents/<agentId>/
    identity.md          # who am I (read-only; harness writes it)
    memory.md            # my long-term memory (read at start, append as I learn)
    inbox/               # messages delivered TO me — <ts>-<msgid>.json
    inbox/.done/         # processed, kept for audit, never deleted
    outbox/              # messages I want to SEND — router drains these
    cursor.json          # { lastProcessed: <msgid> }
```

Three rules make this robust, and all three are load-bearing:

1. **Single-writer-per-file.** An agent writes only inside `agents/<its own id>/`.
   Nothing is ever co-edited by two processes.
2. **One JSON file per message**, written temp-file + atomic `rename`. Never a
   shared mailbox file — those conflict.
3. **Append-only** `log.jsonl`; each consumer tracks its own cursor.

`board.md` is the single exception — genuinely co-edited — so it is funnelled
through one scribe (the god agent). Everyone else `propose`s changes to it.

### 1.3 Message schema (FIPA-lite)

They keep the one good idea from FIPA-ACL/KQML — the **speech act** — and drop the
LISP. Seven semantic fields (`hive.ts:54`, `HIVE.md` §4):

```jsonc
{
  "id":             "2026-05-30T14-03-11-123Z-a1b2",  // unique, time-sortable
  "conversation":   "conv-7f3",                        // groups a thread
  "in_reply_to":    "<prev msgid> | null",
  "from":           "agent.researcher",
  "to":             "agent.coder | god | broadcast",
  "act":            "request | inform | propose | query | agree | refuse | done",
  "subject":        "short human-readable summary",
  "body":           "free text / markdown / structured payload",
  "hops":           3,        // ++ per reply; capped to kill ping-pong
  "requires_reply": true,     // only request/query/propose obligate a reply
  "needs_human":    false,    // router/god may flip this to escalate
  "created_at":     "ISO-8601"
}
```

The agent writes only `to`, `act`, `subject`, `body` (+ optional `conversation`,
`in_reply_to`). **The harness fills in `id`, `from`, `hops`, timestamps** and
defaults `requires_reply` from the act.

### 1.4 Routing and the four loop guards

The router watches every `outbox/`, moves each message into the recipient's
`inbox/`, appends to `log.jsonl`, and commits. Anti-livelock, in layers:

| Guard | Mechanism |
|---|---|
| Ping-pong between two agents | Only `request`/`query`/`propose` obligate a reply. `inform`/`done` are **terminal** — replying to them is a protocol violation. |
| Runaway threads | Every reply increments `hops`; `HOP_CAP = 12` (`hive.ts:192`); past it the message is **dropped** with a `{kind:'drop', reason:'hop-cap'}` log entry. |
| Reprocessing | Per-agent `cursor.json` + handled messages move to `inbox/.done/`. Re-seeing an id is a no-op. |
| Unknown recipient | `deliver()` returns `false` when the target inbox doesn't exist, so the caller bounces and logs rather than letting the message vanish. |

### 1.5 Waking an idle agent — ⚠️ their design doc is out of date here

`HIVE.md` §5 and §7 describe the autonomy loop as a **`Stop` hook that returns
`{"decision":"block","reason":<messages>}`** to force an agent that has unread mail
to keep working, guarded by `stop_hook_active`.

**The shipped code deliberately abandoned that.** `hooks.ts:258-266`:

> ```
> // Never turn unread hive mail into a forced continuation at Stop. That old
> // path bypassed terminal-draft/HITL safety and could spend credits while a
> // user was answering a question. Inbox files remain durable; the renderer
> // wakes the agent later through its guarded idle-only delivery path.
> ```

What ships instead is a **queued, idle-gated nudge** (`src/shared/hiveNudge.ts`):
text is *queued* the moment fresh mail is seen, but *typed into the TUI* only once
the agent is idle and off cooldown, and it survives a reload in a persisted queue.
One nudge pending at a time (deduped by matching the fixed head string). The nudge
names message ids but insists the inbox directory is authoritative:

> `You have new hive inbox message(s) — at least: <ids>. Read your inbox, act on
> what is pending there, and move handled ones to inbox/.done/. Your inbox
> directory is authoritative: work everything still pending in it, and if a named
> id is already in inbox/.done/ you handled it on an earlier turn and can ignore
> that one. Act autonomously; only message god if you genuinely need a decision.`

The ids are explicitly **diagnostic, not a work list** — they let an agent tell "I
already did this" from "I was woken for nothing" without burning a round-trip.

**This is the single most important finding for us**, because we already have this
exact mechanism (`nudgeLead`, `drainNudges`, `idleLeadSession`, `NUDGE_DRAIN_MS`,
`NUDGE_SUBMIT_DELAY_MS`) built for tracker tickets. We do not need hooks. We need
to point the machinery we already have at a mailbox instead of at Plane.

### 1.6 The god agent

A fixed always-on agent (`Michael`, seat `desk-ceo`, flagged `isGod`) — an ordinary
`claude` process, not special code. It owns:

- **Roster & routing** (`registry.json`)
- **Adjudication** — resolves routine requests itself, escalates only critical ones
- **Blackboard scribe** — sole writer of `board.md`
- **Task ledger** (`tasks.json`) — assign, track, retry

Two design points worth stealing outright:

- **The escalation policy lives in the prompt, not the code.** "Tune the prompt,
  not the code" is stated as the primary control surface.
- **There is no separate approval queue.** Human-in-the-loop is native: the tool
  permission prompt in the agent's own session *is* the gate, approvable remotely
  from a phone via `/remote-control`.

Its dispatch prompt requires every delegated task to be a **4-part contract**:

> (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the expected deliverable/format;
> (3) TOOLS — what to use or avoid, and any references to read instead of
> re-deriving; (4) BOUNDARIES — scope limits + the definition of done.
> Pass references (file paths, message ids, board sections), not pasted content.

And it must **check the live roster before spawning**: prefer routing to an existing
agent, especially when the human names one, rather than reflexively creating a new
one.

### 1.7 Memory

Markdown first, deliberately. Per-agent `memory.md` + shared board, with SQLite FTS
when keyword recall isn't enough. From `HIVE.md` §2.4: a heavyweight vector layer
(Letta/Mem0/Zep) is *"not needed at 5–15 agents and is architecturally wrong here —
they want to own the agent runtime; our runtime is the `claude` CLI."*

Phase 3 added an optional **MemPalace CLI** wrapper: one shared palace, each agent's
`memory.md` mined into its own wing (mtime-gated), recall via `mempalace search`.
Detect-and-degrade — a no-op when `mempalace` isn't installed. Their own doc still
lists reflection/summarization to bound `memory.md` growth as **open**.

### 1.8 Guardrails

- **Circuit breaker**, escalating `steer → constrain → stop`, watching for tool
  loops, error storms, overspend. It messages the offending agent *through its own
  inbox* — the agent is told "you ARE the problem it caught".
- **Per-agent token budgets**, real cost read from transcripts, surfaced in `fleet.json`.
- **HITL gate at `PreToolUse`** — deny is immediate and race-free; slow human
  *approval* is left to Claude's native prompt.

### 1.9 Prompt injection + the cache invariant

Injected via `--append-system-prompt` at spawn. `hive.ts:1410` carries a warning we
should copy verbatim into our own code:

> 🔒 **PROMPT-CACHE INVARIANT** — keep this prefix VOLATILE-FREE. It interpolates
> only values stable for an agent's whole lifetime (name, id, dir, root). Do NOT add
> dates, UUIDs, counters, board/registry state, or any `Date.now()`-derived text
> here: a prefix that changes per spawn defeats Anthropic's prompt cache
> (re-priming the whole system prompt every turn). Volatile context belongs on the
> live channels — the inbox and the PTY — never baked into this prefix.

Also: 🪟 **no shell syntax** in the prefix. Every path is written the way the *agent*
will read it, not the way a shell would expand it.

The core injected protocol is only six lines:

```
You are "<name>" (<id>), an autonomous agent in a collaborating hive of Claude agents.
Your private workspace is <dir>. The shared hive is <root>. Full protocol: <root>/PROTOCOL.md.

HIVE PROTOCOL — follow it every task:
1. At the START of a task, read <dir>/memory.md and EVERY file in <dir>/inbox (messages other
   agents sent you). After handling an inbox message, move its file into <dir>/inbox/.done.
2. Record durable facts, decisions, and context by appending to <dir>/memory.md.
3. To ask another agent for something or share information, write ONE message JSON into
   <dir>/outbox (schema in PROTOCOL.md). NEVER write into another agent's folder — the
   orchestrator delivers your outbox.
4. At the END of a task, append what you learned to memory.md so future-you remembers.
Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.
```

---

## 2. Where we stand today

| Capability | Munder Difflin | `agent-offices` now |
|---|---|---|
| Per-agent long-term memory | `agents/<id>/memory.md`, single-writer | ✅ `data/floor/agents/<office>__<agent>/memory.md` |
| Agent→agent messaging | atomic JSON mailbox + router | ✅ `lib/mailbox.js`, temp-file + rename |
| Delivery notification | router + idle-gated nudge | ✅ idle-gated PTY nudge for **mail only**, plus a hook ride-along on turns already happening |
| Cross-office escalation | `to: god`, `broadcast` | ✅ `<office>/<agent>`, `lead`, `floor`, `human` |
| Loop guards | terminal acts, hop cap, cursor | ✅ all four, in the router itself |
| Structured task ledger | `tasks.json` kanban | ✅ `lib/ledger.js` + the rail panel; Plane tickets become cards |
| Live fleet view | `fleet.json` | ✅ written every 5s from `agentState()` + hook telemetry |
| Idle-gated TUI nudge | ✅ | ✅ generalised from tickets to any mail (`nudgeMail`/`drainNudges`) |
| Stable resumable sessions | ✅ | ✅ `--session-id` / `--resume` + `data/agent-sessions.json` |
| Prompt injection | `--append-system-prompt` | ✅ same flag, `memoryPrompt()`, cache invariant documented in place |
| Circuit breaker / budgets | ✅ | ✅ `lib/fleet.js` — `steer → constrain → stop`, deny at `PreToolUse` |
| Hook plane | `cth-hook` + UDS | ✅ `bin/floor-hook.cjs` + `lib/hooks.js` — see §5 |

**The honest summary:** we have the two *hard* pieces already (stable sessions,
idle-gated nudging). What we're missing is the mailbox — and the reason it matters
isn't elegance. It's that our current design has every agent in an office appending
to one file, which is the exact co-editing conflict their §2 rules exist to avoid,
and our leads find out about work only by re-reading that file on their own
initiative.

---

## 3. Target design

### 3.1 Vocabulary mapping

| Theirs | Ours | Note |
|---|---|---|
| hive | **floor** | we already say floor |
| god agent | **office lead** | one per office, not one per floor — see §3.7 |
| `harnessHome/hive/` | `data/floor/` | new; sits beside `data/memory/` |
| `registry.json` | `data/state.json` | **already exists** — offices[].agents[] is the roster |
| `board.md` | `data/memory/<office>.md` | keep; demote to narrative only |
| `fleet.json` | `data/floor/fleet.json` | new, written from `agentState()` |

### 3.2 On-disk layout

```
data/
  state.json                     # unchanged — the roster
  agent-sessions.json            # unchanged
  memory/
    floor.md                     # unchanged — cross-office narrative
    <office>.md                  # unchanged — office narrative (NOT the task board any more)
  floor/                         # NEW
    PROTOCOL.md                  # generated at boot, overwritten each boot
    tasks.json                   # structured ledger, all offices
    fleet.json                   # live agent state, written every ~5s
    log.jsonl                    # append-only event feed
    agents/<office>__<agent>/
      memory.md                  # NEW: per-agent private memory
      inbox/         <msgid>.json
      inbox/.done/
      outbox/
      cursor.json
```

Agent directory key is `<office>__<agent>` (double underscore) to keep it one flat
filesystem level while staying unambiguous — our session map already keys on
`office/agent`, and `/` can't appear in a directory name.

### 3.3 Message schema

Adopt theirs unchanged (§1.3), with one added field:

```jsonc
{
  "office": "hq",     // NEW: the sender's office, for cross-office routing/audit
  ...
}
```

`to` accepts: `<agent-id>` (same office), `<office>/<agent-id>` (cross-office),
`lead` (this office's lead), `floor` (broadcast to every lead), `human`.

Keep `HOP_CAP = 12`. Keep `inform`/`done` terminal. These are not optional — they
are the only thing standing between us and two agents burning tokens at each other
overnight.

### 3.4 The router — `lib/mailbox.js` (new)

```js
ensureAgentDirs(oid, aid)            // idempotent, called from spawn path
normalize(partial, from, office)     // fill id/from/hops/created_at/requires_reply
routeMessage(msg)                    // hop cap → drop+log; resolve `to`; deliver
deliver(msg, toKey) -> boolean       // atomic write into inbox; false = unknown
drainOutboxes()                      // scan every agents/*/outbox, route, unlink
pendingInbox(key) -> msg[]           // unread per cursor.json
markDelivered(key, ids)              // advance cursor
atomicWriteJson(p, data)             // temp + rename. Non-negotiable.
```

Driven by `fs.watch` on the `agents/` tree, with a `setInterval` sweep (~2s) as a
backstop — `fs.watch` is unreliable on macOS for nested creates, and we already
learned that with `STATE_FILE` (`server.js:373`).

**No git.** Theirs commits everything through a single committer to avoid
`index.lock` corruption. `data/` is gitignored in our repo and we have no audit
requirement, so `log.jsonl` + atomic writes give us the traceability without the
failure mode. If we ever want history, add it as a periodic snapshot commit from
the server only — never from agents.

### 3.5 Wake path — reuse what we have

Generalise the existing ticket nudge. In `server.js`:

- `idleLeadSession(office)` → `idleAgentSession(oid, aid)`; keep the
  `agentState(key, s) !== 'done'` guard **exactly as is** — that guard is why this
  is safe, and it's the same conclusion upstream reached the hard way (§1.5).
- `nudgeLead(office, tickets)` → `nudgeAgent(key, ids)` using the upstream nudge
  text (§1.5), which is worth copying close to verbatim including the
  "inbox is authoritative / a named id in `.done/` you already handled" clause.
- `drainNudges()` — extend to walk pending inboxes, not just tracker tickets.
- Keep one nudge pending per agent, deduped on the fixed head string.
- Keep `NUDGE_SUBMIT_DELAY_MS` — the type-then-Enter gap is a real TUI paste bug.

### 3.6 Injected prompt — replacing `memoryPrompt()`

`memoryPrompt()` (`server.js:71`) is already cache-stable. Extend it, keeping it
volatile-free — copy the §1.9 invariant into the comment above it.

Replace the `[TASK]`/`[DONE]` team protocol with:

```
MAILBOX PROTOCOL — follow it every task:
1. At the START of a task, read <agentDir>/memory.md and EVERY file in <agentDir>/inbox.
   After handling a message, move its file into <agentDir>/inbox/.done/.
2. To ask another agent for something or share information, write ONE message JSON into
   <agentDir>/outbox/ (schema in data/floor/PROTOCOL.md). NEVER write into another agent's
   folder — the floor router delivers your outbox.
3. Only `request`, `query` and `propose` expect a reply. `inform` and `done` are terminal —
   do not reply to them, or two agents will loop forever.
4. Record durable facts in <agentDir>/memory.md (yours alone). Put in the office memory file
   only what the whole office needs, and in floor memory only what other OFFICES need.
5. For anything ambiguous, cross-cutting, or needing sign-off, message `lead`.
```

Lead agents additionally get the 4-part dispatch contract from §1.6 verbatim — it's
the highest-value paragraph in their whole prompt and it costs us nothing.

Env to add at spawn: `AGENT_DIR`, `FLOOR_ROOT`, alongside the existing
`OFFICE_SKILLS` / `OFFICE_PROJECT`. And extend the existing `--add-dir` to cover
`data/floor` so agents can actually reach their mailbox.

### 3.7 One god, or one lead per office?

**Recommendation: keep leads per-office, add no floor-wide god yet.**

Theirs has exactly one god because it has one flat hive. We have offices that map
1:1 onto separate *projects* (`state.json.cwd`), and the `office-lead` skill already
says *"Do not reach into another office's project."* A single floor-wide god would
either violate that or become a pure message switch.

So: each office's lead is that office's adjudicator and the sole scribe of its
office memory. `to: "floor"` broadcasts to every lead. Revisit if we ever want
automated cross-office task assignment.

### 3.8 `tasks.json`

Adopt the kanban (`todo/doing/blocked/done`, `title`, `assignee`, `priority`,
`deps`, `humanQA[]`) and two upstream rules that read like scar tissue:

- **Always set `assignee` the moment a task is dispatched, and never clear it on
  status change** — "a done card must still say who did the work."
- **`humanQA` asks must be short and in markdown** — one **bold** sentence saying
  what's needed, backticks for paths/values, one bullet per option, ~700 chars max.
  "An ask longer than a short paragraph plus its options is a report, not a
  question." Rewrite an agent's report into that shape; never paste it in raw.

This slots straight into our existing `lib/tickets.js` / Plane integration: a Plane
ticket becomes a `tasks.json` card the lead dispatches.

---

## 4. Implementation phases

| Phase | Deliverable | Touches |
|---|---|---|
| **0 — Skeleton** | `data/floor/` created at boot; per-agent dirs on spawn; `PROTOCOL.md` generated; `--add-dir` extended; `AGENT_DIR`/`FLOOR_ROOT` in env | `server.js`, new `lib/mailbox.js` |
| **1 — Prompt** | `memoryPrompt()` → mailbox protocol (§3.6) + per-agent `memory.md`; cache invariant comment | `server.js:71` |
| **2 — Router** | outbox watcher + sweep, atomic delivery, hop cap, cursor, `log.jsonl` | `lib/mailbox.js` |
| **3 — Wake** | generalise `nudgeAgent`/`drainNudges` to inboxes, keep idle gate | `server.js:380-505` |
| **4 — Ledger** | `tasks.json` + UI panel; Plane tickets land as cards | `lib/tickets.js`, `components/Floor.jsx` |
| **5 — Fleet** | `fleet.json` written from `agentState()`; leads read it for awareness | `server.js` |
| **6 — Guardrails** | hop-cap alerting, per-agent token budget, breaker `steer→constrain→stop` | later |

All seven shipped together, plus the hook plane (§5.1).

**Migration:** existing `[TASK]`/`[DONE]` bullets in `data/memory/*.md` stay
readable — office memory keeps working as narrative. No migration script needed;
the old convention just stops being the delivery mechanism. `hq.md` is 31 KB of
real history, so leave it alone.

---

## 5. Deliberately NOT porting

| Their thing | Why not |
|---|---|
| Git single-committer hive | Solves `index.lock` corruption we don't have — our `data/` is gitignored. Atomic writes + `log.jsonl` are enough. |
| `Stop`-hook forced continuation | **They removed it themselves** (§1.5). Don't rebuild the thing upstream deleted for spending credits behind the human's back. Still not built, and the hook plane below does not reintroduce it. |
| MemPalace / vector recall | Their own doc: architecturally wrong at 5–15 agents, and its public benchmarks are *"overstated per independent audit"*. We have 4 agents. |
| Multi-CLI support (codex/grok/gemini) | We're Claude-only. Their per-CLI `CODEX_HOME` isolation is a large chunk of `hive.ts` we can skip entirely. |
| Floor-wide god agent | §3.7. |

### 5.1 The hook plane — reversed, deliberately

This spec originally listed the hook shim and UDS server as *not worth the
infrastructure cost*, on the grounds that the PTY idle-gate already works. That
call was overruled, and the plane is built: `bin/floor-hook.cjs` (a shim that pipes
each lifecycle event to `data/floor/hooks.sock` and writes the reply to stdout) and
`lib/hooks.js` (the socket server and the per-agent `settings.json` generator).

What changed the arithmetic: the idle-gate can tell you an agent is *busy*, but it
cannot tell you **what** it is doing. Three things only the hooks give us:

- **Exact numbers.** The status payload carries the real `context_window_size` and
  the session's real `total_cost_usd`. Scraping a terminal can only approximate both,
  and a token budget built on an approximation is not a budget.
- **Per-tool events**, which is what the circuit breaker needs to see a loop at all.
  "The same tool with the same arguments, twenty times" is invisible from the screen.
- **A free ride for pending mail.** `SessionStart` and `UserPromptSubmit` can add
  context to a turn that is *already happening* — no extra credits, and it cannot
  wake a sleeping agent, which is the exact property the removed `Stop` hook lacked.

The line we did NOT cross: nothing in the plane ever forces a turn. The idle-gated
PTY nudge, with its `agentState() !== 'done'` guard, is still the only thing that
wakes an idle agent. `PreToolUse` denies only at the breaker's last rung.

The shim fails open on every path — no socket, dead server, slow reply all end in
`exit(0)` with empty stdout. A telemetry layer is never worth a wedged terminal.

---

### 3.5a Tracker tickets do not nudge

§3.5 generalised the ticket nudge to the mailbox. In practice the ticket half had
to go: typing every newly-polled ticket into the lead's terminal made it triage on
sight, and on a board carrying junk (`hello world testing`, empty description) it
answered by blocking four cards with questions for the human. A ticket is not an
instruction from a colleague and should not interrupt like one.

So: tickets become ledger cards and `[TICKET]` rows and wait to be looked at. Only
a real inbox message — addressed, from a named sender — wakes an idle agent.
`MAIL_NUDGE=0` turns even that off.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Nudge lands while agent is mid-task | Keep `agentState() !== 'done'` gate; queue, never force |
| Two agents ping-pong overnight | Terminal acts + `HOP_CAP=12` + drop-and-log. **Ship in phase 2, not later.** |
| `memory.md` unbounded growth | Open upstream too. Cap at ~2k lines, lead summarises into office memory |
| `fs.watch` misses nested creates on macOS | 2s interval sweep as backstop (we already hit this with `STATE_FILE`) |
| Prompt cache thrash | Cache invariant comment + a test asserting the prefix is byte-identical across two spawns |
| Agent writes into another agent's folder | Prompt forbids it; router only ever reads `outbox/`. Consider a periodic audit that logs foreign writes |

---

## 7. Open questions — resolved

1. **Does the lead adjudicate, or just receive?** *Adjudicate.* The lead prompt
   carries the 4-part dispatch contract, "answer your workers fast — a blocked
   agent is your problem, not theirs", and sole scribe duty over office memory.
2. **Per-agent token budgets?** *Built, off by default.* `FLOOR_USD_STEER` and
   `FLOOR_USD_CONSTRAIN` are `0` (disabled) until someone picks a number; the
   repeat-loop and error-storm rungs are on.
3. **`to: "human"`?** Routes to the office lead, and the ASK ME board is the top
   section of the right rail.

### Still open

- `memory.md` growth is unbounded. Upstream has the same hole. A lead-run
  summarisation pass is the obvious fix and is not built.
- `--settings` merges the floor's `statusLine` over the human's own. `FLOOR_STATUSLINE=0`
  turns it off; there is no per-agent override.
- **`tasks.json` is read-modify-written by two parties.** The server owns it, but the
  protocol also tells agents to keep their own card's status current, and they do —
  the first live lead wrote four `humanQA` asks straight into the file. Writes are
  atomic (temp + rename) so the file is never corrupt, but a concurrent edit can lose
  an update. `openAsks()` normalises entries that never went through `addAsk()`.
  If this bites, the fix is to make the ledger server-owned and have agents `propose`
  status changes by message — more latency, no race.

## 8. Original open questions

1. **Does the lead adjudicate, or just receive?** Upstream's god actively answers
   routine clarifications so the floor stays autonomous. That's a much more
   aggressive prompt than our current lead has, and it's the difference between a
   mailbox and a self-running office. Worth deciding before phase 1.
2. **Per-agent token budgets** — do we want them before the floor grows past the
   ONLINECOOK office?
3. **`to: "human"`** — upstream routes it to god as the human's proxy. Ours should
   probably surface on the ASK ME-style board, which we don't have yet.
