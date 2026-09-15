/*
 * Role-aware starter skills, seeded into an office's project folder.
 *
 * These mirror the LEAD / WORKER memory protocol that `server.js` already
 * injects as a system prompt — the skills give an agent the full procedure at
 * the moment it needs it, instead of one compressed paragraph at boot.
 *
 * Seeding is idempotent and never overwrites: a skill file that already exists
 * is left exactly as the team edited it.
 */
const fs = require('fs');
const path = require('path');
const { officeSkillsDir, isLead } = require('./skills.js');

function projectBrief(office) {
  const name = office.name || office.id;
  return `---
name: project-brief
description: Read this first in any new task in the ${name} office — how this office maps to its one project, where shared memory lives, and the conventions every agent here follows. Use at the start of a task, when you are unsure what this project is, or before touching an unfamiliar area.
---

# ${name} — office brief

This office owns exactly one project: the directory you are running in.
Everything this office's agents do happens inside it.

## Orient before you act

1. Read \`CLAUDE.md\` at the project root if one exists — it outranks anything here.
2. Read the office memory at \`$OFFICE_MEMORY\` — durable facts, decisions, and the
   team's task board.
3. Read the floor memory at \`$FLOOR_MEMORY\` — things other offices need to know.
4. Skim \`.claude/skills/\` (this folder) for a skill that already covers the task.

## Who you are

Your identity is in the environment, set when your session was spawned:

| Variable | Meaning |
|---|---|
| \`$HARNESS_OFFICE\` | office id (\`${office.id}\`) |
| \`$HARNESS_AGENT\` | your agent id |
| \`$HARNESS_ROLE\` | your role — lead-ish roles follow \`office-lead\`, everyone else \`office-worker\` |
| \`$OFFICE_MEMORY\` | this office's shared memory / task board |
| \`$FLOOR_MEMORY\` | floor-wide memory, shared across every office |

Prefix everything you write to either memory file with \`[${office.id}/<your agent id>]\`.

## House rules

- **Append, never rewrite.** Other agents' memory entries are theirs. Add lines; do
  not edit or delete existing ones.
- **Stay in this project.** This office = this directory. Work that belongs to another
  project belongs to another office — note it in floor memory instead of reaching across.
- **Write down what would surprise the next agent.** A fact only useful to your current
  turn stays in your turn; a fact that changes how someone else works goes in memory.
`;
}

function officeLead(office) {
  const name = office.name || office.id;
  return `---
name: office-lead
description: The delegation and reporting procedure for the LEAD of the ${name} office. Use when you are the office lead — your role or your name says lead/manager/architect/boss — and need to break work down, hand it to your agents, track it, or write the team summary.
---

# Leading the ${name} office

The office memory file (\`$OFFICE_MEMORY\`) is the team's task board. It is the only
channel your workers reliably read, so anything you want done must be written there.

## 1. Plan against the real project

Before delegating, know what you are delegating. Read \`CLAUDE.md\`, the office memory,
and enough of the project to split the work along seams that actually exist (an app, a
service, a package) rather than seams you imagined.

## 2. Delegate in writing

Append one line per assignment, using the exact agent id from the floor:

\`\`\`
- [TASK] <agent-id>: <one clear, self-contained task — scope, deliverable, where to start>
\`\`\`

A good \`[TASK]\` line survives on its own: the worker reading it has no other context
from you. Name the files or directories it covers and say what "done" looks like.

For anything bigger than a couple of lines, write the breakdown as a section in office
memory and point each \`[TASK]\` at it.

## 3. Check for reports every turn

At the start of every turn, re-read \`$OFFICE_MEMORY\` and look for new \`[DONE]\` entries
from your workers. That is how work comes back to you — nothing else notifies you.

Review each report against the task you wrote. If a report is thin, wrong, or skipped
part of the scope, append a follow-up \`[TASK]\` rather than fixing it yourself.

## 4. Summarise when the batch lands

Once the delegated work is reported done, append:

\`\`\`
- [SUMMARY] [${office.id}/<your agent id>]: <what the team completed, the results, what remains>
\`\`\`

Then give the same summary to the human in your own panel — the memory entry is the
durable record, your reply is what they actually read.

## 5. Escalate across offices via floor memory

Anything another office needs — a shared decision, an interface change, a blocker they
own — goes in \`$FLOOR_MEMORY\`, prefixed with \`[${office.id}/<your agent id>]\`. Do not
reach into another office's project.
`;
}

