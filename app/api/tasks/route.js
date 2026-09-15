/*
 * The floor's task board, read out of the offices' shared memory files.
 *
 * `data/memory/<officeId>.md` doubles as each office's board, so the tasks are
 * already there — this just parses them into rows the task sidebar can render:
 *
 *   - [TASK] <agent>: ...                          an assignment
 *   - [TASK] <lead> -> <agent> (DISPLAY NAME): ... the arrow form leads write
 *   - [DONE] [office/agent] <task>: ...            a completed report
 *   - [SUMMARY] [office/agent]: ...                the lead's wrap-up
 */
import { promises as fs } from 'fs';
import path from 'path';
import { readState } from '../../../lib/skills.js';

const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory');

const TASK_LINE = /^\s*[-*]\s*\[TASK\]\s*(.+)$/i;
const TICKET_LINE = /^\s*[-*]\s*\[TICKET\]\s+(\S+)\s+([\s\S]+)$/i;
const BLOCKED_LINE = /^\s*[-*]\s*\[BLOCKED\]\s+(\S+?):\s*([\s\S]+)$/i;
const DONE_LINE = /^\s*[-*]\s*\[DONE\]\s*(.+)$/i;
const SUMMARY_LINE = /^\s*[-*]\s*\[SUMMARY\]\s*(.+)$/i;
// "[office/agent]" prefix that [DONE] and [SUMMARY] entries carry
const WHO = /^\[([^\/\]]+)\/([^\]]+)\]\s*:?\s*([\s\S]*)$/;
// "lead -> developer (R DEV1): body" — the assignee is the right-hand side
const ARROW = /^(\S+)\s*(?:->|→)\s*([^\s(:]+)\s*(?:\(([^)]*)\))?\s*:\s*([\s\S]+)$/;
const COLON = /^([^:]{1,60}?)\s*:\s*([\s\S]+)$/;

// A ticket key at the head of a [TASK] body, e.g. "ROOM-42: do the thing".
const TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
// PR links devs report back with.
const PR_URL = /https?:\/\/\S*\/pull\/\d+\b|https?:\/\/\S*\/merge_requests\/\d+\b/i;

// Markdown is noise in a narrow sidebar; keep the words.
function plain(text) {
  return String(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Match a written-down agent reference to a real agent on the floor. */
function resolveAgent(office, raw) {
  if (!raw) return null;
  const want = String(raw).trim().toLowerCase();
  const agents = office.agents || [];
  return (
    agents.find((a) => a.id.toLowerCase() === want) ||
    agents.find((a) => (a.name || '').toLowerCase() === want) ||
    // "(R DEV1)" display names come through with spaces the id dropped
    agents.find((a) => (a.name || '').toLowerCase().replace(/\s+/g, '') === want.replace(/\s+/g, '')) ||
    null
  );
}

function parseOffice(office, text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);

  lines.forEach((line, i) => {
    let m;
    if ((m = TASK_LINE.exec(line))) {
      const rest = m[1].trim();
      const arrow = ARROW.exec(rest);
      const colon = arrow ? null : COLON.exec(rest);
      const rawWho = arrow ? arrow[2] : colon ? colon[1] : '';
      const body = arrow ? arrow[4] : colon ? colon[2] : rest;
      // Leads write "[TASK] <agent> <TICKET-KEY>: ..." — drop the key before
      // matching, or the agent name comes back as "DEV1 OC-42".
      const who = rawWho.replace(TICKET_KEY, '').replace(/\s+/g, ' ').trim();
      const agent = resolveAgent(office, who) || resolveAgent(office, arrow?.[3]);
      rows.push({
        kind: 'task',
        office: office.id,
        officeName: office.name,
        agent: agent?.id || null,
        agentName: agent?.name || (who ? who.toUpperCase() : 'UNASSIGNED'),
        text: plain(body),
        ticket: TICKET_KEY.exec(rest)?.[1] || null,
        line: i + 1,
      });
      return;
    }
    if ((m = DONE_LINE.exec(line))) {
      const rest = m[1].trim();
      const who = WHO.exec(rest);
      const agent = who ? resolveAgent(office, who[2]) : null;
      rows.push({
        kind: 'done',
        office: office.id,
        officeName: office.name,
        agent: agent?.id || (who ? who[2] : null),
        agentName: agent?.name || (who ? who[2].toUpperCase() : ''),
        text: plain(who ? who[3] : rest),
        ticket: TICKET_KEY.exec(rest)?.[1] || null,
        // the whole point of the report: the PR the human wants to see
        pr: PR_URL.exec(line)?.[0] || null,
        line: i + 1,
      });
      return;
    }
    if ((m = TICKET_LINE.exec(line))) {
      rows.push({
        kind: 'ticket',
        office: office.id,
        officeName: office.name,
        agent: null,
        agentName: '',
        ticket: m[1],
        text: plain(m[2].split(' — ')[0]),
        url: /https?:\/\/\S+/.exec(line)?.[0] || null,
        line: i + 1,
      });
      return;
    }
    if ((m = BLOCKED_LINE.exec(line))) {
      rows.push({
        kind: 'blocked',
        office: office.id,
        officeName: office.name,
        agent: null,
        agentName: '',
        ticket: m[1],
        text: plain(m[2]),
        line: i + 1,
      });
      return;
    }
    if ((m = SUMMARY_LINE.exec(line))) {
      const rest = m[1].trim();
      const who = WHO.exec(rest);
      const agent = who ? resolveAgent(office, who[2]) : null;
      rows.push({
        kind: 'summary',
        office: office.id,
        officeName: office.name,
        agent: agent?.id || null,
        agentName: agent?.name || (who ? who[2].toUpperCase() : ''),
        text: plain(who ? who[3] : rest),
        line: i + 1,
      });
    }
  });
  return rows;
}

export async function GET() {
  const offices = readState().offices || [];
  const all = [];
  for (const office of offices) {
    const file = path.join(MEMORY_DIR, `${String(office.id).replace(/[^a-z0-9_-]/gi, '')}.md`);
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue; // an office whose memory file does not exist yet has no board
    }
    all.push(...parseOffice(office, text));
  }
  // Newest last in the file = newest first in the sidebar.
  all.reverse();
  return Response.json({
    tasks: all,
    counts: {
      task: all.filter((t) => t.kind === 'task').length,
      done: all.filter((t) => t.kind === 'done').length,
      summary: all.filter((t) => t.kind === 'summary').length,
      ticket: all.filter((t) => t.kind === 'ticket').length,
      blocked: all.filter((t) => t.kind === 'blocked').length,
      pr: all.filter((t) => t.pr).length,
    },
  });
}
