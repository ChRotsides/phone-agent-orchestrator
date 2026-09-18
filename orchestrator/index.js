// The tools JARVIS can call, and the job lifecycle behind them.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveProject, listProjects } from './projects.js';
import { createWorktree, commitAll, mergeJob, worktreeSummary, isRepo, removeWorktree } from './git.js';
import { runExecutor, EXECUTORS } from './executors.js';
import { route, availability } from './router.js';
import * as reg from './registry.js';
import * as sessions from './sessions.js';

export const bus = reg.bus;

// The newest finished-but-unmerged job for this project whose worktree is still on disk.
const CONTINUE_WINDOW_MIN = Number(process.env.JOB_CONTINUE_WINDOW_MIN || 180);

function findContinuation(projectName, executor) {
  const prior = sessions.getAgentSession(projectName, executor);
  if (!prior) return null; // no live agent session: treat as fresh work
  const candidate = reg
    .allJobs()
    .filter(
      (j) =>
        j.project?.name === projectName &&
        j.worktree &&
        j.branch &&
        !j.merged &&
        j.state === 'done' &&
        Date.now() - (j.finishedAt || 0) < CONTINUE_WINDOW_MIN * 60_000,
    )
    .slice(-1)[0];
  if (!candidate || !fs.existsSync(candidate.worktree)) return null;
  return { id: candidate.id, worktree: candidate.worktree, branch: candidate.branch, base: candidate.base };
}

