/*
 * Per-office skills, stored where Claude Code natively looks for them:
 * `<office project folder>/.claude/skills/<skill>/SKILL.md`.
 *
 * GET    /api/skills?office=hq             -> the office's skills (+ where they live)
 * GET    /api/skills?office=hq&skill=x     -> one SKILL.md, raw
 * POST   /api/skills { office, skill, content }  -> create / overwrite one
 * POST   /api/skills { office, seed: true }      -> seed the role-aware starters
 * DELETE /api/skills?office=hq&skill=x     -> remove it
 */
import { findOffice, listSkills, readSkill, writeSkill, deleteSkill, officeSkillsDir } from '../../../lib/skills.js';
import { seedOfficeSkills } from '../../../lib/seed-skills.js';

const BLANK_SKILL = (id) => `---
name: ${id}
description: <one line — what this does and when an agent should reach for it>
---

# ${id}

Replace this with the procedure an agent should follow.
`;

function office(req) {
  const oid = new URL(req.url).searchParams.get('office');
  return oid ? findOffice(oid) : null;
}

export async function GET(req) {
  const off = office(req);
  if (!off) return Response.json({ error: 'unknown office' }, { status: 404 });

  const skill = new URL(req.url).searchParams.get('skill');
  if (skill) {
    const found = readSkill(off, skill);
    if (!found) return Response.json({ error: 'unknown skill' }, { status: 404 });
    return Response.json(found);
  }
  const { dir, cwd, raw, configured, skills } = listSkills(off);
  return Response.json({ office: off.id, cwd, folder: raw, configured, dir, skills });
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const off = body.office ? findOffice(body.office) : null;
  if (!off) return Response.json({ error: 'unknown office' }, { status: 404 });

  const loc = officeSkillsDir(off);
  if (!loc.configured) {
    return Response.json({ error: 'this office has no project folder yet — set one first' }, { status: 400 });
  }

  if (body.seed) {
    const res = seedOfficeSkills(off, { force: Boolean(body.force) });
    return Response.json({ ok: true, ...res, skills: listSkills(off).skills });
  }

  if (!body.skill) return Response.json({ error: 'no skill name' }, { status: 400 });
  try {
    const written = writeSkill(off, body.skill, typeof body.content === 'string' && body.content.trim() ? body.content : BLANK_SKILL(body.skill));
    return Response.json({ ok: true, ...written });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}

export async function DELETE(req) {
  const off = office(req);
  const skill = new URL(req.url).searchParams.get('skill');
  if (!off || !skill) return Response.json({ error: 'office and skill required' }, { status: 400 });
  return Response.json({ ok: deleteSkill(off, skill) });
}
