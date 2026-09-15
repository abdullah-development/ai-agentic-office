'use client';

import { useEffect, useRef } from 'react';

/**
 * Real Claude Code terminal: attaches to the server PTY for `sessionKey`
 * (spawning it on first attach, in `cwd`) and renders it with xterm.js.
 */
export default function TerminalPane({ sessionKey, cwd, role, onExit, controls }) {
  const hostRef = useRef(null);

  useEffect(() => {
    let term, fit, ws, resizeObs;
    let disposed = false;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 12,
        lineHeight: 1.25,
        cursorBlink: true,
        allowTransparency: true,
        theme: {
          background: '#08080A',
          foreground: '#F5F0E6',
          cursor: '#ED1B2E',
          selectionBackground: 'rgba(237,27,46,.35)',
          black: '#1a1a20',
          red: '#ED1B2E',
          green: '#FF6A1A',
          yellow: '#FFC83D',
          blue: '#9A9AA3',
          magenta: '#FF3B47',
          cyan: '#F5F0E6',
          white: '#F5F0E6',
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams({
        key: sessionKey,
        cwd: cwd || '',
        role: role || 'agent',
        cols: String(term.cols),
        rows: String(term.rows),
      });
      ws = new WebSocket(`${proto}://${location.host}/pty?${params}`);

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output') term.write(msg.data);
        else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[33m[session exited (${msg.code})] — reopen to restart\x1b[0m\r\n`);
          onExit?.();
        }
      };
      ws.onclose = () => {
        if (!disposed) term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
      };

      term.onData((data) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
      });
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });

      resizeObs = new ResizeObserver(() => fit.fit());
      resizeObs.observe(hostRef.current);
      term.focus();

      if (controls) {
        controls.current = {
          kill: () => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'kill' }));
          },
        };
      }
    })();

    return () => {
      disposed = true;
      if (controls) controls.current = null;
      resizeObs?.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [sessionKey, cwd]);

  return <div ref={hostRef} className="hf-term" style={{ position: 'absolute', inset: 0, padding: '8px 4px 8px 12px' }} />;
}