// A git-backed sandbox for tasks that name no project.
function scratchWorkspace() {
  const dir = process.env.JARVIS_SCRATCH || path.join(os.homedir(), 'Documents/Projects/jarvis-scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const JOB_PREAMBLE = `You are running as an autonomous agent dispatched by voice. The user is not at a keyboard.
Work end to end without asking questions; if something is ambiguous, choose the most reasonable interpretation and note it.
Commit your work with a clear message when done. Finish with a 2-3 sentence plain-language summary of what changed.`;

// Past this gap the provider's prompt cache is long gone, so resuming would re-ingest
// the whole history for no benefit; start clean instead.
const SESSION_TTL_MIN = Number(process.env.AGENT_SESSION_TTL_MIN || 180);

async function startJob(job) {
  job.state = 'running';
  job.startedAt = Date.now();
  const controller = new AbortController();
  job.abort = () => controller.abort();

  // A follow-up in the same project continues the same agent, keeping its context.
  const prior = sessions.getAgentSession(job.project?.name, job.executor);
  const fresh = !prior || Date.now() - (prior.at || 0) > SESSION_TTL_MIN * 60_000;
  job.resumed = !fresh && !!prior?.id;

  const { done } = runExecutor(job.executor, `${JOB_PREAMBLE}\n\nTASK: ${job.task}`, job.cwd, {
    signal: controller.signal,
    resume: job.resumed ? prior.id : undefined,
    onSession: (sid) => {
      job.agentSession = sid;
      sessions.setAgentSession(job.project?.name, job.executor, sid);
    },
    onProgress: (beat) => reg.addBeat(job, beat),
  });

  const result = await done;
  if (result.limited) reg.markLimited(job.executor);

  if (job.worktree) {
    await commitAll(job.cwd, `jarvis(${job.id}): ${job.task.slice(0, 60)}`).catch(() => {});
    const sum = await worktreeSummary(job.cwd, job.base).catch(() => null);
    if (sum) {
      const parts = [sum.diffstat, sum.commits ? `${sum.commits} commit${sum.commits === 1 ? '' : 's'}` : ''].filter(Boolean);
      job.changes = parts.join(', ') || 'no changes';
    }
  }
  reg.finishJob(job, { ...result, cancelled: controller.signal.aborted });
  return job;
}

export const tools = {
  async dispatch_task({ task, project, executor_hint }, { conversationId } = {}) {
    if (!task?.trim()) return { ok: false, say: 'I need to know what the task is, sir.' };

    // Never run an agent in the host's own directory: unnamed work goes to a scratch repo.
    let cwd = scratchWorkspace(), proj = null, worktree = null, branch = null;
    if (project) {
      const r = resolveProject(project);
      if (r.status === 'not_found') {
        return { ok: false, say: `I can't find a project called ${project}. Nearest matches: ${r.suggestions.slice(0, 3).join(', ')}.` };
      }
      if (r.status === 'ambiguous') {
        return { ok: false, say: `Did you mean ${r.candidates.slice(0, 3).join(', or ')}?` };
      }
      proj = r.project;
      cwd = proj.dir;
    }

    const decision = await route(task, { hint: executor_hint });
    if (decision.clarify) return { ok: false, say: decision.clarify };

    const job = reg.createJob({ task: task.trim(), project: proj, executor: decision.executor, routing: decision });

    // A follow-up continues the previous job's branch, so the agent still sees the files
    // it just wrote rather than a fresh checkout of main.
    const continuation = proj ? findContinuation(proj.name, decision.executor) : null;

    // Isolated worktree so nothing lands on the user's branch until they say merge.
    const isolated = proj ? await isRepo(proj.dir) : false;
    if (proj && isolated) {
      try {
        if (continuation) {
          cwd = continuation.worktree; worktree = continuation.worktree; branch = continuation.branch;
          job.base = continuation.base;
          job.continues = continuation.id;
        } else {
          const wt = await createWorktree(proj.dir, job.id);
          cwd = wt.dir; worktree = wt.dir; branch = wt.branch;
          job.base = wt.base;
        }
      } catch (e) {
        reg.finishJob(job, { ok: false, summary: `could not create an isolated worktree: ${e.message}` });
        return { ok: false, say: `I couldn't isolate a workspace in ${proj.name}, so I've not started anything. Git said: ${e.message.split('\n')[0].slice(0, 120)}.` };
      }
    }
    Object.assign(job, { cwd, worktree, branch, repoDir: proj?.dir });

    startJob(job).catch((e) => reg.finishJob(job, { ok: false, summary: e.message }));

    if (conversationId) { job.conversationId = conversationId; sessions.attachJob(conversationId, job.id); }
    const label = EXECUTORS[job.executor]?.blurb.split('—')[0].trim() || job.executor;
    return {
      ok: true,
      job_id: job.id,
      say: `Job ${job.id} is with ${label}${proj ? ` in ${proj.name}` : ''}${
        branch
          ? job.continues
            ? `, continuing job ${job.continues} on branch ${branch.split('/').pop()}`
            : `, on its own branch`
          : proj
            ? `, though ${proj.name} is not a git repository, so it edits files in place`
            : ''
      }. ${decision.forced ? '' : decision.why ? `I chose it because ${decision.why}.` : ''} I'll tell you when it's done.`,
    };
  },

  async check_status({ job_id, verbose } = {}) {
    if (job_id) {
      const job = reg.getJob(job_id);
      if (!job) return { ok: false, say: `There's no job ${job_id}.` };
      return { ok: true, say: reg.describeJob(job, { verbose: true }) };
    }
    const active = reg.activeJobs();
    const recent = reg.recentJobs(3).filter((j) => j.state !== 'running' && j.state !== 'queued');
    if (!active.length && !recent.length) return { ok: true, say: 'Nothing running, sir. The floor is yours.' };
    const lines = [
      ...active.map((j) => reg.describeJob(j)),
      ...(active.length ? [] : recent.map((j) => reg.describeJob(j, { verbose }))),
    ];
    const limited = reg.limitedExecutors();
    if (limited.length) lines.push(`Note: ${limited.join(' and ')} ${limited.length === 1 ? 'is' : 'are'} rate limited.`);
    return { ok: true, say: lines.join(' ') };
  },

  async cancel_task({ job_id }) {
    const job = job_id ? reg.getJob(job_id) : reg.activeJobs().slice(-1)[0];
    if (!job) return { ok: false, say: 'There is nothing running to cancel.' };
    job.abort?.();
    return { ok: true, say: `Cancelling job ${job.id}.` };
  },

  async merge_job({ job_id }) {
    const job = job_id ? reg.getJob(job_id) : reg.allJobs().filter((j) => j.state === 'done' && j.branch).slice(-1)[0];
    if (!job) return { ok: false, say: 'I have no finished job with a branch to merge.' };
    if (job.state === 'running') return { ok: false, say: `Job ${job.id} is still running, sir.` };
    if (!job.branch || !job.repoDir) return { ok: false, say: `Job ${job.id} didn't run on a branch, so there's nothing to merge.` };
    if (job.merged) return { ok: false, say: `Job ${job.id} was already merged.` };

    const res = await mergeJob(job.repoDir, job.branch, { message: `jarvis(${job.id}): ${job.task.slice(0, 60)}` });
    if (!res.ok) {
      return { ok: false, say: `I couldn't merge job ${job.id}: ${res.reason}.${res.conflicts?.length ? ` Conflicts in ${res.conflicts.length} file${res.conflicts.length === 1 ? '' : 's'}.` : ''} Nothing was changed.` };
    }
    job.merged = true;
    await removeWorktree(job.repoDir, job.worktree, job.branch, { deleteBranch: true }).catch(() => {});
    return { ok: true, say: `Merged job ${job.id} into ${res.base}${res.detail ? `, ${res.detail}` : ''}.` };
  },

  async clear_session({ project } = {}) {
    let name = null;
    if (project) {
      const r = resolveProject(project);
      if (r.status === 'not_found') return { ok: false, say: `I don't know a project called ${project}.` };
      if (r.status === 'ambiguous') return { ok: false, say: `Did you mean ${r.candidates.slice(0, 3).join(', or ')}?` };
      name = r.project.name;
    }
    const cleared = sessions.clearAgentSessions(name);
    if (!cleared) return { ok: true, say: `There was no active agent session for ${name || 'the scratch workspace'}.` };
    return {
      ok: true,
      say: `Cleared ${cleared} agent session${cleared === 1 ? '' : 's'} for ${name || 'the scratch workspace'}. The next task starts fresh; the old transcripts stay on disk.`,
    };
  },

  async list_projects({ filter } = {}) {
    const names = listProjects().map((p) => p.name).filter((n) => !filter || n.toLowerCase().includes(String(filter).toLowerCase()));
    if (!names.length) return { ok: true, say: 'I see no projects matching that.' };
    return { ok: true, say: `${names.length} projects. Most relevant: ${names.slice(0, 8).join(', ')}.` };
  },

  async list_executors() {
    const { limited } = availability();
    const rows = Object.entries(EXECUTORS).map(([k, v]) => `${k}${limited.includes(k) ? ' (rate limited)' : ''}`);
    return { ok: true, say: `Available: ${rows.join(', ')}.` };
  },
};

