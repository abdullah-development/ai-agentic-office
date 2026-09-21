#!/usr/bin/env node
/*
 * The hook shim.
 *
 * Claude Code runs this once per lifecycle event, in the agent's own process
 * tree, with the event JSON on stdin. It does as little as possible: stamp the
 * agent id, hand the payload to the floor server over a unix socket, and write
 * whatever comes back to stdout — that stdout is the hook's return value, so the
 * server can deny a tool call or add context to a turn without this file knowing
 * anything about either.
 *
 * ── It always fails open ────────────────────────────────────────────────────
 * No socket, a dead server, a slow reply: every path here ends in `exit(0)` with
 * empty stdout, which Claude Code reads as "no opinion". A hook that could hang
 * or error would wedge the agent it is supposed to be watching, and the whole
 * point of this layer is that it is observational. Telemetry is never worth a
 * stuck terminal.
 */
'use strict';
const net = require('net');

const isStatus = process.argv.includes('--status');
const SOCK = process.env.FLOOR_SOCK;
const AGENT_KEY = process.env.AGENT_KEY || process.env.AGENT_ID || null;

// A status line is on the TUI's critical path; a hook is not. Different budgets.
const TIMEOUT_MS = isStatus ? 1500 : 5000;

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  data += d;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(data || '{}');
  } catch {}
  if (!payload.agent_key) payload.agent_key = AGENT_KEY;

  if (isStatus) {
    // Status-line mode. Claude Code pipes the session status JSON after every
    // response and blocks the TUI waiting for our line, so print the gauge
    // FIRST and forward to the server fire-and-forget. That is also what makes
    // the UI's context gauge push-based: the exact window size arrives with the
    // event instead of being guessed from the model name.
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens;
    const size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write(`ctx ${Math.round(used / 1000)}k/${Math.round(size / 1000)}k (${pct}%)`);
    }
    if (!SOCK) return process.exit(0);
    try {
      const c = net.createConnection(SOCK, () => c.end(`${JSON.stringify(payload)}\n`));
      c.on('error', () => {});
      c.on('close', () => process.exit(0));
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), TIMEOUT_MS).unref();
    return;
  }

  if (!SOCK) return process.exit(0);
  let resp = '';
  const done = () => {
    if (resp) process.stdout.write(resp);
    process.exit(0);
  };
  try {
    const c = net.createConnection(SOCK, () => c.write(`${JSON.stringify(payload)}\n`));
    c.setEncoding('utf8');
    c.on('data', (d) => {
      resp += d;
    });
    c.on('end', done);
    c.on('error', () => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), TIMEOUT_MS).unref();
});
