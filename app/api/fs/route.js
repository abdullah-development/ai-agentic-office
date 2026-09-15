/*
 * Directory browser behind the office folder picker.
 *
 * GET  /api/fs?path=~            -> the directories inside `path`, plus its parent
 * POST /api/fs { path, name? }   -> mkdir -p, so an office can be given a fresh
 *                                   project folder without leaving the UI
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();

const expandHome = (p) => String(p || '').replace(/^~(?=\/|$)/, HOME);

// `~/code/app` reads better than the absolute path in a narrow panel.
const prettyPath = (abs) => (abs === HOME ? '~' : abs.startsWith(`${HOME}/`) ? `~${abs.slice(HOME.length)}` : abs);

// Noise that would bury the real project folders in the list.
const HIDDEN = new Set(['node_modules', '.git', '.next', 'Library', '.Trash', '.DS_Store']);

// What makes a directory look like something an office would want to own.
const PROJECT_MARKERS = ['package.json', '.git', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'CLAUDE.md', 'pom.xml', 'composer.json', 'Gemfile'];

async function looksLikeProject(dir) {
  const hits = await Promise.all(
    PROJECT_MARKERS.map((m) =>
      fs
        .access(path.join(dir, m))
        .then(() => true)
        .catch(() => false),
    ),
  );
  return hits.some(Boolean);
}

export async function GET(req) {
  const asked = new URL(req.url).searchParams.get('path') || '~';
  const target = path.resolve(expandHome(asked) || HOME);

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    // A path that does not exist yet is still a legal answer — the picker shows
    // it as "will be created" rather than erroring out.
    return Response.json({
      path: target,
      pretty: prettyPath(target),
      parent: path.dirname(target),
      exists: false,
      isDir: false,
      entries: [],
      home: HOME,
    });
  }
  if (!stat.isDirectory()) {
    return Response.json({
      path: target,
      pretty: prettyPath(target),
      parent: path.dirname(target),
      exists: true,
      isDir: false,
      entries: [],
      home: HOME,
    });
  }

  let dirents = [];
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    return Response.json({ error: err.message, path: target, pretty: prettyPath(target), parent: path.dirname(target), exists: true, isDir: true, entries: [], home: HOME });
  }

  const dirs = dirents
    .filter((d) => d.isDirectory() && !HIDDEN.has(d.name) && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 500); // a home folder full of junk should not stall the panel

  const entries = await Promise.all(
    dirs.map(async (name) => {
      const abs = path.join(target, name);
      return { name, path: abs, pretty: prettyPath(abs), project: await looksLikeProject(abs) };
    }),
  );

  return Response.json({
    path: target,
    pretty: prettyPath(target),
    parent: target === path.parse(target).root ? null : path.dirname(target),
    exists: true,
    isDir: true,
    project: await looksLikeProject(target),
    entries,
    home: HOME,
  });
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const base = expandHome(body.path || '');
  if (!base) return Response.json({ error: 'no path' }, { status: 400 });

  // `name` is a single new folder inside `path`; without it `path` itself is created.
  const name = String(body.name || '').trim();
  if (name && (name.includes('/') || name === '.' || name === '..')) {
    return Response.json({ error: 'folder name cannot contain /' }, { status: 400 });
  }
  const target = path.resolve(name ? path.join(base, name) : base);

  try {
    await fs.mkdir(target, { recursive: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  return Response.json({ ok: true, path: target, pretty: prettyPath(target) });
}
