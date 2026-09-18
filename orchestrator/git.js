// Per-job git worktrees, and the merge-back path that voice can trigger.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const git = (dir, args) => exec('git', ['-C', dir, ...args], { maxBuffer: 8 << 20 });

export async function isRepo(dir) {
  try {
    await git(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function defaultBranch(dir) {
  for (const probe of ['main', 'master']) {
    try {
      await git(dir, ['show-ref', '--verify', `refs/heads/${probe}`]);
      return probe;
    } catch {}
  }
  const { stdout } = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

// Jobs never touch the working tree: each gets a branch + worktree under .jarvis-worktrees/.
export async function createWorktree(repoDir, jobId) {
  const base = await defaultBranch(repoDir);
  let branch = `jarvis/${jobId}`;
  let wt = path.join(repoDir, '.jarvis-worktrees', jobId);

  // A killed run can leave both behind; never reuse one, pick the next free name.
  await git(repoDir, ['worktree', 'prune']).catch(() => {});
  for (let n = 2; fs.existsSync(wt) || (await branchExists(repoDir, branch)); n++) {
    branch = `jarvis/${jobId}-${n}`;
    wt = path.join(repoDir, '.jarvis-worktrees', `${jobId}-${n}`);
  }

  fs.mkdirSync(path.dirname(wt), { recursive: true });
  await git(repoDir, ['worktree', 'add', '-b', branch, wt, base]);

  const ignore = path.join(repoDir, '.git', 'info', 'exclude');
  try {
    if (!fs.readFileSync(ignore, 'utf8').includes('.jarvis-worktrees')) {
      fs.appendFileSync(ignore, '\n.jarvis-worktrees/\n');
    }
  } catch {}
  return { dir: wt, branch, base };
}

// Compared against the branch the job forked from — the worktree has no upstream.
async function branchExists(dir, branch) {
  try {
    await git(dir, ['show-ref', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function worktreeSummary(wt, base) {
  const ref = base || (await defaultBranch(wt));
  const { stdout: status } = await git(wt, ['status', '--porcelain']);
  const { stdout: log } = await git(wt, ['log', '--oneline', `${ref}..HEAD`]).catch(() => ({ stdout: '' }));
  const { stdout: diff } = await git(wt, ['diff', '--shortstat', `${ref}...HEAD`]).catch(() => ({ stdout: '' }));
  const commits = log.trim().split('\n').filter(Boolean).length;
  return {
    dirty: status.trim().split('\n').filter(Boolean).length,
    commits,
    diffstat: diff.trim(),
  };
}

// Build artefacts an agent leaves behind should never enter a branch that gets merged.
const JUNK = ['__pycache__/', '*.pyc', '*.pyo', 'node_modules/', '.DS_Store', '*.log', '.pytest_cache/', '.venv/', 'dist/', 'build/'];

async function excludeJunk(wt) {
  const { stdout } = await git(wt, ['rev-parse', '--git-path', 'info/exclude']);
  const file = path.resolve(wt, stdout.trim());
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = JUNK.filter((j) => !current.includes(j));
    if (missing.length) fs.appendFileSync(file, `\n# added by jarvis\n${missing.join('\n')}\n`);
  } catch {}
}

// Commit anything the agent left uncommitted, so a merge captures the whole job.
export async function commitAll(wt, message) {
  await excludeJunk(wt);
  const { stdout } = await git(wt, ['status', '--porcelain']);
  if (!stdout.trim()) return false;
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '-m', message]);
  return true;
}

export async function mergeJob(repoDir, branch, { message } = {}) {
  const base = await defaultBranch(repoDir);
  // Untracked files don't impede a merge; only tracked modifications do.
  const { stdout: dirty } = await git(repoDir, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.trim()) {
    return { ok: false, reason: `your working tree has ${dirty.trim().split('\n').length} uncommitted change${dirty.trim().split('\n').length === 1 ? '' : 's'} — commit or stash them first` };
  }
  const { stdout: current } = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.trim() !== base) await git(repoDir, ['checkout', base]);

  try {
    const { stdout } = await git(repoDir, ['merge', '--no-ff', branch, '-m', message || `Merge ${branch}`]);
    const { stdout: stat } = await git(repoDir, ['diff', '--shortstat', 'HEAD~1', 'HEAD']).catch(() => ({ stdout: '' }));
    return { ok: true, base, detail: stat.trim() || stdout.trim().split('\n')[0] };
  } catch (e) {
    await git(repoDir, ['merge', '--abort']).catch(() => {});
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const blocked = out.match(/untracked working tree files would be overwritten[\s\S]*?\n\n/);
    if (blocked) {
      const files = out.match(/^\t(.+)$/gm)?.map((f) => f.trim()).slice(0, 3) || [];
      return { ok: false, reason: `untracked files on ${base} are in the way${files.length ? ` (${files.join(', ')})` : ''} — remove them and I'll retry` };
    }
    const conflicts = out.match(/CONFLICT[^\n]*/g) || [];
    return { ok: false, reason: 'merge conflicts, aborted cleanly', conflicts: conflicts.slice(0, 5) };
  }
}

export async function removeWorktree(repoDir, wtDir, branch, { deleteBranch = false } = {}) {
  await git(repoDir, ['worktree', 'remove', '--force', wtDir]).catch(() => {});
  if (deleteBranch) await git(repoDir, ['branch', '-D', branch]).catch(() => {});
}