export const toolSchemas = [
  {
    type: 'function', name: 'dispatch_task',
    description: 'Send a coding, refactoring, debugging or automation task to a PC coding agent. Use whenever the user asks for work to be DONE rather than discussed.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Full, self-contained description of the work, in the user\'s intent.' },
        project: { type: 'string', description: 'Project or repo name the user mentioned, if any.' },
        executor_hint: { type: 'string', description: 'Only if the user named a model or agent, e.g. "opus", "codex luna".' },
      },
      required: ['task'],
    },
  },
  {
    type: 'function', name: 'check_status',
    description: 'Report what the agents are doing right now, or the outcome of a specific job. Use when the user asks about progress, status, or what happened.',
    parameters: { type: 'object', properties: { job_id: { type: 'string' }, verbose: { type: 'boolean' } } },
  },
  {
    type: 'function', name: 'cancel_task',
    description: 'Stop a running job.',
    parameters: { type: 'object', properties: { job_id: { type: 'string' } } },
  },
  {
    type: 'function', name: 'merge_job',
    description: 'Merge a finished job\'s branch into the main branch. Use when the user says to merge, ship, land or accept the work.',
    parameters: { type: 'object', properties: { job_id: { type: 'string' } } },
  },
  {
    type: 'function', name: 'clear_session',
    description: 'Start the coding agents fresh for a project, forgetting the conversation they had been continuing. Use when the user says to clear, reset or start a new session for a project.',
    parameters: { type: 'object', properties: { project: { type: 'string', description: 'Project the user named.' } } },
  },
  {
    type: 'function', name: 'list_projects',
    description: 'List the projects available on the PC.',
    parameters: { type: 'object', properties: { filter: { type: 'string' } } },
  },
  {
    type: 'function', name: 'list_executors',
    description: 'List the coding agents available and which are rate limited.',
    parameters: { type: 'object', properties: {} },
  },
];

export async function callTool(name, args, ctx = {}) {
  const fn = tools[name];
  if (!fn) return { ok: false, say: `I don't have a tool called ${name}.` };
  try {
    return await fn(args || {}, ctx);
  } catch (e) {
    return { ok: false, say: `That failed: ${e.message}` };
  }
}

export { reg as registry };
