/*
 * Native macOS folder picker.
 *
 * A web page can never hand back a real filesystem path — `webkitdirectory`
 * gives names, not paths. But this app ships its own Node server running on the
 * user's Mac, so the *server* opens Finder's own "choose folder" sheet with
 * osascript and returns the POSIX path. Finder's dialog already has a
 * "New Folder" button, so creating a project folder is covered too.
 *
 * The dialog appears on the machine running the server, which is the same Mac
 * that is looking at localhost.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const expandHome = (p) => String(p || '').replace(/^~(?=\/|$)/, HOME);
const prettyPath = (abs) => (abs === HOME ? '~' : abs.startsWith(`${HOME}/`) ? `~${abs.slice(HOME.length)}` : abs);

// `on run argv` so the start directory never has to be escaped into the script.
const SCRIPT = [
  'on run argv',
  '  set startPath to item 1 of argv',
  '  set thePrompt to item 2 of argv',
  '  tell application "System Events"',
  '    activate',
  '    if startPath is "" then',
  '      set chosen to choose folder with prompt thePrompt',
  '    else',
  '      set chosen to choose folder with prompt thePrompt default location (POSIX file startPath as alias)',
  '    end if',
  '  end tell',
  '  return POSIX path of chosen',
  'end run',
];

function runPicker(start, prompt) {
  const args = [];
  for (const line of SCRIPT) args.push('-e', line);
  args.push(start, prompt);
  return new Promise((resolve) => {
    execFile('osascript', args, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ out: String(stdout).trim() });
      // Killed or timed out (the sheet went away without an answer) — same
      // outcome for the caller as the user clicking Cancel.
      if (err.killed || err.signal) return resolve({ cancelled: true });
      // Node puts the whole `osascript -e ... -e ...` invocation in err.message;
      // that must never reach the UI. osascript's own diagnostic is on stderr.
      const detail = String(stderr || '')
        .split('\n')
        .map((l) => l.replace(/^execution error:\s*/i, '').trim())
        .find(Boolean);
      resolve({ error: detail || 'the folder picker closed unexpectedly' });
    });
  });
}

export async function POST(req) {
  if (process.platform !== 'darwin') {
    return Response.json({ error: 'the native picker needs macOS', unsupported: true }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  // Open where the office already points, when that folder still exists.
  let start = expandHome(body.start || '');
  if (start) {
    const ok = await fs
      .stat(start)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!ok) start = '';
  }
  const prompt = String(body.prompt || 'Choose this office’s project folder').slice(0, 200);

  const { out, error, cancelled } = await runPicker(start, prompt);

  if (cancelled) return Response.json({ cancelled: true });
  if (error) {
    // -128 is the user dismissing the sheet; that is not a failure.
    if (/-128|User canceled/i.test(error)) return Response.json({ cancelled: true });
    return Response.json({ error }, { status: 500 });
  }
  if (!out) return Response.json({ cancelled: true });

  // AppleScript returns directories with a trailing slash.
  const abs = path.resolve(out.replace(/\/+$/, '')) || '/';
  return Response.json({ ok: true, path: abs, pretty: prettyPath(abs) });
}
