// Job registry: the single source of truth the voice agent reads from.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, '..', 'jobs.jsonl');

export const bus = new EventEmitter();
const jobs = new Map();
const cooldowns = new Map(); // executor key -> epoch ms until usable again

// Short, unique, and still speakable: "job 4k2".
let seq = 0;
const stamp = Date.now().toString(36).slice(-2);
const nextId = () => `${++seq}${stamp}`;

export function createJob(fields) {
  const job = {
    id: nextId(),
    state: 'queued',
    createdAt: Date.now(),
    beats: [],
    ...fields,
  };
  // Lets a replacement job wait for the one it supersedes to actually stop.
  job.finished = new Promise((resolve) => { job.resolveFinished = resolve; });
  jobs.set(job.id, job);
  persist('create', job);
  bus.emit('job', { type: 'created', job });
  return job;
}

export function addBeat(job, beat) {
  job.beats.push({ ...beat, at: Date.now() });
  if (job.beats.length > 200) job.beats.splice(0, job.beats.length - 200);
  job.lastBeat = beat.text;
  bus.emit('job', { type: 'progress', job, beat });
}

export function finishJob(job, result) {
  job.state = result.cancelled ? 'cancelled' : result.ok ? 'done' : 'failed';
  job.result = result;
  job.finishedAt = Date.now();
  persist('finish', job);
  job.resolveFinished?.(job);
  bus.emit('job', { type: 'finished', job });
}

export const getJob = (id) => jobs.get(String(id));
export const allJobs = () => [...jobs.values()];
export const activeJobs = () => allJobs().filter((j) => j.state === 'running' || j.state === 'queued');
export const recentJobs = (n = 5) => allJobs().slice(-n).reverse();

export function markLimited(key, minutes = 30) {
  cooldowns.set(key, Date.now() + minutes * 60_000);
  bus.emit('limit', { key, until: cooldowns.get(key) });
}
export const isLimited = (key) => (cooldowns.get(key) || 0) > Date.now();
export const limitedExecutors = () => [...cooldowns.entries()].filter(([, t]) => t > Date.now()).map(([k]) => k);

// Speech-shaped, not log-shaped: what JARVIS should say when asked.
export function describeJob(job, { verbose = false } = {}) {
  const mins = Math.round((Date.now() - job.createdAt) / 60000);
  const age = mins < 1 ? 'just started' : `running ${mins} minute${mins === 1 ? '' : 's'}`;
  const who = job.executor || 'unassigned';
  const head = `Job ${job.id}, ${who}, ${job.project?.name || 'no project'}: ${job.task}`;
  if (job.state === 'running') {
    const edits = job.beats.filter((b) => b.kind === 'tool' && /editing/.test(b.text)).length;
    return `${head} — ${age}${job.lastBeat ? `, currently ${job.lastBeat}` : ''}${edits ? `, ${edits} file operations so far` : ''}.`;
  }
  if (job.state === 'done') {
    if (job.kind === 'explore') {
      // The agent's own headline, not a paraphrase of it.
      return `Exploration job ${job.id}${job.project?.name ? ` in ${job.project.name}` : ''} has finished. Its headline finding, in its own words: "${job.headline || 'no headline given'}" The full report is ready to read out.`;
    }
    return `${head} — finished${job.changes ? `, ${job.changes}` : ''}${job.branch ? `, on branch ${job.branch}` : ''}.${verbose && job.result?.summary ? ` It reports: ${job.result.summary.slice(0, 400)}` : ''}`;
  }
  if (job.state === 'failed') return `${head} — failed. ${job.result?.summary?.slice(0, 300) || ''}`;
  if (job.state === 'cancelled') return `${head} — cancelled${job.replacedBy ? `, replaced by job ${job.replacedBy}` : ''}.`;
  return `${head} — ${job.state}.`;
}

function persist(kind, job) {
  const row = {
    kind, at: Date.now(), id: job.id, state: job.state, executor: job.executor,
    project: job.project?.name, task: job.task, branch: job.branch,
    result: job.result ? { ok: job.result.ok, summary: job.result.summary?.slice(0, 500) } : undefined,
  };
  fs.appendFile(LOG, JSON.stringify(row) + '\n', () => {});
}
