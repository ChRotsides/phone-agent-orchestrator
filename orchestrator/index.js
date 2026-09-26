// The tools JARVIS can call, and the job lifecycle behind them.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveProject, listProjects } from './projects.js';
import { resolveFile, findFiles, readFileForSpeech } from './files.js';
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

// Roughly a minute of speech per chunk, split on sentence ends so nothing is cut mid-thought.
function splitForSpeech(text, target = 900) {
  const clean = text.replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/[ \t]+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const out = [];
  let buf = '';
  for (const sentence of sentences) {
    if (buf && buf.length + sentence.length > target) {
      out.push(buf.trim());
      buf = '';
    }
    buf += (buf ? ' ' : '') + sentence;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [clean];
}

// The first sentence is written to stand alone; that is what gets spoken on completion.
function headlineOf(report) {
  if (!report) return '';
  const first = report.replace(/\s+/g, ' ').trim();
  const m = first.match(/^(.{20,240}?[.!?])(\s|$)/);
  return (m ? m[1] : first.slice(0, 240)).trim();
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

// Exploration output is read aloud verbatim, so it must be written for the ear.
const EXPLORE_PREAMBLE = `You are an exploration agent dispatched by voice. The user is not at a keyboard and will hear your
report READ ALOUD, word for word, by a speaking assistant.

Investigate and report. Do NOT modify, create or delete any files, and do not commit anything — this is read-only work.

Write the report to be spoken:
- Plain prose in short paragraphs. No markdown, no bullet symbols, no code blocks, no tables.
- Name files sparingly and say them naturally, e.g. "the server file at the project root", not a full path.
- Do not quote long code. Describe what it does.
- Lead with the answer. Then the supporting detail. Then anything surprising or risky you noticed.
- Aim for 150-400 words unless the question demands more.
- Make the FIRST sentence a standalone headline answer, because that sentence alone may be all the user hears.`;

// Past this gap the provider's prompt cache is long gone, so resuming would re-ingest
// the whole history for no benefit; start clean instead.
const SESSION_TTL_MIN = Number(process.env.AGENT_SESSION_TTL_MIN || 180);

async function startJob(job) {
  job.state = 'running';
  job.startedAt = Date.now();
  const { controller } = job;

  // A follow-up in the same project continues the same agent, keeping its context.
  const prior = sessions.getAgentSession(job.project?.name, job.executor);
  const fresh = !prior || Date.now() - (prior.at || 0) > SESSION_TTL_MIN * 60_000;
  job.resumed = !fresh && !!prior?.id;

  const preamble = job.kind === 'explore' ? EXPLORE_PREAMBLE : JOB_PREAMBLE;
  const { done } = runExecutor(job.executor, `${preamble}\n\n${job.kind === 'explore' ? 'QUESTION' : 'TASK'}: ${job.task}`, job.cwd, {
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
  job.report = (result.summary || '').trim();
  job.headline = headlineOf(job.report);
  reg.finishJob(job, { ...result, cancelled: controller.signal.aborted });
  return job;
}

// What the user said since the last dispatch, so a model named aloud ("still sonnet five")
// is honoured even when the voice model forgets to pass it as a hint.
function spokenSinceLastDispatch(conversationId) {
  const lines = (conversationId && sessions.getConversation(conversationId)?.lines) || [];
  const recent = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (Date.now() - (l.at || 0) > 3 * 60_000) break;
    if (l.who === 'tool' && /^(dispatch_task|explore_codebase):/.test(l.text) && !/^\w+: Not dispatched/.test(l.text)) break;
    if (l.who === 'you') recent.unshift(l.text);
  }
  return recent.join(' ');
}

// Routing takes seconds against the remote model, so the voice answers first and the
// job is routed and spawned in the background.
async function startWork({ task, project, executor_hint, kind, replaces }, { conversationId } = {}) {
  if (!task?.trim()) return { ok: false, say: 'I need to know what to look at, sir.' };

  let proj = null;
  if (project) {
    const r = resolveProject(project);
    if (r.status === 'not_found') {
      return { ok: false, say: `I can't find a project called ${project}. Nearest matches: ${r.suggestions.slice(0, 3).join(', ')}.` };
    }
    if (r.status === 'ambiguous') return { ok: false, say: `Did you mean ${r.candidates.slice(0, 3).join(', or ')}?` };
    proj = r.project;
  }

  const old = replaces ? reg.getJob(String(replaces).replace(/^job\s*/i, '')) : null;
  if (replaces && !old) return { ok: false, say: `There's no job ${replaces} to replace, sir.` };

  const job = reg.createJob({ task: task.trim(), project: proj ?? old?.project ?? null, executor: null, kind, replaces: old?.id });
  // Created up front so a job can be cancelled while it is still being routed.
  job.controller = new AbortController();
  job.abort = () => job.controller.abort();
  if (conversationId) { job.conversationId = conversationId; sessions.attachJob(conversationId, job.id); }

  prepareAndStart(job, { executor_hint, spoken: spokenSinceLastDispatch(conversationId) }).catch((e) =>
    reg.finishJob(job, { ok: false, summary: `could not start: ${e.message}` }),
  );

  const stopping = old && (old.state === 'running' || old.state === 'queued');
  return {
    ok: true,
    job_id: job.id,
    ...(old ? { replaced: old.id } : {}),
    say: `${stopping ? `Stopping job ${old.id}. ` : ''}${kind === 'explore' ? 'Exploring' : 'On it'}${job.project ? ` in ${job.project.name}` : ''}, sir. That's job ${job.id}${old ? `, replacing ${old.id}` : ''}; I'll report back.`,
  };
}

const cancelledBeforeStart = (job) =>
  reg.finishJob(job, { ok: false, cancelled: true, summary: 'cancelled before it started' });

async function prepareAndStart(job, { executor_hint, spoken }) {
  // A correction supersedes the job it replaces: that one stops first, so the two
  // never work on the same thing at once.
  if (job.replaces) {
    const old = reg.getJob(job.replaces);
    if (old.state === 'running' || old.state === 'queued') {
      old.replacedBy = job.id;
      old.abort?.();
      await Promise.race([old.finished, new Promise((r) => setTimeout(r, 15_000))]);
    }
    const outcome = old.state === 'cancelled'
      ? 'It was stopped part-way, so it may have done some of that already.'
      : `It had already finished${old.result?.summary ? ` and reported: ${old.result.summary.slice(0, 600)}` : '.'}`;
    job.task += `\n\nThis corrects an earlier job (${old.id}) that was asked to: ${old.task}\n${outcome}\nCheck what it left behind and make the end state match this request.`;
  }
  if (job.controller.signal.aborted) return cancelledBeforeStart(job);

  const decision = await route(job.task, { hint: executor_hint, spoken });
  if (job.controller.signal.aborted) return cancelledBeforeStart(job);
  job.executor = decision.executor;
  job.routing = decision;

  const proj = job.project;
  let cwd = scratchWorkspace();
  const continuation = proj ? findContinuation(proj.name, decision.executor) : null;

  if (proj && (await isRepo(proj.dir))) {
    if (continuation) {
      cwd = continuation.worktree;
      Object.assign(job, { worktree: continuation.worktree, branch: continuation.branch, base: continuation.base, continues: continuation.id });
    } else {
      const wt = await createWorktree(proj.dir, job.id);
      cwd = wt.dir;
      Object.assign(job, { worktree: wt.dir, branch: wt.branch, base: wt.base });
    }
  } else if (proj) {
    cwd = proj.dir; // not a git repo: no isolation available
  }

  Object.assign(job, { cwd, repoDir: proj?.dir });
  reg.addBeat(job, { kind: 'text', text: `assigned to ${decision.executor}` });
  return startJob(job);
}

export const tools = {
  // Anything that changes the machine waits for the user's yes; the model otherwise
  // fills in names and targets on its own and runs with them.
  async dispatch_task({ task, project, executor_hint, read_only, confirmed, replaces }, ctx = {}) {
    if (!read_only && !confirmed) {
      return {
        ok: false,
        needs_confirmation: true,
        say: 'Not dispatched: this changes things on the PC. Tell the user in one sentence exactly what will be done, including any name, location or detail you chose yourself, and ask them to confirm. Call dispatch_task again with confirmed true only once they say yes.',
      };
    }
    return startWork({ task, project, executor_hint, kind: 'work', replaces }, ctx);
  },

  async explore_codebase({ question, project, executor_hint }, ctx = {}) {
    return startWork({ task: question, project, executor_hint, kind: 'explore' }, ctx);
  },

  // Reading a report back is the one place JARVIS must not paraphrase, so the text
  // is handed over in speakable chunks and marked verbatim.
  async read_report({ job_id, part } = {}) {
    const job = job_id
      ? reg.getJob(job_id)
      : reg.allJobs().filter((j) => j.report).slice(-1)[0];
    if (!job) return { ok: false, say: 'I have no report to read, sir.' };
    if (job.state === 'running' || job.state === 'queued') {
      return { ok: false, say: `Job ${job.id} is still working; there is no report yet.` };
    }
    const text = (job.report || job.result?.summary || '').trim();
    if (!text) return { ok: false, say: `Job ${job.id} finished without a report.` };

    const chunks = splitForSpeech(text);
    const idx = Math.min(Math.max(Number(part) || 1, 1), chunks.length) - 1;
    const more = idx < chunks.length - 1;
    return {
      ok: true,
      job_id: job.id,
      verbatim: chunks[idx],
      say: chunks[idx],
      part: idx + 1,
      parts: chunks.length,
      instruction: `Speak the text in "verbatim" exactly as written, word for word, in full. Do not summarise it, shorten it, rephrase it, or add commentary.${more ? ` When finished, say only: that is part ${idx + 1} of ${chunks.length}, say continue for more.` : ''}`,
    };
  },

  async read_file({ path: spoken, project, part, confirm, find } = {}) {
    if (!spoken) return { ok: false, say: 'Which file, sir?' };

    const r = resolveFile(spoken, project);
    if (r.status === 'not_found') {
      const near = findFiles(spoken, project, 4).map((h) => h.name);
      return { ok: false, say: `I can't find a file like ${spoken}${near.length ? `. Nearest: ${near.join(', ')}` : ''}.` };
    }
    if (r.status === 'ambiguous') {
      return { ok: false, say: `There are several: ${r.candidates.map((c) => c.path.split('/').slice(-2).join('/')).join(', ')}. Which one?` };
    }
    if (r.status === 'forbidden') return { ok: false, say: 'That file is outside the folders I can read, sir.' };

    const read = readFileForSpeech(r.file, { confirm: confirm === true });
    if (!read.ok) return { ok: false, say: `${read.reason}, sir.` };

    const chunks = splitForSpeech(read.text);
    let idx = Math.min(Math.max(Number(part) || 1, 1), chunks.length) - 1;
    if (find) {
      const at = chunks.findIndex((c) => c.toLowerCase().includes(String(find).toLowerCase()));
      if (at >= 0) idx = at;
    }
    const more = idx < chunks.length - 1;
    return {
      ok: true,
      file: r.file.split('/').slice(-2).join('/'),
      verbatim: chunks[idx],
      say: chunks[idx],
      part: idx + 1,
      parts: chunks.length,
      instruction: `Speak the text in "verbatim" exactly as written, word for word, in full. Do not summarise, shorten, rephrase or comment on it.${more ? ` Afterwards say only: that is part ${idx + 1} of ${chunks.length}, say continue for more.` : ''}`,
    };
  },

  async find_file({ name, project } = {}) {
    const hits = findFiles(name, project, 6);
    if (!hits.length) return { ok: false, say: `Nothing matching ${name}, sir.` };
    return { ok: true, say: `${hits.length} match${hits.length === 1 ? '' : 'es'}: ${hits.map((h) => h.path.split('/').slice(-2).join('/')).join(', ')}.` };
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
    const job = job_id ? reg.getJob(String(job_id).replace(/^job\s*/i, '')) : reg.activeJobs().slice(-1)[0];
    if (!job) return { ok: false, say: 'There is nothing running to cancel.' };
    if (job.state !== 'running' && job.state !== 'queued') return { ok: false, say: job.state === 'done' ? `Job ${job.id} has already finished.` : `Job ${job.id} was already ${job.state}.` };
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
    description: 'Run any task on the user\'s PC through a coding agent: inspecting or reading a codebase, searching files and directories, explaining or auditing code, investigating and diagnosing a problem, running commands or tests, as well as writing, fixing and refactoring code. Use this whenever the user asks for anything to be looked at, found out, checked, investigated or done on the machine — including questions about this system\'s own project, phone-agent-orchestrator.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Full, self-contained description of the work, in the user\'s intent. For an investigation, say what to find out and what to report back.' },
        project: { type: 'string', description: 'Project or repo name the user mentioned, if any.' },
        executor_hint: { type: 'string', description: 'The model or agent the user named for this job, e.g. "sonnet", "opus", "codex luna". Always pass it when they named one, including earlier in the same request ("still sonnet").' },
        read_only: { type: 'boolean', description: 'True when the task only looks, checks, measures or reports and changes nothing on the PC. Read-only tasks start straight away.' },
        confirmed: { type: 'boolean', description: 'For tasks that change anything (create, rename, move, delete, edit, install, commit): true only if the user said yes to your one-sentence restatement of the plan, or dictated every detail themselves (what, where, exact names) with nothing chosen by you. Never true for a name or target you proposed and they have not accepted.' },
        replaces: { type: 'string', description: 'Job id this task corrects or supersedes, e.g. when the user says "no, not X, Y" about a job just dispatched. The old job is stopped if still running, and the new one is told what it did.' },
      },
      required: ['task'],
    },
  },
  {
    type: 'function', name: 'explore_codebase',
    description: 'Send an exploration agent to investigate a codebase read-only and write a report: how something works, where something lives, why something behaves as it does, what the architecture is, what is risky. Use this for questions ABOUT code rather than changes TO code. The agent writes a spoken-style report you can read back with read_report.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to find out, phrased as a question or brief, self-contained.' },
        project: { type: 'string', description: 'Project the user named.' },
        executor_hint: { type: 'string', description: 'Only if the user named a model or agent.' },
      },
      required: ['question'],
    },
  },
  {
    type: 'function', name: 'read_report',
    description: "Fetch the exploring agent's own written report, to be spoken word for word. Use whenever the user asks to expand, to hear the full report, what exactly it found, or to continue reading a report.",
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Which job. Omit for the most recent report.' },
        part: { type: 'number', description: 'Which part to read; omit for part 1, then 2 to continue.' },
      },
    },
  },
  {
    type: 'function', name: 'read_file',
    description: 'Read a file on the PC aloud, word for word. Use when the user asks to read, hear, recite or go through a specific file, or to continue reading one. Returns the text in speakable parts.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File the user named: a name like "server.js", a relative path, or a full path.' },
        project: { type: 'string', description: 'Project it lives in, if the user said one.' },
        part: { type: 'number', description: 'Which part to read; omit for part 1, then 2 to continue.' },
        find: { type: 'string', description: 'Jump to the part containing this text.' },
        confirm: { type: 'boolean', description: 'Set true only when the user insists on hearing a credentials file.' },
      },
      required: ['path'],
    },
  },
  {
    type: 'function', name: 'find_file',
    description: 'Locate files by name on the PC when you are unsure which file the user means.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, project: { type: 'string' } }, required: ['name'] },
  },
  {
    type: 'function', name: 'check_status',
    description: 'Report what the agents are doing right now, or the outcome of a specific job. Use when the user asks about progress, status, or what happened.',
    parameters: { type: 'object', properties: { job_id: { type: 'string' }, verbose: { type: 'boolean' } } },
  },
  {
    type: 'function', name: 'cancel_task',
    description: 'Stop a running job. Use when the user says stop, cancel, abort, never mind or hold that job. Omit job_id for the most recent running job.',
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
    description: 'List projects on the PC, optionally filtered by a word in the name. Prefer passing a filter over listing everything.',
    parameters: { type: 'object', properties: { filter: { type: 'string', description: 'Word the project name should contain, e.g. "agent".' } } },
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
