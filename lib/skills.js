/*
 * Per-office project folders and skills.
 *
 * One office = one project = one directory. That directory's `.claude/skills/`
 * is where the office's skills live, which is exactly where Claude Code looks
 * for them — so an agent spawned with the office cwd discovers them natively,
 * no injection needed.
 *
 * CommonJS on purpose: `server.js` requires it, the API routes import it.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');

// Same rule the UI uses to turn a name into an id.
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** `~/x` -> `/Users/you/x`; everything else is returned untouched. */
function expandHome(p) {
  if (!p) return '';
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}

/**
 * The directory an office's agents actually run in. Falls back to the app dir
 * when the office has no project folder (or points at one that is gone), which
 * matches what `server.js` has always done for the PTY cwd.
 */
function resolveCwd(cwd) {
  const expanded = expandHome(cwd);
  if (!expanded) return process.cwd();
  return fs.existsSync(expanded) ? expanded : process.cwd();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { offices: [] };
  }
}

function findOffice(oid) {
  return (readState().offices || []).find((o) => o.id === oid) || null;
}

/**
 * Is this agent the office lead?
 *
 * Checked against the role AND the display name on purpose: a floor is usually
 * built by naming an agent "REH LEAD" and leaving the role at its `agent`
 * default, and such an agent is plainly meant to lead.
 */
function isLead(agent) {
  return /lead|manager|architect|boss/i.test(`${agent?.role || ''} ${agent?.name || ''}`);
}

/**
 * `<project>/.claude/skills` for an office. `configured` is false when the
 * office has no project folder of its own — the caller should refuse to seed
 * in that case rather than dumping skills into the app's own directory.
 */
function officeSkillsDir(office) {
  const raw = office?.cwd ? String(office.cwd).trim() : '';
  const resolved = resolveCwd(raw);
  const configured = Boolean(raw) && expandHome(raw) === resolved;
  return { cwd: resolved, raw, configured, dir: path.join(resolved, '.claude', 'skills') };
}

// ---- SKILL.md parsing: just enough frontmatter for the list view ----

function parseSkill(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return meta;
}

function listSkills(office) {
  const loc = officeSkillsDir(office);
  let names = [];
  try {
    names = fs
      .readdirSync(loc.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    names = [];
  }
  const skills = [];
  for (const name of names) {
    const file = path.join(loc.dir, name, 'SKILL.md');
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // a directory without a SKILL.md is not a skill
    }
    const meta = parseSkill(content);
    skills.push({
      id: name,
      name: meta.name || name,
      description: meta.description || '',
      file,
      bytes: Buffer.byteLength(content),
    });
  }
  return { ...loc, skills };
}

function readSkill(office, id) {
  const loc = officeSkillsDir(office);
  const safe = slug(id);
  if (!safe) return null;
  const file = path.join(loc.dir, safe, 'SKILL.md');
  try {
    return { id: safe, content: fs.readFileSync(file, 'utf8'), file };
  } catch {
    return null;
  }
}

function writeSkill(office, id, content) {
  const loc = officeSkillsDir(office);
  if (!loc.configured) throw new Error('office has no project folder — set one first');
  const safe = slug(id);
  if (!safe) throw new Error('bad skill name');
  const dir = path.join(loc.dir, safe);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
  return { id: safe, file };
}

function deleteSkill(office, id) {
  const loc = officeSkillsDir(office);
  const safe = slug(id);
  if (!safe) return false;
  const dir = path.join(loc.dir, safe);
  // Only ever remove a directory that sits directly under this office's skills dir.
  if (path.dirname(dir) !== loc.dir) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  slug,
  isLead,
  expandHome,
  resolveCwd,
  readState,
  findOffice,
  officeSkillsDir,
  listSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  parseSkill,
};