function officeWorker(office) {
  const name = office.name || office.id;
  return `---
name: office-worker
description: The pick-up-work and report-back procedure for a worker agent in the ${name} office. Use at the start of every turn to find tasks assigned to you, and whenever you finish a piece of work and must report it to the lead.
---

# Working in the ${name} office

## 1. Check the board first

At the start of every turn, read \`$OFFICE_MEMORY\` and look for lines addressed to you:

\`\`\`
- [TASK] <your agent id>: ...
\`\`\`

Your agent id is in \`$HARNESS_AGENT\`. A task assigned to you there outranks idle
waiting — pick it up unless the human in your panel has given you something else.

If a \`[TASK]\` is ambiguous, do the unambiguous part, then say what was unclear in your
\`[DONE]\` entry. Do not silently guess at scope.

## 2. Do the work in this project

This office owns one project — the directory you are running in. Read \`CLAUDE.md\` and
the relevant code before editing. Follow the project's own conventions over your habits.

## 3. Report back — every time

**A task is not finished until its \`[DONE]\` entry is written.** When you finish a piece
of work — whether the lead assigned it or the human asked directly — append to
\`$OFFICE_MEMORY\`:

\`\`\`
- [DONE] [${office.id}/<your agent id>] <task>: <what you did, files touched, result>
\`\`\`

Make it useful to someone who did not watch you work: the actual paths you changed, what
you verified (tests run, output seen), and anything still open. "Done" alone is not a report.

The lead reads these entries and writes the team \`[SUMMARY]\` from them — a missing
report reads as work that never happened.

## 4. Record what outlasts the task

Durable facts, gotchas, and decisions go in \`$OFFICE_MEMORY\` as their own bullets,
prefixed \`[${office.id}/<your agent id>]\`. Anything another office needs goes in
\`$FLOOR_MEMORY\`. Append only — never rewrite another agent's lines.
`;
}

function triageBacklog(office) {
  const name = office.name || office.id;
  return `---
name: triage-backlog
description: How the LEAD of the ${name} office turns tracker tickets into assigned work. Use when new [TICKET] rows appear on the office board, when asked to triage or check the backlog, or at the start of a turn if the board has unassigned tickets.
---

# Triaging the ${name} backlog

Tickets arrive on the office board automatically — the floor polls this office's
tracker every few minutes and appends a row per new item:

\`\`\`
- [TICKET] <KEY> <title> — <state> · <priority> · <url>
\`\`\`

You do not fetch them yourself. Your job starts once they are on the board.

## 1. Read the board, then the code

Read \`$OFFICE_MEMORY\`. Collect every \`[TICKET]\` row that has no matching
\`[TASK]\` line naming its key — those are unassigned.

Open the ticket URL only if the one-line title is not enough. Then look at the
actual project before you decide who takes it: a ticket's real size lives in the
code, not in its description.

## 2. Take only what the office can finish

Pick the tickets worth starting now, urgent and high first. Leave the rest on the
board — an unassigned \`[TICKET]\` row is a queue, not a backlog you must drain.
Do not assign two tickets to the same dev at once.

## 3. Assign, one line per ticket

\`\`\`
- [TASK] <agent-id> <TICKET-KEY>: <what to build, which files/areas, what done looks like>
\`\`\`

Always include the ticket key — that is how the dev links its branch, its PR and
its report back to this ticket. Name the agent by its floor id, not its display
name. Match the work to the dev: whoever owns that part of the project.

If a ticket is too vague to act on, do not assign it. Append instead:

\`\`\`
- [BLOCKED] <TICKET-KEY>: <the specific question that has to be answered first>
\`\`\`

## 4. Collect the PRs

Devs report back with \`[DONE]\` lines carrying a PR URL. At the start of every
turn, check for new ones, review what each claims, and when a batch is finished
append:

\`\`\`
- [SUMMARY] [${office.id}/<your agent id>]: <tickets closed, PR links, what is left>
\`\`\`

Give the human the same summary in your own panel, PR links included.
`;
}

