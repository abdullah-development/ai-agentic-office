import { promises as fs } from 'fs';
import path from 'path';

const FILE = path.join(process.cwd(), 'data', 'state.json');
// The floor is per-machine and git-ignored; this committed example is what a
// fresh clone starts from (server.js copies it on first boot).
const EXAMPLE = path.join(process.cwd(), 'data', 'state.example.json');

const DEFAULT_STATE = {
  offices: [
    {
      id: 'my-project',
      name: 'MY PROJECT',
      accent: '#ED1B2E',
      x: 0,
      y: 0,
      cwd: '',
      agents: [{ id: 'lead', name: 'LEAD', role: 'lead' }],
    },
  ],
};

export async function GET() {
  for (const file of [FILE, EXAMPLE]) {
    try {
      return Response.json(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {}
  }
  return Response.json(DEFAULT_STATE);
}

export async function POST(req) {
  const body = await req.json();
  if (!body || !Array.isArray(body.offices)) {
    return Response.json({ error: 'bad state' }, { status: 400 });
  }
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(body, null, 2));
  return Response.json({ ok: true });
}
