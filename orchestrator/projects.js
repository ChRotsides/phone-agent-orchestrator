// Resolving a spoken project name ("pond detection") to a directory on disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOTS = (process.env.PROJECT_ROOTS || path.join(os.homedir(), 'Documents/Projects'))
  .split(':')
  .filter(Boolean);

export function listProjects() {
  const out = [];
  for (const root of ROOTS) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      out.push({ name: e.name, dir, git: fs.existsSync(path.join(dir, '.git')) });
    }
  }
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Token-overlap scoring: speech gives us "pond detection", disk has "pond-detection-satellite".
function score(spoken, name) {
  const a = norm(spoken), b = norm(name);
  if (!a) return 0;
  if (a === b) return 1;
  const at = a.split(' '), bt = b.split(' ');
  const hits = at.filter((t) => bt.some((u) => u.startsWith(t) || t.startsWith(u))).length;
  let s = hits / at.length;
  if (b.startsWith(a)) s += 0.25;
  if (b.includes(a)) s += 0.15;
  return Math.min(1, s);
}

export function resolveProject(spoken) {
  if (!spoken) return { status: 'none' };
  const ranked = listProjects()
    .map((p) => ({ ...p, score: score(spoken, p.name) }))
    .sort((a, b) => b.score - a.score);

  const [best, second] = ranked;
  if (!best || best.score < 0.5) {
    return { status: 'not_found', suggestions: ranked.slice(0, 5).map((p) => p.name) };
  }
  if (second && second.score >= best.score - 0.05 && second.score >= 0.5) {
    return { status: 'ambiguous', candidates: [best, second, ...ranked.slice(2, 4)].filter((p) => p.score >= 0.5).map((p) => p.name) };
  }
  return { status: 'ok', project: best };
}
