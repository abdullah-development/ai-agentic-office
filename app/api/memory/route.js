import { promises as fs } from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory');

function fileFor(scope) {
  const safe = String(scope || 'floor').replace(/[^a-z0-9_-]/gi, '');
  return path.join(MEMORY_DIR, `${safe || 'floor'}.md`);
}

export async function GET(req) {
  const scope = new URL(req.url).searchParams.get('scope') || 'floor';
  try {
    const content = await fs.readFile(fileFor(scope), 'utf8');
    return Response.json({ scope, content });
  } catch {
    return Response.json({ scope, content: '' });
  }
}

export async function POST(req) {
  const { scope, content } = await req.json();
  if (typeof content !== 'string') return Response.json({ error: 'bad content' }, { status: 400 });
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  await fs.writeFile(fileFor(scope), content);
  return Response.json({ ok: true });
}
