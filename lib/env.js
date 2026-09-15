/*
 * Minimal .env.local reader.
 *
 * `server.js` reads tracker credentials at boot, before Next has loaded any env
 * files of its own, so it needs its own loader. Values already present in the
 * real environment always win — nothing here overwrites an exported variable.
 */
const fs = require('fs');
const path = require('path');

let loaded = false;

function loadEnv(file = path.join(process.cwd(), '.env.local')) {
  if (loaded) return;
  loaded = true;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env.local is a normal state — the app just has no trackers wired
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let val = line.slice(eq + 1).trim();
    // strip one layer of matching quotes, if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

module.exports = { loadEnv };
