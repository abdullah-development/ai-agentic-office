'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import TerminalPane from './TerminalPane';

// Agent state -> dot colour on the name tag (and the desk light).
//   red    = not working (no session, or it died)
//   blue   = working (booting or actively churning)
//   yellow = needs you (a prompt, dialog, or a question it ended on)
//   green  = done (alive, idle, nothing pending)
const STATUS = {
  offline: '#ED1B2E',
  exited: '#ED1B2E',
  starting: '#2E8BFF',
  working: '#2E8BFF',
  waiting: '#FFC83D',
  done: '#35D07F',
};
const STATUS_LABEL = {
  offline: 'not running',
  exited: 'stopped',
  starting: 'starting',
  working: 'working',
  waiting: 'needs you',
  done: 'done',
};
const statusColor = (st) => STATUS[st] || STATUS.offline;
// A session that exists and is usable — drives the "screen is on" desk visuals.
const isLive = (st) => st === 'working' || st === 'waiting' || st === 'done' || st === 'starting';
const PALETTE = ['#ED1B2E', '#FF6A1A', '#FFC83D', '#F5F0E6'];
const TILT = 58;
const TERM_W = 600;
const RAIL_W = 256; // left rail: offices, skills, memory
const TASK_W = 310; // right rail: the live task board

// Roomy dynamic layout: fixed room width, height grows with agent count (unlimited agents).
const PLANE_W = 2400;
const PLANE_MIN_H = 2000;
const PLANE_PAD = 240;
const ROOM_W = 620;
const ROOM_GAP = 150;
const DESK_COLS = 3;
const ZOOM_MIN = 0.14;
const ZOOM_MAX = 2.4;
const deskSlot = (i) => ({ x: 140 + (i % DESK_COLS) * 190, y: 110 + Math.floor(i / DESK_COLS) * 152 });
const roomH = (agentCount) => Math.max(460, 190 + Math.ceil((agentCount + 1) / DESK_COLS) * 152);

// Offices flow in a 2-column grid on the plane, rows as tall as their tallest room.
// The plane itself grows with the grid so no office ever falls off the bottom.
function layoutOffices(offs) {
  const colX = [PLANE_W / 2 - (ROOM_W + ROOM_GAP) / 2, PLANE_W / 2 + (ROOM_W + ROOM_GAP) / 2];
  const pos = [];
  let y = PLANE_PAD;
  for (let i = 0; i < offs.length; i += 2) {
    const row = offs.slice(i, i + 2);
    const rowH = Math.max(...row.map((o) => roomH(o.agents.length)));
    row.forEach((o, c) => pos.push({ x: colX[c], y: y + rowH / 2, h: roomH(o.agents.length) }));
    y += rowH + ROOM_GAP;
  }
  const bottom = offs.length ? y - ROOM_GAP : PLANE_PAD + 430;
  return {
    pos,
    planeH: Math.max(PLANE_MIN_H, bottom + PLANE_PAD),
    contentCY: (PLANE_PAD + bottom) / 2,
    contentW: ROOM_W * 2 + ROOM_GAP + 260, // + the name plates hanging off the left edge
    contentH: bottom - PLANE_PAD + 200, // + the desk signs standing above the top row
  };
}

const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

const RAD = (d) => (d * Math.PI) / 180;
const PERSPECTIVE = 1500;
const PERSPECTIVE_Y = 0.42; // perspective-origin on the stage

// Mirrors the top-view camera transform exactly, perspective included, so the
// fit below knows where a plane point actually lands on screen.
function projectTop(px, py, plane, view, stage, tilt) {
  const x1 = view.z * (px - PLANE_W / 2);
  const y1 = view.z * (py - plane.planeH / 2 + (plane.planeH / 2 - plane.contentCY));
  const a = RAD(-24);
  let X = x1 * Math.cos(a) - y1 * Math.sin(a);
  let Y = x1 * Math.sin(a) + y1 * Math.cos(a);
  const t = RAD(tilt);
  const Z = -Y * Math.sin(t);
  Y *= Math.cos(t);
  X += 46 + view.x;
  Y += -6 + view.y;
  const k = PERSPECTIVE / (PERSPECTIVE - Z);
  const oy = stage.h * PERSPECTIVE_Y;
  return { sx: stage.w / 2 + X * k, sy: oy + (Y + stage.h / 2 - oy) * k };
}

// Corners of every room, padded for the name plate on the left and the desk
// signs standing above the back edge.
function floorCorners(offs, plane) {
  const pts = [];
  offs.forEach((o, i) => {
    const p = plane.pos[i];
    if (!p) return;
    for (const [dx, dy] of [
      [-ROOM_W / 2 - 115, -p.h / 2 - 90],
      [ROOM_W / 2 + 10, -p.h / 2 - 90],
      [ROOM_W / 2 + 10, p.h / 2 + 10],
      [-ROOM_W / 2 - 115, p.h / 2 + 10],
    ])
      pts.push([p.x + dx, p.y + dy]);
  });
  return pts;
}

const bboxOf = (pts, plane, view, stage, tilt) => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [px, py] of pts) {
    const q = projectTop(px, py, plane, view, stage, tilt);
    if (q.sx < x0) x0 = q.sx;
    if (q.sx > x1) x1 = q.sx;
    if (q.sy < y0) y0 = q.sy;
    if (q.sy > y1) y1 = q.sy;
  }
  return { x0, x1, y0, y1 };
};

// Biggest zoom (plus the pan that centres it) that keeps every office on screen.
function fitView(offs, plane, stage, tilt, reserveRight) {
  const pts = floorCorners(offs, plane);
  const box = { l: 18, r: stage.w - reserveRight - 18, t: 14, b: stage.h - 92 };
  if (!pts.length || box.r <= box.l || box.b <= box.t) return { x: 0, y: 0, z: 0.5 };

  const place = (z) => {
    let view = { x: 0, y: 0, z };
    // two centring passes: perspective magnifies the pan, so one nudge isn't exact
    for (let i = 0; i < 2; i++) {
      const b = bboxOf(pts, plane, view, stage, tilt);
      view = {
        ...view,
        x: view.x + ((box.l + box.r) / 2 - (b.x0 + b.x1) / 2),
        y: view.y + ((box.t + box.b) / 2 - (b.y0 + b.y1) / 2),
      };
    }
    const b = bboxOf(pts, plane, view, stage, tilt);
    return { view, fits: b.x1 - b.x0 <= box.r - box.l && b.y1 - b.y0 <= box.b - box.t };
  };

  let lo = ZOOM_MIN, hi = 0.72, best = place(ZOOM_MIN).view;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const r = place(mid);
    if (r.fits) {
      best = r.view;
      lo = mid;
    } else hi = mid;
  }
  return best;
}

// ---- agent mesh: beams that arc through the air between desks ----
// The room is a 3D plane, so a link cannot be one flat line — it is a chain of
// short segments, each translated to its own height and pitched to meet the
// next. They foreshorten with the camera like everything else in the scene.
const LINK_SEGS = 5;
const LINK_BASE_Z = 34; // leaves the desk at monitor height, not off the floor
const LINK_ARC_Z = 88; // extra lift at the midpoint — clears the desks and name signs

// Parabola through both desks, peaking between them.
const linkZ = (t) => LINK_BASE_Z + LINK_ARC_Z * 4 * t * (1 - t);

// Desk slots are fixed, so a link's geometry never changes once computed.
const linkCache = new Map();

function linkSegments(from, to) {
  const key = `${from.x},${from.y}>${to.x},${to.y}`;
  const hit = linkCache.get(key);
  if (hit) return hit;
  const segs = [];
  for (let i = 0; i < LINK_SEGS; i++) {
    const t0 = i / LINK_SEGS;
    const t1 = (i + 1) / LINK_SEGS;
    const ax = from.x + (to.x - from.x) * t0;
    const ay = from.y + (to.y - from.y) * t0;
    const az = linkZ(t0);
    const bz = linkZ(t1);
    // Length along the floor vs the climb, so each segment meets the next.
    const flat = Math.hypot(
      from.x + (to.x - from.x) * t1 - ax,
      from.y + (to.y - from.y) * t1 - ay,
    );
    const yaw = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    const pitch = (Math.atan2(bz - az, flat) * 180) / Math.PI;
    segs.push({
      len: Math.hypot(flat, bz - az),
      // rotateZ aims the segment across the floor, rotateY tips it into the air
      transform: `translate3d(${ax}px,${ay}px,${az}px) rotateZ(${yaw}deg) rotateY(${-pitch}deg)`,
    });
  }
  linkCache.set(key, segs);
  return segs;
}

// Mirrors isLead() in lib/skills.js: the office hub is whoever leads it, by role
// or by name, and failing that the first agent in the room.
const isLeadAgent = (a) => /lead|manager|architect|boss/i.test(`${a?.role || ''} ${a?.name || ''}`);

const slug = (n) =>
  n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new';

// Each agent gets a stable shirt colour so you learn the room by sight.
const SHIRTS = ['#4E5D72', '#725B4E', '#56684D', '#664E66', '#4E6A65', '#6A5D4E'];
const shirtOf = (key) => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return SHIRTS[h % SHIRTS.length];
};

// The agent, seated at the desk: chair back, shoulders, arms on the desk, and a
// headset light that carries the live session status.
function Person({ tone, status }) {
  const lit = isLive(status);
  return (
    <svg width="54" height="52" viewBox="0 0 48 46" style={{ display: 'block', overflow: 'visible' }}>
      <rect x="8" y="26" width="32" height="20" rx="6" fill="#15151B" stroke="#2C2C35" strokeWidth="1.5" />
      <rect x="5.5" y="31" width="8.5" height="15" rx="4.25" fill={tone} opacity=".7" />
      <rect x="34" y="31" width="8.5" height="15" rx="4.25" fill={tone} opacity=".7" />
      <path d="M24 21c7.7 0 13 5.2 13 12.2V46H11V33.2C11 26.2 16.3 21 24 21z" fill={tone} />
      <path d="M24 21c7.7 0 13 5.2 13 12.2V46h-4V33.2C33 26.6 29.2 21.6 24 21z" fill="#000" opacity=".16" />
      <rect x="20.5" y="15" width="7" height="8" rx="3.2" fill="#575763" />
      <circle cx="24" cy="10.5" r="9" fill="#70707E" />
      <path d="M15 10.2a9 9 0 0 1 18 0c-1.5-2.7-5-4.4-9-4.4s-7.5 1.7-9 4.4z" fill="#2B2B34" />
      <circle cx="33.4" cy="9.4" r="2.8" fill={statusColor(status)} opacity={lit ? 1 : 0.75} />
      {lit && <circle cx="33.4" cy="9.4" r="5.2" fill={statusColor(status)} opacity=".28" />}
    </svg>
  );
}

// One office = one project folder; its .claude/skills is that office's playbook.
const EMPTY_SKILLS = { skills: [], configured: false, dir: '', cwd: '', folder: '' };
const SKILL_TEMPLATE = (name) => `---
name: ${name || 'new-skill'}
description: one line — what this does and when an agent in this office should reach for it
---

# ${name || 'New skill'}

Replace this with the procedure an agent should follow.
`;

const mono = { fontFamily: "'IBM Plex Mono', monospace" };
const signBtn = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 8.5,
  lineHeight: 1,
  padding: '2px 5px',
  background: '#0B0B0Ee6',
  border: '1px solid #2C2C35',
  borderRadius: 999,
  color: '#8A8A93',
  cursor: 'pointer',
  userSelect: 'none',
};
const bebas = { fontFamily: "'Bebas Neue', sans-serif" };
const archivo = { fontFamily: 'Archivo, sans-serif' };