function ticketToPr(office) {
  const name = office.name || office.id;
  return `---
name: ticket-to-pr
description: How a dev in the ${name} office takes an assigned ticket from the office board all the way to an open pull request. Use whenever you pick up a [TASK] line that carries a ticket key, and follow it through to reporting the PR URL back to the lead.
---

# Ticket to PR

You have a \`[TASK]\` line with a ticket key. Take it to an open PR, then report it.

## 1. Understand the ticket before touching anything

Read the \`[TICKET]\` row for that key in \`$OFFICE_MEMORY\` and open its URL if the
title is not enough. Read \`CLAUDE.md\` and the code the ticket touches. If the
task turns out to be materially different from what the lead assumed, say so in
your report rather than quietly building something else.

## 2. Branch

Never work on the default branch. Branch from an up-to-date base:

\`\`\`bash
git fetch origin && git switch -c <type>/<TICKET-KEY>-<short-slug> origin/<default-branch>
\`\`\`

\`<type>\` is \`feat\`, \`fix\`, \`chore\` or \`refactor\` — whichever the ticket is.

## 3. Build it, and prove it

Make the change. Then run whatever this project uses to check itself — lint,
typecheck, tests, build — and get them passing before you go near a commit. If a
check was already failing before your change, say which in your report; do not
silently accept a red result as normal.

## 4. Commit, push, open the PR

Follow the repo's commit convention (check \`git log\` and any commitlint config).
Put the ticket key in the commit subject so the tracker can link it:

\`\`\`bash
git add -A
git commit -m "<type>(<scope>): <what changed> (<TICKET-KEY>)"
git push -u origin HEAD
gh pr create --fill --title "<TICKET-KEY> <ticket title>" --body "<what changed, why, how you verified it, and the ticket URL>"
\`\`\`

One ticket, one branch, one PR. Never bundle two tickets into one PR.

If \`gh pr create\` fails because a PR already exists for the branch, get its URL
with \`gh pr view --json url -q .url\` and use that.

## 5. Report back immediately

The moment the PR is open, append to \`$OFFICE_MEMORY\` — do not batch this up or
wait until the end of your turn:

\`\`\`
- [DONE] [${office.id}/<your agent id>] <TICKET-KEY>: <what you changed, files touched, checks run> — <PR URL>
\`\`\`

The PR URL is the point of the entry: the lead and the floor's task board both
read it from here, and that is how the human sees your PR the moment it exists.
A finished ticket with no \`[DONE]\` line has not been delivered.

## What you must not do

- Do not merge your own PR, and do not push to the default branch.
- Do not force-push a branch that is not yours.
- Do not close or re-state the ticket in the tracker; the lead owns its status.
`;
}

/**
 * Write the starter skills an office's roster calls for. Returns the ids created;
 * existing files are left alone, and an office with no project folder is skipped.
 */
function seedOfficeSkills(office, { force = false } = {}) {
  const loc = officeSkillsDir(office);
  if (!loc.configured) return { seeded: [], skipped: 'no project folder', dir: loc.dir };

  const agents = office.agents || [];
  const wanted = [['project-brief', projectBrief]];
  if (!agents.length || agents.some(isLead)) wanted.push(['office-lead', officeLead]);
  if (!agents.length || agents.some((a) => !isLead(a))) wanted.push(['office-worker', officeWorker]);
  // Tracker skills only make sense once an office is wired to a board.
  if (office.tracker?.provider) {
    if (!agents.length || agents.some(isLead)) wanted.push(['triage-backlog', triageBacklog]);
    if (!agents.length || agents.some((a) => !isLead(a))) wanted.push(['ticket-to-pr', ticketToPr]);
  }

  const seeded = [];
  for (const [id, build] of wanted) {
    const file = path.join(loc.dir, id, 'SKILL.md');
    if (!force && fs.existsSync(file)) continue; // never clobber a team's edits
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, build(office));
    seeded.push(id);
  }
  return { seeded, dir: loc.dir };
}

module.exports = { seedOfficeSkills };
