// Reading things aloud: turning a spoken reference into a file on disk, safely.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listProjects, resolveProject } from './projects.js';

const ROOTS = (process.env.READABLE_ROOTS || process.env.PROJECT_ROOTS || path.join(os.homedir(), 'Documents/Projects'))
  .split(':')
  .filter(Boolean)
  .map((r) => path.resolve(r));

// Files whose contents should not be spoken out loud without being asked twice.
const SECRET = /(^|\/)(\.env|\.env\..+|id_[a-z]+|.*\.pem|.*\.key|credentials\.json|auth\.json|\.netrc|\.npmrc)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '__pycache__', '.venv', 'target', '.gradle']);

const inRoots = (p) => ROOTS.some((r) => p === r || p.startsWith(r + path.sep));

// "the server file in phone agent orchestrator" -> an actual path
const flatten = (n) => String(n).toLowerCase().replace(/[^a-z0-9.]+/g, '');
const stemOf = (n) => flatten(n).replace(/\.[^.]*$/, '');

export function findFiles(name, projectHint, limit = 8) {
  const needle = flatten(name);
  const needleStem = stemOf(name);
  if (!needle) return [];

  let dirs = [];
  if (projectHint) {
    const r = resolveProject(projectHint);
    if (r.status === 'ok') dirs = [r.project.dir];
  }
  if (!dirs.length) dirs = listProjects().map((p) => p.dir);

  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4 || hits.length >= limit * 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else {
        const flat = flatten(e.name);
        const stem = stemOf(e.name);
        // An empty stem (".env") must never behave as a wildcard.
        let rank = null;
        if (flat === needle) rank = 0;
        else if (needleStem.length >= 3 && stem === needleStem) rank = 1;
        else if (needleStem.length >= 3 && stem.includes(needleStem)) rank = 2;
        else if (needle.length >= 3 && flat.includes(needle)) rank = 3;
        if (rank !== null) hits.push({ path: full, name: e.name, rank, size: fs.statSync(full).size });
      }
    }
  };
  for (const d of dirs) walk(d, 0);

  // Match quality first — an exact filename beats a shallower near-miss — then shallowest path.
  return hits
    .sort((a, b) => a.rank - b.rank || a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length)
    .slice(0, limit);
}

export function resolveFile(spoken, projectHint) {
  if (!spoken) return { status: 'none' };

  // An explicit path, possibly relative to a named project.
  let direct = null;
  if (spoken.startsWith('/')) direct = path.resolve(spoken);
  else if (spoken.startsWith('~')) direct = path.resolve(spoken.replace(/^~/, os.homedir()));
  else if (projectHint) {
    const r = resolveProject(projectHint);
    if (r.status === 'ok') {
      const candidate = path.resolve(r.project.dir, spoken);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) direct = candidate;
    }
  }
  if (direct && fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    if (!inRoots(direct)) return { status: 'forbidden', file: direct };
    return { status: 'ok', file: direct };
  }

  const hits = findFiles(path.basename(spoken), projectHint);
  if (!hits.length) return { status: 'not_found' };
  if (hits.length > 1 && hits[0].rank === hits[1].rank && hits[0].path.split('/').length === hits[1].path.split('/').length) {
    return { status: 'ambiguous', candidates: hits.slice(0, 4) };
  }
  return { status: 'ok', file: hits[0].path };
}

export function readFileForSpeech(file, { confirm = false } = {}) {
  if (!inRoots(path.resolve(file))) return { ok: false, reason: 'that file is outside the folders I am allowed to read' };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: 'I cannot open that file' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'that is a directory, not a file' };
  if (stat.size > 400_000) return { ok: false, reason: `that file is ${Math.round(stat.size / 1024)} kilobytes — too long to read aloud` };

  if (SECRET.test(file) && !confirm) {
    return { ok: false, secret: true, reason: 'that file holds credentials — say "read it anyway" and I will' };
  }

  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4096).includes(0)) return { ok: false, reason: 'that is a binary file, there is nothing to read aloud' };

  return { ok: true, text: buf.toString('utf8'), bytes: stat.size };
}