export default function Floor() {
  const [offices, setOffices] = useState(null); // null until loaded
  const [inside, setInside] = useState(null);
  const [open, setOpen] = useState(null); // "officeId/agentId"
  const [form, setForm] = useState(null); // 'office' | 'agent' | 'edit-office' | 'edit-agent' | null
  const [editTarget, setEditTarget] = useState(null); // { oid, aid? }
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState('');
  const [cwdDraft, setCwdDraft] = useState('');
  const [editOfficeCwd, setEditOfficeCwd] = useState(''); // folder an edit started from
  const [accent, setAccent] = useState('#ED1B2E');
  const [live, setLive] = useState({}); // sessionKey -> offline|starting|working|waiting|done|exited
  const [memContent, setMemContent] = useState('');
  const [memEditor, setMemEditor] = useState(false);
  const [memDraft, setMemDraft] = useState('');
  // office skills — <project>/.claude/skills, the office's own playbook
  const [skills, setSkills] = useState(EMPTY_SKILLS);
  const [skillEditor, setSkillEditor] = useState(null); // { id, isNew } | null
  const [skillDraft, setSkillDraft] = useState('');
  const [skillName, setSkillName] = useState('');
  const [skillErr, setSkillErr] = useState('');
  // project folder picker, shared by the new-office and edit-office forms
  const [picker, setPicker] = useState(null); // { path } while browsing | null
  const [pickerData, setPickerData] = useState(null);
  const [newFolder, setNewFolder] = useState('');
  const [pickerErr, setPickerErr] = useState('');
  const [pickerBusy, setPickerBusy] = useState(false);
  const [tasks, setTasks] = useState([]); // parsed [TASK]/[DONE]/[SUMMARY] across the floor
  // The floor layer: data/floor/fleet.json + tasks.json + the open ASK ME cards.
  const [floorState, setFloorState] = useState({ fleet: { agents: [] }, tasks: [], asks: [], counts: {} });
  const [askDraft, setAskDraft] = useState({}); // taskId -> the human's answer, mid-typing
  const [tickets, setTickets] = useState({ offices: [], todo: 0 }); // tracker backlog
  // per-office tracker config, edited in the office form
  const [trkProvider, setTrkProvider] = useState('');
  const [trkWorkspace, setTrkWorkspace] = useState('');
  const [trkProject, setTrkProject] = useState('');
  const termControls = useRef(null);
  const loaded = useRef(false);

  // camera: free pan + zoom on top of the fixed isometric rig
  const [view, setView] = useState({ x: 0, y: 0, z: 0.5 });
  const [interacting, setInteracting] = useState(false);
  const [stageEl, setStageEl] = useState(null); // callback ref: the stage mounts after the floor loads
  const [stage, setStage] = useState({ w: 1400, h: 900 });
  const fitRef = useRef({ x: 0, y: 0, z: 0.5 });
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const wheelIdle = useRef(null);

  // keep the stage size measured so "fit everything" stays honest on resize
  useEffect(() => {
    if (!stageEl) return;
    const measure = () => setStage({ w: stageEl.clientWidth, h: stageEl.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stageEl);
    return () => ro.disconnect();
  }, [stageEl]);

  const resetView = useCallback(() => {
    setView({ ...fitRef.current });
  }, []);

  const zoomBy = useCallback((factor, anchor) => {
    setView((v) => {
      const z = clampZoom(v.z * factor);
      if (z === v.z) return v;
      const k = z / v.z;
      if (!anchor) return { ...v, z };
      return { x: anchor.x - k * (anchor.x - v.x), y: anchor.y - k * (anchor.y - v.y), z };
    });
  }, []);

  // wheel = zoom at the cursor (non-passive so the page never scrolls under us)
  useEffect(() => {
    const el = stageEl;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const anchor = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
      zoomBy(Math.exp(-e.deltaY * 0.0016), anchor);
      setInteracting(true);
      clearTimeout(wheelIdle.current);
      wheelIdle.current = setTimeout(() => setInteracting(false), 180);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      clearTimeout(wheelIdle.current);
    };
  }, [zoomBy, stageEl]);

  // drag to pan
  const onPointerDown = (e) => {
    if (e.button !== 0 || form || memEditor || picker || skillEditor) return;
    dragRef.current = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y, moved: false };
    setInteracting(true);
  };
  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setInteracting(false);
      if (d?.moved) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  // keyboard: arrows/WASD pan, +/- zoom, 0 refits
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const step = e.shiftKey ? 220 : 90;
      const nudge = (dx, dy) => {
        e.preventDefault();
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      };
      if (e.key === 'ArrowLeft' || e.key === 'a') nudge(step, 0);
      else if (e.key === 'ArrowRight' || e.key === 'd') nudge(-step, 0);
      else if (e.key === 'ArrowUp' || e.key === 'w') nudge(0, step);
      else if (e.key === 'ArrowDown' || e.key === 's') nudge(0, -step);
      else if (e.key === '+' || e.key === '=') zoomBy(1.18);
      else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.18);
      else if (e.key === '0') resetView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomBy, resetView]);

  // refit whenever the floor grows, the stage resizes, or we switch view mode
  useEffect(() => {
    setView(inside ? { x: 0, y: 0, z: 1 } : { ...fitRef.current });
  }, [inside, offices?.length, stage.w, stage.h]);

  // load / persist floor layout
  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then((st) => {
        setOffices(st.offices || []);
        loaded.current = true;
      })
      .catch(() => setOffices([]));
  }, []);
  useEffect(() => {
    if (!loaded.current || offices === null) return;
    const t = setTimeout(() => {
      fetch('/api/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offices }),
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [offices]);

  // poll live session statuses for the desk lights
  useEffect(() => {
    const tick = () =>
      fetch('/api/sessions')
        .then((r) => r.json())
        .then(setLive)
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 1500); // status dots should feel live
    return () => clearInterval(iv);
  }, []);

  const statusOf = (oid, aid) => live[`${oid}/${aid}`] || 'offline';

  // shared memory: office scope when inside, floor scope in top view
  const memScope = inside || 'floor';
  useEffect(() => {
    let gone = false;
    const tick = () =>
      fetch(`/api/memory?scope=${encodeURIComponent(memScope)}`)
        .then((r) => r.json())
        .then((d) => !gone && setMemContent(d.content || ''))
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 4000);
    return () => {
      gone = true;
      clearInterval(iv);
    };
  }, [memScope]);

  // The task board lives in the offices' memory files; /api/tasks parses them.
  useEffect(() => {
    const tick = () =>
      fetch('/api/tasks')
        .then((r) => r.json())
        .then((d) => setTasks(d.tasks || []))
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 4000);
    return () => clearInterval(iv);
  }, []);

  // The floor: telemetry the agents' own lifecycle hooks reported, the structured
  // ledger, and anything blocked on the human. Everything here is read from
  // data/floor/ — the server writes it, and agents read the same files.
  useEffect(() => {
    const tick = () =>
      fetch('/api/floor')
        .then((r) => r.json())
        .then((d) => setFloorState(d))
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, []);

  // The backlog the server already pulled; this never calls the tracker itself.
  useEffect(() => {
    const tick = () =>
      fetch('/api/tickets')
        .then((r) => r.json())
        .then((d) => setTickets(d || { offices: [], todo: 0 }))
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 15000);
    return () => clearInterval(iv);
  }, []);

  const openMemEditor = () => {
    setMemDraft(memContent);
    setMemEditor(true);
  };
  const saveMemory = () => {
    fetch('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: memScope, content: memDraft }),
    })
      .then(() => setMemContent(memDraft))
      .catch(() => {});
    setMemEditor(false);
  };

  // ---- office skills: <project>/.claude/skills, read straight off disk ----
  // The server resolves the folder from data/state.json, which is saved on a
  // debounce, so a just-edited cwd needs a beat before the list is asked for.
  const insideCwd = (offices || []).find((o) => o.id === inside)?.cwd || '';

  const refreshSkills = useCallback(() => {
    if (!inside) return setSkills(EMPTY_SKILLS);
    fetch(`/api/skills?office=${encodeURIComponent(inside)}`)
      .then((r) => r.json())
      .then((d) => setSkills(d && !d.error ? d : EMPTY_SKILLS))
      .catch(() => setSkills(EMPTY_SKILLS));
  }, [inside]);

  useEffect(() => {
    if (!inside) return setSkills(EMPTY_SKILLS);
    const t = setTimeout(refreshSkills, 600);
    return () => clearTimeout(t);
  }, [inside, insideCwd, refreshSkills]);

  const openSkill = (id) => {
    setSkillErr('');
    fetch(`/api/skills?office=${encodeURIComponent(inside)}&skill=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setSkillErr(d.error);
        setSkillDraft(d.content || '');
        setSkillName(id);
        setSkillEditor({ id, isNew: false });
      })
      .catch(() => setSkillErr('could not read that skill'));
  };

  const startSkill = () => {
    setSkillErr('');
    setSkillName('');
    setSkillDraft(SKILL_TEMPLATE(''));
    setSkillEditor({ id: '', isNew: true });
  };

  const saveSkill = () => {
    // Floor's slug() falls back to 'new' for empty input, so check the raw name.
    if (!skillName.trim()) return setSkillErr('give the skill a name');
    const id = slug(skillName);
    fetch('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ office: inside, skill: id, content: skillDraft }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setSkillErr(d.error);
        setSkillEditor(null);
        refreshSkills();
      })
      .catch(() => setSkillErr('save failed'));
  };

  const deleteSkillNow = () => {
    if (!skillEditor || skillEditor.isNew) return setSkillEditor(null);
    fetch(`/api/skills?office=${encodeURIComponent(inside)}&skill=${encodeURIComponent(skillEditor.id)}`, {
      method: 'DELETE',
    })
      .then(() => {
        setSkillEditor(null);
        refreshSkills();
      })
      .catch(() => setSkillErr('delete failed'));
  };

  // Re-seed the role-aware starters (project-brief + lead/worker protocol).
  // Existing files are never clobbered, so this is safe to hit twice.
  const seedSkills = () => {
    setSkillErr('');
    fetch('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ office: inside, seed: true }),
    })
      .then((r) => r.json())
      .then((d) => (d.error ? setSkillErr(d.error) : refreshSkills()))
      .catch(() => setSkillErr('seed failed'));
  };

  // ---- project folder picker ----
  const loadPicker = (p) => {
    fetch(`/api/fs?path=${encodeURIComponent(p || '~')}`)
      .then((r) => r.json())
      .then((d) => {
        setPickerData(d);
        setPicker({ path: d.pretty || p });
      })
      .catch(() => setPickerErr('could not read that folder'));
  };
  // BROWSE opens Finder's own folder sheet, via the server running on this Mac —
  // a web page cannot hand back a real filesystem path on its own. Finder's
  // dialog carries its own "New Folder" button, so creating a project folder for
  // the office is part of the same step. The in-page browser below is the
  // fallback for when that is not available (not macOS, or osascript blocked).
  const openPicker = () => {
    setPickerErr('');
    setPickerBusy(true);
    fetch('/api/pick-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        start: cwdDraft.trim(),
        prompt: `Choose the project folder for ${draft.trim() || 'this office'}`,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.pretty) return setCwdDraft(d.pretty);
        if (d.cancelled) return; // user dismissed Finder — leave the field alone
        openInPagePicker(d.error || 'could not open the native picker');
      })
      .catch(() => openInPagePicker('could not reach the native picker'))
      .finally(() => setPickerBusy(false));
  };

  const openInPagePicker = (why) => {
    setNewFolder('');
    const start = cwdDraft.trim() || '~';
    setPicker({ path: start });
    setPickerErr(why || '');
    loadPicker(start);
  };
  const createFolder = () => {
    const name = newFolder.trim();
    if (!name || !pickerData?.path) return;
    fetch('/api/fs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: pickerData.path, name }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setPickerErr(d.error);
        setNewFolder('');
        loadPicker(d.pretty || d.path); // step into the folder we just made
      })
      .catch(() => setPickerErr('could not create that folder'));
  };
  const usePickerPath = () => {
    if (pickerData?.pretty) setCwdDraft(pickerData.pretty);
    setPicker(null);
  };

  const startOffice = (e) => {
    e?.stopPropagation();
    setForm('office');
    setDraft('');
    setCwdDraft('');
    setTrkProvider('');
    setTrkWorkspace('');
    setTrkProject('');
    setAccent(PALETTE[(offices?.length || 0) % PALETTE.length]);
  };
  const startAgent = (e) => {
    e?.stopPropagation();
    if (!inside) return;
    setForm('agent');
    setDraft('');
    setRole('');
  };
  // Undefined rather than an empty object, so an office with no tracker keeps a
  // clean state.json entry instead of a husk.
  const trackerDraft = () =>
    trkProvider
      ? { provider: trkProvider, workspace: trkWorkspace.trim(), project: trkProject.trim(), enabled: true }
      : undefined;

  const cancelForm = () => {
    setForm(null);
    setTrkProvider('');
    setTrkWorkspace('');
    setTrkProject('');
    setDraft('');
    setRole('');
    setCwdDraft('');
    setEditTarget(null);
    setPicker(null);
    setPickerErr('');
  };

  const startEditOffice = (o, e) => {
    e?.stopPropagation();
    setForm('edit-office');
    setDraft(o.name);
    setCwdDraft(o.cwd || '');
    setEditOfficeCwd(o.cwd || '');
    setTrkProvider(o.tracker?.provider || '');
    setTrkWorkspace(o.tracker?.workspace || '');
    setTrkProject(o.tracker?.project || '');
    setAccent(o.accent);
    setEditTarget({ oid: o.id });
  };
  const startEditAgent = (o, ag, e) => {
    e?.stopPropagation();
    setForm('edit-agent');
    setDraft(ag.name);
    setRole(ag.role);
    setEditTarget({ oid: o.id, aid: ag.id });
  };

  const refreshLive = () =>
    fetch('/api/sessions').then((r) => r.json()).then(setLive).catch(() => {});

  const removeAgent = (oid, aid, e) => {
    e?.stopPropagation();
    const key = `${oid}/${aid}`;
    fetch(`/api/kill?key=${encodeURIComponent(key)}&forget=1`).catch(() => {});
    setOffices((os) =>
      os.map((o) => (o.id !== oid ? o : { ...o, agents: o.agents.filter((a) => a.id !== aid) }))
    );
    setOpen((cur) => (cur === key ? null : cur));
    setTimeout(refreshLive, 300);
  };

  const removeOffice = (oid) => {
    const off = offices.find((o) => o.id === oid);
    for (const a of off?.agents || []) {
      fetch(`/api/kill?key=${encodeURIComponent(`${oid}/${a.id}`)}&forget=1`).catch(() => {});
    }
    setOffices((os) => os.filter((o) => o.id !== oid));
    setOpen((cur) => (cur?.startsWith(`${oid}/`) ? null : cur));
    setInside((cur) => (cur === oid ? null : cur));
    setTimeout(refreshLive, 300);
  };

  const deleteFromForm = () => {
    if (!editTarget) return;
    if (form === 'edit-office') removeOffice(editTarget.oid);
    else if (form === 'edit-agent') removeAgent(editTarget.oid, editTarget.aid);
    cancelForm();
  };

  const commit = () => {
    const name = draft.trim();
    if (!name) return;
    if (form === 'office') {
      const id = slug(name);
      setOffices((os) => [
        ...os,
        {
          id,
          name: name.toUpperCase(),
          accent,
          x: 0,
          y: 0,
          cwd: cwdDraft.trim(),
          tracker: trackerDraft(),
          agents: [],
        },
      ]);
      setInside(id);
      setOpen(null);
    } else if (form === 'agent') {
      const oid = inside;
      if (!oid) return cancelForm();
      const id = slug(name);
      setOffices((os) =>
        os.map((o) =>
          o.id !== oid
            ? o
            : { ...o, agents: [...o.agents, { id, name: name.toUpperCase(), role: (role.trim() || 'agent').toLowerCase() }] }
        )
      );
      setOpen(`${oid}/${id}`);
    } else if (form === 'edit-office' && editTarget) {
      // rename in place — the id (and session keys) stay stable
      setOffices((os) =>
        os.map((o) =>
          o.id !== editTarget.oid
            ? o
            : { ...o, name: name.toUpperCase(), cwd: cwdDraft.trim(), accent, tracker: trackerDraft() }
        )
      );
    } else if (form === 'edit-agent' && editTarget) {
      setOffices((os) =>
        os.map((o) =>
          o.id !== editTarget.oid
            ? o
            : {
                ...o,
                agents: o.agents.map((a) =>
                  a.id !== editTarget.aid
                    ? a
                    : { ...a, name: name.toUpperCase(), role: (role.trim() || 'agent').toLowerCase() }
                ),
              }
        )
      );
    }
    cancelForm();
  };

  const enter = (id) => {
    if (suppressClick.current) return;
    setInside(id);
    setOpen(null);
  };
  const exit = () => {
    setInside(null);
    setOpen(null);
  };
  const openAgent = (oid, aid, e) => {
    e?.stopPropagation();
    if (suppressClick.current) return;
    setInside(oid);
    setOpen(`${oid}/${aid}`);
  };

  const killSession = useCallback(() => {
    termControls.current?.kill();
    setTimeout(
      () => fetch('/api/sessions').then((r) => r.json()).then(setLive).catch(() => {}),
      300
    );
  }, []);

  if (offices === null) {
    return (
      <div style={{ ...mono, color: '#5A5A62', fontSize: 12, padding: 40 }}>loading floor…</div>
    );
  }

  const insideOff = offices.find((o) => o.id === inside) || null;
  const t = insideOff ? TILT - 26 : TILT;

  const layout = layoutOffices(offices);
  const officePos = layout.pos;
  const PLANE_H = layout.planeH;
  const insidePos = insideOff ? officePos[offices.findIndex((o) => o.id === insideOff.id)] : null;

  // camera that puts the whole floor on screen at once, whatever the office count
  // The rails are flex siblings, so `stage` is already measured without them —
  // only the terminal still overlays the stage and needs its width reserved.
  fitRef.current = fitView(offices, layout, stage, TILT, open ? TERM_W : 0);

  // The memory/skills cards used to float over the stage's left edge; they live
  // in the rail now, so the camera no longer has to dodge them.
  const shift = open ? `translate(-${TERM_W / 2}px,-56px) ` : 'translate(0px,-56px) ';
  const pan = `translate(${view.x}px,${view.y}px) `;
  const camera = insidePos
    ? pan +
      shift +
      `rotateX(${TILT - 26}deg) rotateZ(-24deg) scale(${view.z}) translate3d(${PLANE_W / 2 - insidePos.x}px, ${
        PLANE_H / 2 - insidePos.y
      }px, 0)`
    : pan +
      `translate(46px,-6px) rotateX(${TILT}deg) rotateZ(-24deg) scale(${view.z}) translate3d(0,${
        PLANE_H / 2 - layout.contentCY
      }px,0)`;

  const wallT = `translateZ(26px) rotateZ(24deg) rotateX(${-t}deg)`;
  const screenT = `translateZ(30px) rotateZ(24deg) rotateX(${-t}deg)`;
  const signT = `translateZ(30px) rotateZ(24deg) rotateX(${-t}deg)`;

  let term = null;
  if (open) {
    const [oid, aid] = open.split('/');
    const off = offices.find((o) => o.id === oid);
    const ag = off?.agents.find((a) => a.id === aid);
    if (off && ag) {
      const status = statusOf(oid, aid);
      term = { off, ag, status, color: statusColor(status) };
    }
  }

  // ---- right rail data: who is alive, and what the board says about them ----
  // Blue (working) first, then yellow (needs you), then the idle-but-alive ones,
  // so the sidebar's top is always the thing that wants attention.
  const LIVE_ORDER = { working: 0, starting: 1, waiting: 2, done: 3 };
  const liveAgents = [];
  for (const o of offices) {
    for (const a of o.agents) {
      const st = statusOf(o.id, a.id);
      if (isLive(st)) liveAgents.push({ office: o, agent: a, st });
    }
  }
  liveAgents.sort(
    (x, y) => (LIVE_ORDER[x.st] ?? 9) - (LIVE_ORDER[y.st] ?? 9) || x.agent.name.localeCompare(y.agent.name),
  );
  const openTaskFor = (oid, aid) => tasks.find((t) => t.kind === 'task' && t.office === oid && t.agent === aid);
  const doneCountFor = (oid, aid) =>
    tasks.filter((t) => t.kind === 'done' && t.office === oid && t.agent === aid).length;
  const recentDone = tasks.filter((t) => t.kind === 'done').slice(0, 10);
  // Shipped work first: a [DONE] carrying a PR link is the thing to surface.
  const recentPRs = tasks.filter((t) => t.pr).slice(0, 8);
  const blocked = tasks.filter((t) => t.kind === 'blocked').slice(0, 5);
  // Tracker tickets that nobody has been assigned yet.
  const assignedKeys = new Set(tasks.filter((t) => t.kind === 'task' && t.ticket).map((t) => t.ticket));
  const backlog = tickets.offices
    .flatMap((o) => o.tickets.filter((t) => t.todo).map((t) => ({ ...t, officeName: o.officeName })))
    .filter((t) => !assignedKeys.has(t.key))
    .slice(0, 10);
  const trackerError = tickets.offices.find((o) => o.error)?.error || null;
  const unassigned = tasks.filter((t) => t.kind === 'task' && !liveAgents.some((l) => l.office.id === t.office && l.agent.id === t.agent));

  // ---- floor layer: gauges, asks, ledger --------------------------------
  const fleetRows = floorState.fleet?.agents || [];
  // Anything wrong first: a tripped breaker, then a backlog nobody has read.
  const fleetSorted = [...fleetRows].sort(
    (a, b) =>
      (a.breaker === 'healthy' ? 1 : 0) - (b.breaker === 'healthy' ? 1 : 0) ||
      (b.inboxBacklog || 0) - (a.inboxBacklog || 0) ||
      (b.ctxPct || 0) - (a.ctxPct || 0),
  );
  const openAsks = floorState.asks || [];
  const ledger = floorState.tasks || [];
  const ledgerCounts = floorState.counts || {};
  const trippedCount = fleetRows.filter((a) => a.breaker && a.breaker !== 'healthy').length;
  const mailBacklog = fleetRows.reduce((n, a) => n + (a.inboxBacklog || 0), 0);

  const sendAnswer = (taskId) => {
    const answer = (askDraft[taskId] || '').trim();
    if (!answer) return;
    fetch('/api/floor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'answer', id: taskId, answer }),
    })
      .then(() => {
        setAskDraft((d) => ({ ...d, [taskId]: '' }));
        return fetch('/api/floor').then((r) => r.json()).then(setFloorState);
      })
      .catch(() => {});
  };

  const clearBreaker = (key) => {
    fetch(`/api/floor/reset-breaker?key=${encodeURIComponent(key)}`)
      .then(() => fetch('/api/floor').then((r) => r.json()).then(setFloorState))
      .catch(() => {});
  };
  const runningCount = liveAgents.filter((l) => l.st === 'working' || l.st === 'starting').length;

  const memEntries = memContent
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('# ') && !l.trim().startsWith('_'));
  const memTail = memEntries.slice(-7);

  const hudLabel = insideOff
    ? `inside ${insideOff.name.toLowerCase()} · ${insideOff.agents.length} agents`
    : `${offices.length} offices · ${offices.reduce((n, o) => n + o.agents.length, 0)} agents · top view`;

  const camBtn = {
    ...mono,
    fontSize: 13,
    lineHeight: 1,
    width: 34,
    padding: '8px 0',
    textAlign: 'center',
    background: '#08080Ae6',
    border: '2px solid #2A2A2E',
    borderRadius: 8,
    color: '#9A9AA3',
    cursor: 'pointer',
    userSelect: 'none',
  };

  const btnBase = {
    ...archivo,
    fontWeight: 700,
    fontSize: 10.5,
    letterSpacing: '.14em',
    textTransform: 'uppercase',
    padding: '8px 13px',
    border: '2px solid #2A2A2E',
    borderRadius: 8,
    color: '#F5F0E6',
    cursor: 'pointer',
    userSelect: 'none',
  };

  return (
    <div
      style={{
        width: '100%',
        margin: '0 auto',
        background: '#000',
        color: '#F5F0E6',
        ...archivo,
        border: '3px solid #2A2A2E',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '14px 20px',
          borderBottom: '3px solid #2A2A2E',
          background: '#0B0B0D',
        }}
      >
        <span style={{ ...bebas, fontSize: 26, letterSpacing: '.02em', lineHeight: 1, color: '#ED1B2E' }}>
          HARNESS FLOOR
        </span>
        <span style={{ ...mono, fontSize: 11, color: '#8A8A93', letterSpacing: '.04em' }}>{hudLabel}</span>
        <span style={{ flex: 1 }} />
        <span className="hf-btn" onClick={startOffice} style={btnBase}>
          + office
        </span>
        <span
          className="hf-btn"
          onClick={startAgent}
          style={{
            ...btnBase,
            opacity: insideOff ? 1 : 0.28,
            cursor: insideOff ? 'pointer' : 'not-allowed',
            pointerEvents: insideOff ? 'auto' : 'none',
          }}
        >
          + agent
        </span>
        <span
          className="hf-exit"
          onClick={exit}
          style={{
            ...mono,
            fontSize: 11,
            letterSpacing: '.12em',
            textTransform: 'uppercase',
            padding: '7px 13px',
            border: '2px solid #ED1B2E',
            borderRadius: 8,
            color: '#ED1B2E',
            cursor: 'pointer',
            userSelect: 'none',
            opacity: insideOff ? 1 : 0.25,
          }}
        >
          ← top view
        </span>
      </div>

      {/* body: offices rail · stage · terminal · task rail */}
      <div style={{ display: 'flex', height: 'calc(100dvh - 80px)', minHeight: 480 }}>
        {/* left rail — every office, then this office's skills and shared memory */}
        <aside
          style={{
            width: RAIL_W,
            flexShrink: 0,
            minWidth: 0,
            borderRight: '3px solid #2A2A2E',
            background: '#08080A',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 13px',
              borderBottom: '2px solid #1F1F23',
            }}
          >
            <span
              style={{
                ...archivo,
                fontWeight: 700,
                fontSize: 9,
                letterSpacing: '.18em',
                textTransform: 'uppercase',
                color: '#ED1B2E',
              }}
            >
              offices
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ ...mono, fontSize: 9, color: '#5A5A62' }}>{offices.length}</span>
          </div>

          <div style={{ overflowY: 'auto', flexShrink: 0, maxHeight: '42%' }}>
            {offices.map((o) => {
              const here = inside === o.id;
              const liveHere = o.agents.filter((a) => isLive(statusOf(o.id, a.id))).length;
              return (
                <div
                  key={o.id}
                  className="hf-btn"
                  onClick={() => enter(o.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '9px 13px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #131316',
                    borderLeft: `3px solid ${here ? o.accent : 'transparent'}`,
                    background: here ? '#101014' : 'transparent',
                  }}
                >
                  <span
                    style={{ width: 9, height: 9, borderRadius: 2, background: o.accent, flexShrink: 0 }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        ...bebas,
                        fontSize: 16,
                        lineHeight: 1.1,
                        letterSpacing: '.03em',
                        color: here ? '#F5F0E6' : '#C9C9D1',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {o.name}
                    </div>
                    <div
                      style={{
                        ...mono,
                        fontSize: 9,
                        color: o.cwd ? '#5A5A62' : '#7A5A2E',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {o.agents.length} agents
                      {o.cwd ? ` · ${o.cwd.split('/').pop()}` : ' · no project'}
                    </div>
                  </div>
                  {liveHere > 0 && (
                    <span style={{ ...mono, fontSize: 9, color: STATUS.done, flexShrink: 0 }}>{liveHere}●</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* the office's own cards, below the list */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: 11,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              borderTop: '2px solid #1F1F23',
            }}
          >
            {/* office skills — <project>/.claude/skills, what this office's agents know how to do */}
            {insideOff && (
              <div
                style={{
                  width: '100%',
                  padding: '11px 13px',
                  background: '#08080A',
                  border: '2px solid #2A2A2E',
                  borderRadius: 10,
                  boxSizing: 'border-box',
                  boxShadow: '0 12px 34px rgba(0,0,0,.6)',
                  zIndex: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: insideOff.accent }} />
                  <span
                    style={{
                      ...archivo,
                      fontWeight: 700,
                      fontSize: 9,
                      letterSpacing: '.18em',
                      textTransform: 'uppercase',
                      color: '#ED1B2E',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    office skills
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ ...mono, fontSize: 9, color: '#5A5A62' }}>{skills.skills.length}</span>
                  {skills.configured && (
                    <span
                      className="hf-btn"
                      onClick={startSkill}
                      style={{
                        ...mono,
                        fontSize: 10,
                        lineHeight: 1,
                        padding: '3px 7px',
                        border: '2px solid #2A2A2E',
                        borderRadius: 5,
                        color: '#8A8A93',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    >
                      +
                    </span>
                  )}
                </div>

                {!skills.configured && (
                  <>
                    <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.65, color: '#FFC83D' }}>
                      no project folder — this office has nowhere to keep skills
                    </div>
                    <span
                      className="hf-btn"
                      onClick={(e) => startEditOffice(insideOff, e)}
                      style={{
                        display: 'inline-block',
                        marginTop: 9,
                        ...archivo,
                        fontWeight: 700,
                        fontSize: 9,
                        letterSpacing: '.12em',
                        textTransform: 'uppercase',
                        padding: '7px 10px',
                        border: '2px solid #2A2A2E',
                        borderRadius: 7,
                        color: '#9A9AA3',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    >
                      set project folder
                    </span>
                  </>
                )}

                {skills.configured && skills.skills.length === 0 && (
                  <>
                    <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.65, color: '#5A5A62' }}>
                      none yet — seed the lead / worker starters, or write your own
                    </div>
                    <span
                      className="hf-btn"
                      onClick={seedSkills}
                      style={{
                        display: 'inline-block',
                        marginTop: 9,
                        ...archivo,
                        fontWeight: 700,
                        fontSize: 9,
                        letterSpacing: '.12em',
                        textTransform: 'uppercase',
                        padding: '7px 10px',
                        border: '2px solid #2A2A2E',
                        borderRadius: 7,
                        color: '#9A9AA3',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    >
                      seed starter skills
                    </span>
                  </>
                )}

                {skills.skills.slice(0, 6).map((sk) => (
                  <div
                    key={sk.id}
                    className="hf-btn"
                    onClick={() => openSkill(sk.id)}
                    style={{ cursor: 'pointer', padding: '4px 0', borderBottom: '1px solid #131316' }}
                  >
                    <div
                      style={{
                        ...mono,
                        fontSize: 10.5,
                        color: '#C9C9D1',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      /{sk.id}
                    </div>
                    <div
                      style={{
                        ...mono,
                        fontSize: 9.5,
                        lineHeight: 1.5,
                        color: '#5A5A62',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {sk.description || 'no description'}
                    </div>
                  </div>
                ))}
                {skills.skills.length > 6 && (
                  <div style={{ ...mono, fontSize: 9, color: '#5A5A62', marginTop: 5 }}>
                    +{skills.skills.length - 6} more in .claude/skills
                  </div>
                )}

                {skillErr && <div style={{ ...mono, fontSize: 10, color: '#ED1B2E', marginTop: 7 }}>{skillErr}</div>}

                <div
                  style={{
                    ...mono,
                    fontSize: 9,
                    letterSpacing: '.05em',
                    color: '#5A5A62',
                    marginTop: 8,
                    borderTop: '2px solid #1F1F23',
                    paddingTop: 7,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {skills.configured ? `${skills.folder}/.claude/skills` : 'one office = one project'}
                </div>
              </div>
            )}

            {/* shared memory card — office memory when inside, floor memory in top view */}
            <div
              style={{
                width: '100%',
                padding: '11px 13px',
                background: '#08080A',
                border: '2px solid #2A2A2E',
                borderRadius: 10,
                boxSizing: 'border-box',
                boxShadow: '0 12px 34px rgba(0,0,0,.6)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span
                  style={{ width: 9, height: 9, borderRadius: 2, background: insideOff ? insideOff.accent : '#F5F0E6' }}
                />
                <span
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 9,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#ED1B2E',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {insideOff ? 'shared memory' : 'floor memory'}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ ...mono, fontSize: 9, color: '#5A5A62' }}>{memEntries.length}</span>
                <span
                  className="hf-btn"
                  onClick={openMemEditor}
                  style={{
                    ...mono,
                    fontSize: 10,
                    lineHeight: 1,
                    padding: '3px 7px',
                    border: '2px solid #2A2A2E',
                    borderRadius: 5,
                    color: '#8A8A93',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  ✎
                </span>
              </div>
              {memTail.length === 0 && (
                <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.65, color: '#5A5A62' }}>
                  empty — agents append here as they work
                </div>
              )}
              {memTail.map((m, i) => (
                <div
                  key={i}
                  style={{
                    ...mono,
                    fontSize: 10.5,
                    lineHeight: 1.65,
                    color: '#9A9AA3',
                    overflowWrap: 'anywhere',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {m}
                </div>
              ))}
              <div
                style={{
                  ...mono,
                  fontSize: 9,
                  letterSpacing: '.05em',
                  color: '#5A5A62',
                  marginTop: 8,
                  borderTop: '2px solid #1F1F23',
                  paddingTop: 7,
                }}
              >
                {insideOff
                  ? `readable by all ${insideOff.agents.length} agents in ${insideOff.name.toLowerCase()}`
                  : 'readable by every agent in every office'}
              </div>
            </div>

          </div>
        </aside>

        {/* stage */}
        <div
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            height: '100%',
            background: 'radial-gradient(120% 90% at 50% 30%,#131316 0%,#000 70%)',
            overflow: 'hidden',
          }}
        >
        <div
          ref={setStageEl}
          onPointerDown={onPointerDown}
          style={{
            position: 'absolute',
            inset: 0,
            perspective: 1500,
            perspectiveOrigin: '50% 42%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: interacting ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              marginLeft: -PLANE_W / 2,
              marginTop: -PLANE_H / 2,
              width: PLANE_W,
              height: PLANE_H,
              transformStyle: 'preserve-3d',
              transition: interacting ? 'none' : 'transform 900ms cubic-bezier(.22,1,.28,1)',
              transform: camera,
              willChange: 'transform',
            }}
          >
            {offices.map((o, oi) => (
              <div
                key={o.id}
                onClick={() => enter(o.id)}
                style={{
                  position: 'absolute',
                  width: ROOM_W,
                  height: officePos[oi].h,
                  marginLeft: -ROOM_W / 2,
                  marginTop: -officePos[oi].h / 2,
                  transformStyle: 'preserve-3d',
                  cursor: 'pointer',
                  transition: 'opacity 600ms ease',
                  left: officePos[oi].x,
                  top: officePos[oi].y,
                  opacity: !insideOff || insideOff.id === o.id ? 1 : 0.18,
                }}
              >
                {/* floor */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: '#0E0E11',
                    border: '3px solid #2A2A2E',
                    borderRadius: 10,
                    boxShadow: '0 24px 60px rgba(0,0,0,.65)',
                    backgroundImage:
                      'linear-gradient(#17171b 1px,transparent 1px),linear-gradient(90deg,#17171b 1px,transparent 1px)',
                    backgroundSize: '38px 38px',
                  }}
                />
                {/* agent mesh — dotted beams arcing through the air from the office
                    lead's desk to every worker. Each takes the colour of that
                    worker's live status, and a pulse chases along it, so you can
                    see which way the office is working from across the floor. */}
                {o.agents.length > 1 &&
                  (() => {
                    const hubIdx = Math.max(0, o.agents.findIndex(isLeadAgent));
                    const hub = deskSlot(hubIdx);
                    const hubSt = statusOf(o.id, o.agents[hubIdx].id);
                    return (
                      <div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d', pointerEvents: 'none' }}>
                        {o.agents.map((ag, i) => {
                          if (i === hubIdx) return null;
                          const st = statusOf(o.id, ag.id);
                          const alive = isLive(st);
                          const col = alive ? statusColor(st) : '#3A3A42';
                          return (
                            <div
                              key={ag.id}
                              style={{
                                position: 'absolute',
                                inset: 0,
                                transformStyle: 'preserve-3d',
                                opacity: alive ? (st === 'working' ? 1 : 0.7) : 0.3,
                              }}
                            >
                              {linkSegments(hub, deskSlot(i)).map((sg, k) => (
                                <div
                                  key={k}
                                  className="hf-link"
                                  style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 0,
                                    width: sg.len,
                                    height: st === 'working' ? 3 : 2.4,
                                    marginTop: -1,
                                    transformOrigin: '0 50%',
                                    transformStyle: 'preserve-3d',
                                    transform: sg.transform,
                                    background: `repeating-linear-gradient(90deg, ${col} 0 4px, transparent 4px 10px)`,
                                    borderRadius: 2,
                                  }}
                                />
                              ))}
                            </div>
                          );
                        })}
                        {/* the hub itself, hovering over the lead's desk */}
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            transformStyle: 'preserve-3d',
                            transform: `translate3d(${hub.x}px,${hub.y}px,${LINK_BASE_Z + 6}px)`,
                          }}
                        >
                          <div
                            className="hf-hub"
                            style={{
                              width: 10,
                              height: 10,
                              margin: '-5px 0 0 -5px',
                              borderRadius: '50%',
                              background: isLive(hubSt) ? statusColor(hubSt) : '#3A3A42',
                            }}
                          />
                        </div>
                      </div>
                    );
                  })()}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    height: 6,
                    background: o.accent,
                    borderRadius: '6px 6px 0 0',
                  }}
                />

                {/* name plate — standing sign hung on the left edge of the room */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: officePos[oi].h / 2,
                    width: 210,
                    marginLeft: -196,
                    marginTop: -44,
                    transform: wallT,
                    background: 'linear-gradient(#1A1A1F,#0B0B0D)',
                    border: '3px solid #2A2A2E',
                    borderRadius: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    padding: '10px 14px',
                    boxSizing: 'border-box',
                    boxShadow: '0 14px 30px rgba(0,0,0,.6)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, maxWidth: '100%' }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: o.accent, flexShrink: 0 }} />
                    <span
                      style={{
                        ...bebas,
                        fontSize: 26,
                        lineHeight: 1,
                        letterSpacing: '.02em',
                        color: '#F5F0E6',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {o.name}
                    </span>
                    {insideOff?.id === o.id && (
                      <span
                        className="hf-btn"
                        onClick={(e) => startEditOffice(o, e)}
                        style={{
                          ...mono,
                          fontSize: 12,
                          padding: '2px 7px',
                          border: '2px solid #2A2A2E',
                          borderRadius: 6,
                          color: '#8A8A93',
                          cursor: 'pointer',
                          userSelect: 'none',
                          flexShrink: 0,
                        }}
                      >
                        ✎
                      </span>
                    )}
                  </div>
                  <span style={{ ...mono, fontSize: 10, color: '#8A8A93', whiteSpace: 'nowrap' }}>
                    {o.agents.length} agents{o.cwd ? ` · ${o.cwd.split('/').pop()}` : ''}
                  </span>
                </div>

                {/* + agent slot — always available; rooms grow to fit */}
                {insideOff?.id === o.id && (
                  <div
                    onClick={startAgent}
                    style={{
                      position: 'absolute',
                      width: 126,
                      marginLeft: -63,
                      cursor: 'pointer',
                      left: deskSlot(o.agents.length).x,
                      top: deskSlot(o.agents.length).y,
                    }}
                  >
                    <div
                      className="hf-add"
                      style={{
                        width: 126,
                        height: 52,
                        marginTop: -26,
                        border: '2px dashed #3A3A42',
                        borderRadius: 7,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        ...archivo,
                        fontWeight: 700,
                        fontSize: 9,
                        letterSpacing: '.16em',
                        color: '#5A5A62',
                      }}
                    >
                      + AGENT
                    </div>
                  </div>
                )}

                {/* desks */}
                {o.agents.map((ag, i) => {
                  const st = statusOf(o.id, ag.id);
                  return (
                    <div
                      key={ag.id}
                      style={{
                        position: 'absolute',
                        width: 126,
                        marginLeft: -63,
                        transformStyle: 'preserve-3d',
                        left: deskSlot(i).x,
                        top: deskSlot(i).y,
                      }}
                    >
                      <div style={{ width: 126, height: 52, marginTop: -26, background: '#0A0A0C', borderRadius: 7 }} />
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: -26,
                          width: 126,
                          height: 52,
                          transform: 'translateZ(16px)',
                          background: 'linear-gradient(160deg,#23232A,#15151A)',
                          border: '2px solid #34343C',
                          borderRadius: 7,
                          boxShadow: '0 10px 22px rgba(0,0,0,.7)',
                        }}
                      />
                      <div
                        style={{
                          position: 'absolute',
                          left: 26,
                          top: -8,
                          width: 74,
                          height: 22,
                          transform: screenT,
                          background: isLive(st) ? 'linear-gradient(#141419,#0C0C0F)' : '#0C0C0F',
                          border: `2px solid ${isLive(st) ? `${statusColor(st)}55` : '#3A3A42'}`,
                          borderRadius: 4,
                          boxSizing: 'border-box',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                          gap: 2.5,
                          padding: '0 7px',
                          boxShadow:
                            isLive(st) ? `0 0 14px ${statusColor(st)}44` : '0 0 10px rgba(237,27,46,.1)',
                        }}
                      >
                        <span
                          style={{
                            height: 2,
                            borderRadius: 2,
                            width: '72%',
                            background: isLive(st) ? `${statusColor(st)}99` : 'rgba(154,154,163,.22)',
                          }}
                        />
                        <span style={{ height: 2, borderRadius: 2, width: '46%', background: 'rgba(154,154,163,.16)' }} />
                        <span style={{ height: 2, borderRadius: 2, width: '60%', background: 'rgba(154,154,163,.16)' }} />
                      </div>
                      <div
                        style={{
                          position: 'absolute',
                          left: 44,
                          top: 14,
                          width: 38,
                          height: 26,
                          transform: 'translateZ(6px)',
                          background: '#1A1A20',
                          border: '2px solid #2E2E36',
                          borderRadius: 6,
                        }}
                      />
                      {/* the agent sitting at the desk, name bar over their head */}
                      <div
                        className="hf-sign"
                        onClick={(e) => openAgent(o.id, ag.id, e)}
                        style={{
                          position: 'absolute',
                          left: 28,
                          top: -118,
                          width: 130,
                          height: 100,
                          transform: signT,
                          display: 'flex',
                          flexDirection: 'column-reverse',
                          alignItems: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <Person tone={shirtOf(`${o.id}/${ag.id}`)} status={st} />
                        <span style={{ width: 2, height: 10, borderRadius: 1, background: '#31313A' }} />
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 7,
                              padding: '5px 11px',
                              background: 'linear-gradient(#17171D,#0A0A0E)',
                              border: `1px solid ${isLive(st) ? `${statusColor(st)}55` : '#2C2C35'}`,
                              borderRadius: 999,
                              whiteSpace: 'nowrap',
                              boxShadow:
                                isLive(st)
                                  ? `0 5px 16px rgba(0,0,0,.75), 0 0 16px ${statusColor(st)}2E`
                                  : '0 5px 16px rgba(0,0,0,.75)',
                            }}
                          >
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                flexShrink: 0,
                                background: statusColor(st),
                                boxShadow: isLive(st) ? `0 0 8px ${statusColor(st)}` : 'none',
                                animation:
                                  st === 'working' || st === 'starting'
                                    ? 'hf-pulse 1.1s ease-in-out infinite'
                                    : st === 'waiting'
                                      ? 'hf-blink 1s step-start infinite'
                                      : 'none',
                              }}
                            />
                            <span style={{ ...bebas, fontSize: 15, lineHeight: 1, letterSpacing: '.05em', color: '#F5F0E6' }}>
                              {ag.name}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span
                              style={{
                                ...mono,
                                fontSize: 7,
                                letterSpacing: '.15em',
                                textTransform: 'uppercase',
                                color: '#63636D',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {ag.role} · {STATUS_LABEL[st] || st}
                            </span>
                            {insideOff?.id === o.id && (
                              <>
                                <span
                                  className="hf-btn"
                                  onClick={(e) => startEditAgent(o, ag, e)}
                                  style={signBtn}
                                >
                                  ✎
                                </span>
                                <span
                                  className="hf-btn"
                                  onClick={(e) => removeAgent(o.id, ag.id, e)}
                                  style={signBtn}
                                >
                                  ×
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* create form */}
        {form && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 330,
              marginLeft: -165,
              marginTop: -140,
              padding: 18,
              background: '#000',
              border: '3px solid #ED1B2E',
              borderRadius: 12,
              boxSizing: 'border-box',
              boxShadow: '0 18px 50px rgba(0,0,0,.8),0 8px 32px rgba(237,27,46,.35)',
              zIndex: 5,
            }}
          >
            <div style={{ ...bebas, fontSize: 30, lineHeight: 1, letterSpacing: '.02em', color: '#F5F0E6' }}>
              {
                { office: 'NEW OFFICE', agent: 'SPAWN AGENT', 'edit-office': 'EDIT OFFICE', 'edit-agent': 'EDIT AGENT' }[
                  form
                ]
              }
            </div>
            <div style={{ ...mono, fontSize: 10, color: '#5A5A62', margin: '5px 0 14px' }}>
              {form === 'office' && 'one office = one project folder'}
              {form === 'agent' && `runs claude code in ${insideOff?.name || ''}'s project folder`}
              {form === 'edit-office' && 'rename · repoint the project · recolor'}
              {form === 'edit-agent' && 'rename keeps the live session attached'}
            </div>
            <input
              className="hf-input"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit()}
              placeholder="NAME"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: '#0B0B0D',
                border: '2px solid #2A2A2E',
                borderRadius: 8,
                padding: '10px 11px',
                ...bebas,
                fontSize: 20,
                letterSpacing: '.04em',
                color: '#F5F0E6',
                outline: 'none',
              }}
            />
            {(form === 'office' || form === 'edit-office') && (
              <>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 9,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#8A8A93',
                    margin: '14px 0 6px',
                  }}
                >
                  project folder
                </div>
                <div style={{ display: 'flex', gap: 7 }}>
                  <input
                    className="hf-input"
                    value={cwdDraft}
                    onChange={(e) => setCwdDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && commit()}
                    placeholder="~/code/my-project"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      boxSizing: 'border-box',
                      background: '#0B0B0D',
                      border: '2px solid #2A2A2E',
                      borderRadius: 8,
                      padding: '9px 11px',
                      ...mono,
                      fontSize: 11,
                      color: '#F5F0E6',
                      outline: 'none',
                    }}
                  />
                  <span
                    className="hf-btn"
                    onClick={pickerBusy ? undefined : openPicker}
                    style={{
                      ...archivo,
                      fontWeight: 700,
                      fontSize: 9,
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                      padding: '9px 11px',
                      border: '2px solid #2A2A2E',
                      borderRadius: 8,
                      color: pickerBusy ? '#5A5A62' : '#9A9AA3',
                      cursor: pickerBusy ? 'default' : 'pointer',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {pickerBusy ? 'in finder…' : 'browse'}
                  </span>
                </div>
                <div style={{ ...mono, fontSize: 9.5, color: '#5A5A62', marginTop: 6, lineHeight: 1.5 }}>
                  {cwdDraft.trim()
                    ? 'every agent here runs in this folder · skills land in its .claude/skills'
                    : 'no folder yet — agents fall back to the app dir and get no office skills'}
                  {form === 'edit-office' && cwdDraft.trim() !== (editOfficeCwd || '') && (
                    <>
                      <br />
                      <span style={{ color: '#FFC83D' }}>
                        live sessions keep their old folder until you kill them
                      </span>
                    </>
                  )}
                </div>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 9,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#8A8A93',
                    margin: '14px 0 6px',
                  }}
                >
                  issue tracker
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[
                    ['', 'none'],
                    ['plane', 'plane'],
                    ['jira', 'jira'],
                    ['linear', 'linear'],
                  ].map(([id, label]) => (
                    <span
                      key={label}
                      className="hf-btn"
                      onClick={() => setTrkProvider(id)}
                      style={{
                        flex: 1,
                        textAlign: 'center',
                        ...mono,
                        fontSize: 10,
                        padding: '7px 0',
                        border: `2px solid ${trkProvider === id ? '#ED1B2E' : '#2A2A2E'}`,
                        borderRadius: 7,
                        color: trkProvider === id ? '#F5F0E6' : '#7A7A83',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    >
                      {label}
                    </span>
                  ))}
                </div>
                {trkProvider && (
                  <>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <input
                        className="hf-input"
                        value={trkWorkspace}
                        onChange={(e) => setTrkWorkspace(e.target.value)}
                        placeholder="workspace slug"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          boxSizing: 'border-box',
                          background: '#0B0B0D',
                          border: '2px solid #2A2A2E',
                          borderRadius: 7,
                          padding: '8px 10px',
                          ...mono,
                          fontSize: 10.5,
                          color: '#F5F0E6',
                          outline: 'none',
                        }}
                      />
                      <input
                        className="hf-input"
                        value={trkProject}
                        onChange={(e) => setTrkProject(e.target.value)}
                        placeholder="project id"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          boxSizing: 'border-box',
                          background: '#0B0B0D',
                          border: '2px solid #2A2A2E',
                          borderRadius: 7,
                          padding: '8px 10px',
                          ...mono,
                          fontSize: 10.5,
                          color: '#F5F0E6',
                          outline: 'none',
                        }}
                      />
                    </div>
                    <div style={{ ...mono, fontSize: 9.5, color: '#5A5A62', marginTop: 6, lineHeight: 1.5 }}>
                      {trkProvider === 'plane'
                        ? 'polled every ~3.5 min · needs PLANE_API_KEY in .env.local'
                        : `${trkProvider} is not implemented yet — plane is`}
                    </div>
                  </>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                  <span
                    style={{
                      ...archivo,
                      fontWeight: 700,
                      fontSize: 9,
                      letterSpacing: '.18em',
                      textTransform: 'uppercase',
                      color: '#8A8A93',
                    }}
                  >
                    accent
                  </span>
                  {PALETTE.map((c) => (
                    <span
                      key={c}
                      onClick={() => setAccent(c)}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: c,
                        border: `2px solid ${accent === c ? '#F5F0E6' : '#2A2A2E'}`,
                      }}
                    />
                  ))}
                </div>
              </>
            )}
            {(form === 'agent' || form === 'edit-agent') && (
              <input
                className="hf-input"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
                placeholder="role — e.g. reviewer"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  marginTop: 10,
                  background: '#0B0B0D',
                  border: '2px solid #2A2A2E',
                  borderRadius: 8,
                  padding: '9px 11px',
                  ...mono,
                  fontSize: 11,
                  color: '#F5F0E6',
                  outline: 'none',
                }}
              />
            )}
            <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
              <span
                className="hf-primary"
                onClick={commit}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: 11,
                  background: '#ED1B2E',
                  border: '3px solid #ED1B2E',
                  borderRadius: 8,
                  color: '#000',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                {form?.startsWith('edit') ? 'save' : 'create'}
              </span>
              {form?.startsWith('edit') && (
                <span
                  className="hf-exit"
                  onClick={deleteFromForm}
                  style={{
                    textAlign: 'center',
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 11,
                    letterSpacing: '.14em',
                    textTransform: 'uppercase',
                    padding: '11px 16px',
                    border: '3px solid #ED1B2E',
                    borderRadius: 8,
                    color: '#ED1B2E',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  delete
                </span>
              )}
              <span
                className="hf-ghost"
                onClick={cancelForm}
                style={{
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: '11px 16px',
                  border: '3px solid #2A2A2E',
                  borderRadius: 8,
                  color: '#8A8A93',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                cancel
              </span>
            </div>
          </div>
        )}

        {/* project folder picker — browse, or make a fresh folder for this office */}
        {picker && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 480,
              maxWidth: 'calc(100% - 40px)',
              transform: 'translate(-50%,-50%)',
              padding: 18,
              background: '#000',
              border: '3px solid #ED1B2E',
              borderRadius: 12,
              boxSizing: 'border-box',
              boxShadow: '0 18px 50px rgba(0,0,0,.8),0 8px 32px rgba(237,27,46,.35)',
              zIndex: 9,
            }}
          >
            <div style={{ ...bebas, fontSize: 30, lineHeight: 1, letterSpacing: '.02em', color: '#F5F0E6' }}>
              PROJECT FOLDER
            </div>
            <div style={{ ...mono, fontSize: 10, color: '#5A5A62', margin: '5px 0 12px' }}>
              finder is unavailable — browsing in-page · pick the one project this office owns
            </div>

            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <span
                className="hf-btn"
                onClick={() => pickerData?.parent && loadPicker(pickerData.parent)}
                style={{
                  ...mono,
                  fontSize: 12,
                  lineHeight: 1,
                  padding: '8px 10px',
                  border: '2px solid #2A2A2E',
                  borderRadius: 7,
                  color: pickerData?.parent ? '#9A9AA3' : '#3A3A42',
                  cursor: pickerData?.parent ? 'pointer' : 'default',
                  userSelect: 'none',
                  flexShrink: 0,
                }}
              >
                ↑
              </span>
              <input
                className="hf-input"
                value={picker.path}
                onChange={(e) => setPicker({ path: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && loadPicker(picker.path)}
                spellCheck={false}
                style={{
                  flex: 1,
                  minWidth: 0,
                  boxSizing: 'border-box',
                  background: '#0B0B0D',
                  border: '2px solid #2A2A2E',
                  borderRadius: 7,
                  padding: '8px 10px',
                  ...mono,
                  fontSize: 11,
                  color: '#F5F0E6',
                  outline: 'none',
                }}
              />
              <span
                className="hf-btn"
                onClick={() => loadPicker(picker.path)}
                style={{
                  ...mono,
                  fontSize: 10,
                  padding: '8px 10px',
                  border: '2px solid #2A2A2E',
                  borderRadius: 7,
                  color: '#9A9AA3',
                  cursor: 'pointer',
                  userSelect: 'none',
                  flexShrink: 0,
                }}
              >
                go
              </span>
            </div>

            <div
              style={{
                marginTop: 10,
                height: 230,
                overflowY: 'auto',
                border: '2px solid #1F1F23',
                borderRadius: 8,
                background: '#08080A',
              }}
            >
              {pickerData && !pickerData.exists && (
                <div style={{ ...mono, fontSize: 11, color: '#FFC83D', padding: '12px 13px', lineHeight: 1.6 }}>
                  this folder does not exist yet — “create here” will make it
                </div>
              )}
              {pickerData?.exists && !pickerData.entries.length && (
                <div style={{ ...mono, fontSize: 11, color: '#5A5A62', padding: '12px 13px' }}>
                  no sub-folders here — use this one, or make a new folder below
                </div>
              )}
              {pickerData?.entries.map((d) => (
                <div
                  key={d.path}
                  className="hf-btn"
                  onClick={() => loadPicker(d.pretty)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '8px 13px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #131316',
                  }}
                >
                  <span style={{ ...mono, fontSize: 11, color: d.project ? '#ED1B2E' : '#3A3A42' }}>
                    {d.project ? '◆' : '▸'}
                  </span>
                  <span
                    style={{
                      ...mono,
                      fontSize: 11.5,
                      color: '#C9C9D1',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.name}
                  </span>
                  {d.project && (
                    <span style={{ ...mono, fontSize: 8.5, letterSpacing: '.1em', color: '#5A5A62' }}>PROJECT</span>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
              <input
                className="hf-input"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createFolder()}
                placeholder="new folder name — e.g. my-project"
                style={{
                  flex: 1,
                  minWidth: 0,
                  boxSizing: 'border-box',
                  background: '#0B0B0D',
                  border: '2px solid #2A2A2E',
                  borderRadius: 7,
                  padding: '8px 10px',
                  ...mono,
                  fontSize: 11,
                  color: '#F5F0E6',
                  outline: 'none',
                }}
              />
              <span
                className="hf-btn"
                onClick={createFolder}
                style={{
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 9,
                  letterSpacing: '.12em',
                  textTransform: 'uppercase',
                  padding: '9px 11px',
                  border: '2px solid #2A2A2E',
                  borderRadius: 7,
                  color: newFolder.trim() ? '#9A9AA3' : '#3A3A42',
                  cursor: newFolder.trim() ? 'pointer' : 'default',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                create here
              </span>
            </div>

            {pickerErr && (
              <div style={{ ...mono, fontSize: 10.5, color: '#ED1B2E', marginTop: 8 }}>{pickerErr}</div>
            )}

            <div style={{ display: 'flex', gap: 9, marginTop: 14, alignItems: 'center' }}>
              <span
                className="hf-primary"
                onClick={usePickerPath}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: 11,
                  background: '#ED1B2E',
                  border: '3px solid #ED1B2E',
                  borderRadius: 8,
                  color: '#000',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                use this folder
              </span>
              <span
                className="hf-ghost"
                onClick={() => setPicker(null)}
                style={{
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: '11px 16px',
                  border: '3px solid #2A2A2E',
                  borderRadius: 8,
                  color: '#8A8A93',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                cancel
              </span>
            </div>
          </div>
        )}

        {/* shared memory editor */}
        {memEditor && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 560,
              maxWidth: 'calc(100% - 40px)',
              transform: 'translate(-50%,-50%)',
              padding: 18,
              background: '#000',
              border: '3px solid #ED1B2E',
              borderRadius: 12,
              boxSizing: 'border-box',
              boxShadow: '0 18px 50px rgba(0,0,0,.8),0 8px 32px rgba(237,27,46,.35)',
              zIndex: 7,
            }}
          >
            <div style={{ ...bebas, fontSize: 30, lineHeight: 1, letterSpacing: '.02em', color: '#F5F0E6' }}>
              {insideOff ? `${insideOff.name} MEMORY` : 'FLOOR MEMORY'}
            </div>
            <div style={{ ...mono, fontSize: 10, color: '#5A5A62', margin: '5px 0 12px' }}>
              data/memory/{memScope}.md — agents read this at task start and append as they work
            </div>
            <textarea
              className="hf-input"
              value={memDraft}
              onChange={(e) => setMemDraft(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%',
                height: 300,
                boxSizing: 'border-box',
                resize: 'vertical',
                background: '#0B0B0D',
                border: '2px solid #2A2A2E',
                borderRadius: 8,
                padding: '10px 11px',
                ...mono,
                fontSize: 11.5,
                lineHeight: 1.6,
                color: '#F5F0E6',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
              <span
                className="hf-primary"
                onClick={saveMemory}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: 11,
                  background: '#ED1B2E',
                  border: '3px solid #ED1B2E',
                  borderRadius: 8,
                  color: '#000',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                save
              </span>
              <span
                className="hf-ghost"
                onClick={() => setMemEditor(false)}
                style={{
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: '11px 16px',
                  border: '3px solid #2A2A2E',
                  borderRadius: 8,
                  color: '#8A8A93',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                cancel
              </span>
            </div>
          </div>
        )}

        {/* skill editor */}
        {skillEditor && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 620,
              maxWidth: 'calc(100% - 40px)',
              transform: 'translate(-50%,-50%)',
              padding: 18,
              background: '#000',
              border: '3px solid #ED1B2E',
              borderRadius: 12,
              boxSizing: 'border-box',
              boxShadow: '0 18px 50px rgba(0,0,0,.8),0 8px 32px rgba(237,27,46,.35)',
              zIndex: 8,
            }}
          >
            <div style={{ ...bebas, fontSize: 30, lineHeight: 1, letterSpacing: '.02em', color: '#F5F0E6' }}>
              {skillEditor.isNew ? 'NEW SKILL' : `SKILL · ${skillEditor.id.toUpperCase()}`}
            </div>
            <div style={{ ...mono, fontSize: 10, color: '#5A5A62', margin: '5px 0 12px' }}>
              {skills.folder}/.claude/skills/{skillEditor.isNew ? slug(skillName || 'new-skill') : skillEditor.id}
              /SKILL.md — every agent in {insideOff?.name.toLowerCase()} discovers it
            </div>
            {skillEditor.isNew && (
              <input
                className="hf-input"
                value={skillName}
                autoFocus
                onChange={(e) => setSkillName(e.target.value)}
                placeholder="skill name — e.g. release-checklist"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  marginBottom: 10,
                  background: '#0B0B0D',
                  border: '2px solid #2A2A2E',
                  borderRadius: 8,
                  padding: '9px 11px',
                  ...mono,
                  fontSize: 11,
                  color: '#F5F0E6',
                  outline: 'none',
                }}
              />
            )}
            <textarea
              className="hf-input"
              value={skillDraft}
              onChange={(e) => setSkillDraft(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%',
                height: 320,
                boxSizing: 'border-box',
                resize: 'vertical',
                background: '#0B0B0D',
                border: '2px solid #2A2A2E',
                borderRadius: 8,
                padding: '10px 11px',
                ...mono,
                fontSize: 11.5,
                lineHeight: 1.6,
                color: '#F5F0E6',
                outline: 'none',
              }}
            />
            {skillErr && <div style={{ ...mono, fontSize: 10.5, color: '#ED1B2E', marginTop: 8 }}>{skillErr}</div>}
            <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
              <span
                className="hf-primary"
                onClick={saveSkill}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: 11,
                  background: '#ED1B2E',
                  border: '3px solid #ED1B2E',
                  borderRadius: 8,
                  color: '#000',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                save
              </span>
              {!skillEditor.isNew && (
                <span
                  className="hf-exit"
                  onClick={deleteSkillNow}
                  style={{
                    textAlign: 'center',
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 11,
                    letterSpacing: '.14em',
                    textTransform: 'uppercase',
                    padding: '11px 16px',
                    border: '3px solid #ED1B2E',
                    borderRadius: 8,
                    color: '#ED1B2E',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  delete
                </span>
              )}
              <span
                className="hf-ghost"
                onClick={() => setSkillEditor(null)}
                style={{
                  textAlign: 'center',
                  ...archivo,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: '.14em',
                  textTransform: 'uppercase',
                  padding: '11px 16px',
                  border: '3px solid #2A2A2E',
                  borderRadius: 8,
                  color: '#8A8A93',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                cancel
              </span>
            </div>
          </div>
        )}

        {/* camera controls */}
        <div
          style={{
            position: 'absolute',
            right: term ? TERM_W + 20 : 20,
            top: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            alignItems: 'stretch',
            zIndex: 4,
          }}
        >
          <span className="hf-btn" onClick={() => zoomBy(1.2)} style={camBtn}>
            +
          </span>
          <span className="hf-btn" onClick={() => zoomBy(1 / 1.2)} style={camBtn}>
            −
          </span>
          <span
            className="hf-btn"
            onClick={resetView}
            style={{ ...camBtn, fontSize: 8.5, letterSpacing: '.1em', padding: '7px 0' }}
          >
            FIT
          </span>
          <span
            style={{
              ...mono,
              fontSize: 9,
              textAlign: 'center',
              color: '#5A5A62',
              marginTop: 2,
            }}
          >
            {Math.round(view.z * 100)}%
          </span>
        </div>

        <div
          style={{
            position: 'absolute',
            right: term ? TERM_W + 20 : 20,
            bottom: 18,
            ...mono,
            fontSize: 10,
            letterSpacing: '.06em',
            color: '#5A5A62',
            textAlign: 'right',
            pointerEvents: 'none',
          }}
        >
          drag to pan · scroll to zoom · arrows to nudge · 0 to fit
          <br />
          click an office to fly in · click an agent to attach
        </div>

        {/* live claude code terminal */}
        {term && (
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: TERM_W, display: 'flex', zIndex: 6 }}>
            <div
              style={{
                flex: 1,
                background: '#08080A',
                borderLeft: '3px solid #2A2A2E',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '-18px 0 50px rgba(0,0,0,.7)',
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '13px 16px',
                  borderBottom: '2px solid #1F1F23',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: term.color }} />
                <span style={{ ...bebas, fontSize: 24, lineHeight: 1, letterSpacing: '.03em', color: '#F5F0E6' }}>
                  {term.ag.name}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  className="hf-btn"
                  onClick={killSession}
                  style={{
                    ...mono,
                    fontSize: 9,
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    padding: '4px 8px',
                    border: '2px solid #2A2A2E',
                    borderRadius: 6,
                    color: '#8A8A93',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  kill
                </span>
                <span
                  className="hf-close"
                  onClick={() => setOpen(null)}
                  style={{ ...mono, fontSize: 14, color: '#8A8A93', cursor: 'pointer', padding: '2px 6px' }}
                >
                  ×
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: '10px 16px',
                  borderBottom: '2px solid #1F1F23',
                  ...mono,
                  fontSize: 10,
                  color: '#8A8A93',
                }}
              >
                <span style={{ color: term.color }}>● {STATUS_LABEL[term.status] || term.status}</span>
                <span>office: {term.off.id}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  project: {term.off.cwd || 'none — app dir'}
                </span>
              </div>
              <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                <TerminalPane
                  sessionKey={open}
                  cwd={term.off.cwd}
                  role={term.ag.role}
                  controls={termControls}
                  onExit={() =>
                    fetch('/api/sessions').then((r) => r.json()).then(setLive).catch(() => {})
                  }
                />
              </div>
            </div>
          </div>
        )}
        </div>

        {/* right rail — the live task board: who is running, on what, and what landed */}
        <aside
          style={{
            width: TASK_W,
            flexShrink: 0,
            minWidth: 0,
            borderLeft: '3px solid #2A2A2E',
            background: '#08080A',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 13px',
              borderBottom: '2px solid #1F1F23',
            }}
          >
            <span
              style={{
                ...archivo,
                fontWeight: 700,
                fontSize: 9,
                letterSpacing: '.18em',
                textTransform: 'uppercase',
                color: '#ED1B2E',
              }}
            >
              task board
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ ...mono, fontSize: 9, color: runningCount ? STATUS.working : '#5A5A62' }}>
              {runningCount} running{tickets.todo ? ` · ${tickets.todo} todo` : ''}
            </span>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {/* ASK ME — cards blocked on the human. Always the top of the rail:
                nothing else here can move until one of these is answered. */}
            {openAsks.length > 0 && (
              <div style={{ borderBottom: '2px solid #1F1F23', background: '#12060A' }}>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 8.5,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#ED1B2E',
                    padding: '10px 13px 6px',
                  }}
                >
                  ask me · {openAsks.length}
                </div>
                {openAsks.map((a) => (
                  <div key={`${a.taskId}-${a.askedAt}`} style={{ padding: '0 13px 11px' }}>
                    <div style={{ ...mono, fontSize: 9, color: '#5A5A62', marginBottom: 3 }}>
                      {a.askedBy || a.assignee || a.office} · {a.title}
                    </div>
                    {/* The ask is markdown by contract, but a rail is not a
                        renderer — show it as written, wrapped, and keep it short
                        by asking the agents to write it short. */}
                    <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.6, color: '#F5F0E6', whiteSpace: 'pre-wrap' }}>
                      {a.q}
                    </div>
                    <textarea
                      value={askDraft[a.taskId] || ''}
                      onChange={(e) => setAskDraft((d) => ({ ...d, [a.taskId]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendAnswer(a.taskId);
                      }}
                      placeholder="your answer — ⌘⏎ to send"
                      rows={2}
                      style={{
                        ...mono,
                        fontSize: 10.5,
                        width: '100%',
                        marginTop: 6,
                        padding: '6px 8px',
                        background: '#08080A',
                        color: '#F5F0E6',
                        border: '2px solid #2A2A2E',
                        borderRadius: 6,
                        resize: 'vertical',
                      }}
                    />
                    <div
                      className="hf-btn"
                      onClick={() => sendAnswer(a.taskId)}
                      style={{
                        ...archivo,
                        fontWeight: 700,
                        fontSize: 9,
                        letterSpacing: '.14em',
                        textTransform: 'uppercase',
                        marginTop: 5,
                        padding: '5px 10px',
                        display: 'inline-block',
                        border: '2px solid #ED1B2E',
                        borderRadius: 6,
                        color: '#ED1B2E',
                        cursor: 'pointer',
                        opacity: (askDraft[a.taskId] || '').trim() ? 1 : 0.4,
                      }}
                    >
                      answer
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* FLEET — what the agents' own lifecycle hooks reported. Context and
                cost come from the session's real numbers, not from scraping the
                terminal, so they are exact. */}
            {fleetSorted.length > 0 && (
              <>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 8.5,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#5A5A62',
                    padding: '10px 13px 6px',
                  }}
                >
                  fleet
                  {mailBacklog > 0 && <span style={{ color: '#FFC83D' }}> · {mailBacklog} unread</span>}
                  {trippedCount > 0 && <span style={{ color: '#ED1B2E' }}> · {trippedCount} tripped</span>}
                </div>
                {fleetSorted.map((a) => (
                  <div
                    key={a.key}
                    className="hf-btn"
                    onClick={(e) => openAgent(a.office, a.agent, e)}
                    style={{ padding: '7px 13px', cursor: 'pointer', borderBottom: '1px solid #131317' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: statusColor(a.status),
                        }}
                      />
                      <span style={{ ...archivo, fontWeight: 700, fontSize: 10, letterSpacing: '.06em' }}>
                        {a.name}
                        {a.lead && <span style={{ color: '#FFC83D' }}> ·lead</span>}
                      </span>
                      <span style={{ flex: 1 }} />
                      {a.inboxBacklog > 0 && (
                        <span style={{ ...mono, fontSize: 9, color: '#FFC83D' }}>✉ {a.inboxBacklog}</span>
                      )}
                      {a.usd > 0 && <span style={{ ...mono, fontSize: 9, color: '#5A5A62' }}>${a.usd.toFixed(2)}</span>}
                    </div>
                    {/* Context gauge: the exact window size arrives with the
                        status event, so this is the real percentage, not a guess
                        from the model name. */}
                    {a.ctxSize > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <div style={{ flex: 1, height: 3, background: '#1F1F23', borderRadius: 2, overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${Math.min(100, a.ctxPct)}%`,
                              height: '100%',
                              background: a.ctxPct > 85 ? '#ED1B2E' : a.ctxPct > 60 ? '#FFC83D' : '#4E6A65',
                            }}
                          />
                        </div>
                        <span style={{ ...mono, fontSize: 8.5, color: '#5A5A62' }}>{a.ctxPct}%</span>
                      </div>
                    )}
                    {a.lastTool && (
                      <div style={{ ...mono, fontSize: 9, color: '#5A5A62', marginTop: 3 }}>
                        {a.lastTool}
                        {a.lastActiveSecAgo != null && ` · ${a.lastActiveSecAgo}s ago`}
                      </div>
                    )}
                    {a.breaker && a.breaker !== 'healthy' && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          clearBreaker(a.key);
                        }}
                        style={{
                          ...mono,
                          fontSize: 9,
                          lineHeight: 1.5,
                          marginTop: 5,
                          padding: '4px 7px',
                          border: '1px solid #ED1B2E',
                          borderRadius: 5,
                          color: '#ED1B2E',
                        }}
                      >
                        breaker: {a.breaker} — {a.breakerReason}
                        <br />
                        <span style={{ textDecoration: 'underline' }}>click to clear</span>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* LEDGER — the structured board. The prose [TASK]/[DONE] rows below
                are still the narrative; this is the part the server can reason about. */}
            {ledger.length > 0 && (
              <>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 8.5,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#5A5A62',
                    padding: '12px 13px 6px',
                  }}
                >
                  ledger · {ledgerCounts.doing || 0} doing · {ledgerCounts.todo || 0} todo
                  {ledgerCounts.blocked ? ` · ${ledgerCounts.blocked} blocked` : ''}
                </div>
                {ledger
                  .filter((t) => t.status !== 'done')
                  .slice(0, 12)
                  .map((t) => (
                    <div key={t.id} style={{ padding: '6px 13px' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span
                          style={{
                            ...mono,
                            fontSize: 8.5,
                            textTransform: 'uppercase',
                            color:
                              t.status === 'blocked' ? '#ED1B2E' : t.status === 'doing' ? STATUS.working : '#5A5A62',
                          }}
                        >
                          {t.status}
                        </span>
                        <span style={{ ...mono, fontSize: 10.5, lineHeight: 1.5, color: '#F5F0E6', flex: 1 }}>
                          {t.title}
                        </span>
                      </div>
                      {/* An assignee is never cleared by a status change — a done
                          card must still say who did the work. */}
                      {t.assignee && (
                        <div style={{ ...mono, fontSize: 9, color: '#5A5A62' }}>{t.assignee}</div>
                      )}
                    </div>
                  ))}
              </>
            )}

            {/* live agents, each with whatever the board has assigned to them */}
            <div
              style={{
                ...archivo,
                fontWeight: 700,
                fontSize: 8.5,
                letterSpacing: '.18em',
                textTransform: 'uppercase',
                color: '#5A5A62',
                padding: '10px 13px 6px',
              }}
            >
              agents · {liveAgents.length} live
            </div>
            {liveAgents.length === 0 && (
              <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.6, color: '#5A5A62', padding: '0 13px 10px' }}>
                no sessions running — open an agent to start one
              </div>
            )}
            {liveAgents.map(({ office: o, agent: a, st }) => {
              const task = openTaskFor(o.id, a.id);
              const done = doneCountFor(o.id, a.id);
              const isOpen = open === `${o.id}/${a.id}`;
              return (
                <div
                  key={`${o.id}/${a.id}`}
                  className="hf-btn"
                  onClick={(e) => openAgent(o.id, a.id, e)}
                  style={{
                    padding: '8px 13px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #131316',
                    borderLeft: `3px solid ${isOpen ? statusColor(st) : 'transparent'}`,
                    background: isOpen ? '#101014' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: statusColor(st),
                        flexShrink: 0,
                        boxShadow: st === 'working' ? `0 0 7px ${statusColor(st)}` : 'none',
                      }}
                    />
                    <span
                      style={{
                        ...bebas,
                        fontSize: 15,
                        lineHeight: 1.1,
                        letterSpacing: '.03em',
                        color: '#F5F0E6',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {a.name}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span
                      style={{
                        ...mono,
                        fontSize: 8.5,
                        letterSpacing: '.06em',
                        color: statusColor(st),
                        flexShrink: 0,
                        textTransform: 'uppercase',
                      }}
                    >
                      {STATUS_LABEL[st] || st}
                    </span>
                  </div>
                  <div
                    style={{
                      ...mono,
                      fontSize: 9,
                      color: '#5A5A62',
                      marginTop: 2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {o.name.toLowerCase()}
                    {done > 0 ? ` · ${done} done` : ''}
                  </div>
                  {task && (
                    <div
                      style={{
                        ...mono,
                        fontSize: 10,
                        lineHeight: 1.5,
                        color: '#9A9AA3',
                        marginTop: 5,
                        paddingLeft: 7,
                        borderLeft: `2px solid ${statusColor(st)}55`,
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {task.text}
                    </div>
                  )}
                </div>
              );
            })}

            {/* assignments whose agent has no session running right now */}
            {unassigned.length > 0 && (
              <>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 8.5,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#5A5A62',
                    padding: '12px 13px 6px',
                    borderTop: '2px solid #1F1F23',
                  }}
                >
                  queued · {unassigned.length}
                </div>
                {unassigned.slice(0, 6).map((t, i) => (
                  <div key={`q${i}`} style={{ padding: '6px 13px', borderBottom: '1px solid #131316' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span
                        style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS.offline, flexShrink: 0 }}
                      />
                      <span style={{ ...mono, fontSize: 10, color: '#C9C9D1' }}>{t.agentName}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ ...mono, fontSize: 8.5, color: '#5A5A62' }}>{t.officeName.toLowerCase()}</span>
                    </div>
                    <div
                      style={{
                        ...mono,
                        fontSize: 10,
                        lineHeight: 1.5,
                        color: '#7A7A83',
                        marginTop: 3,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {t.text}
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* PRs — the thing a human most wants the moment a dev finishes */}
            {recentPRs.length > 0 && (
              <>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 8.5,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#5A5A62',
                    padding: '12px 13px 6px',
                    borderTop: '2px solid #1F1F23',
                  }}
                >
                  pull requests · {recentPRs.length}
                </div>
                {recentPRs.map((t, i) => (
                  <a
                    key={`pr${i}`}
                    href={t.pr}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'block',
                      padding: '7px 13px',
                      borderBottom: '1px solid #131316',
                      borderLeft: `3px solid ${STATUS.done}`,
                      textDecoration: 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ ...mono, fontSize: 10, color: STATUS.done, flexShrink: 0 }}>⎇</span>
                      <span style={{ ...mono, fontSize: 10, color: '#F5F0E6', flexShrink: 0 }}>
                        {t.ticket || t.agentName}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span style={{ ...mono, fontSize: 8.5, color: '#5A5A62', flexShrink: 0 }}>
                        {t.officeName.toLowerCase()}
                      </span>
                    </div>
                    <div
                      style={{
                        ...mono,
                        fontSize: 9.5,
                        color: '#6E8BFF',
                        marginTop: 3,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {t.pr.replace(/^https?:\/\/(www\.)?/, '')}
                    </div>
                  </a>
                ))}
              </>
            )}

            {/* tracker backlog — tickets on the board that nobody owns yet */}
            {(backlog.length > 0 || trackerError) && (
              <>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 8.5,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#5A5A62',
                    padding: '12px 13px 6px',
                    borderTop: '2px solid #1F1F23',
                  }}
                >
                  backlog · {backlog.length}
                </div>
                {trackerError && (
                  <div style={{ ...mono, fontSize: 9.5, lineHeight: 1.5, color: '#FFC83D', padding: '0 13px 8px' }}>
                    {trackerError}
                  </div>
                )}
                {backlog.map((t) => (
                  <a
                    key={t.key}
                    href={t.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: 'block', padding: '6px 13px', borderBottom: '1px solid #131316', textDecoration: 'none' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span
                        style={{
                          ...mono,
                          fontSize: 9,
                          color: t.priority === 'urgent' ? STATUS.offline : t.priority === 'high' ? '#FF6A1A' : '#5A5A62',
                          flexShrink: 0,
                        }}
                      >
                        ◇
                      </span>
                      <span style={{ ...mono, fontSize: 10, color: '#C9C9D1', flexShrink: 0 }}>{t.key}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ ...mono, fontSize: 8.5, color: '#5A5A62', flexShrink: 0 }}>{t.state}</span>
                    </div>
                    <div
                      style={{
                        ...mono,
                        fontSize: 10,
                        lineHeight: 1.5,
                        color: '#7A7A83',
                        marginTop: 3,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {t.title}
                    </div>
                  </a>
                ))}
              </>
            )}

            {/* what has actually landed */}
            {recentDone.length > 0 && (
              <>
                <div
                  style={{
                    ...archivo,
                    fontWeight: 700,
                    fontSize: 8.5,
                    letterSpacing: '.18em',
                    textTransform: 'uppercase',
                    color: '#5A5A62',
                    padding: '12px 13px 6px',
                    borderTop: '2px solid #1F1F23',
                  }}
                >
                  completed · {recentDone.length}
                </div>
                {recentDone.map((t, i) => (
                  <div key={`d${i}`} style={{ padding: '6px 13px', borderBottom: '1px solid #131316' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ ...mono, fontSize: 10, color: STATUS.done, flexShrink: 0 }}>✓</span>
                      <span
                        style={{
                          ...mono,
                          fontSize: 10,
                          color: '#C9C9D1',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.agentName}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span style={{ ...mono, fontSize: 8.5, color: '#5A5A62', flexShrink: 0 }}>
                        {t.officeName.toLowerCase()}
                      </span>
                    </div>
                    <div
                      style={{
                        ...mono,
                        fontSize: 10,
                        lineHeight: 1.5,
                        color: '#7A7A83',
                        marginTop: 3,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {t.text}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          <div
            style={{
              ...mono,
              fontSize: 9,
              color: '#5A5A62',
              padding: '8px 13px',
              borderTop: '2px solid #1F1F23',
            }}
          >
            from each office's memory board
          </div>
        </aside>
      </div>
    </div>
  );
}
