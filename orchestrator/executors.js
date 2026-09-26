// Executors: headless agent CLIs, each spawned into a job worktree and streamed back as progress events.
import { spawn } from 'node:child_process';

export const EXECUTORS = {
  // Claude Code — strongest on long multi-file reasoning and repo-wide refactors.
  'claude:fable': { cli: 'claude', model: 'fable', tier: 'fast', blurb: 'Fable 5.1 — quick, cheap, good at small well-scoped edits' },
  'claude:sonnet': { cli: 'claude', model: 'sonnet', tier: 'mid', blurb: 'Sonnet 5 — solid all-rounder for features and bugfixes' },
  'claude:opus': { cli: 'claude', model: 'opus', tier: 'deep', blurb: 'Opus 5 — deepest reasoning, big refactors, gnarly debugging' },
  // Codex — strong on precise, test-driven code work. Astra is not available on a ChatGPT account.
  'codex:sol': { cli: 'codex', model: 'gpt-5.6-sol', tier: 'mid', blurb: 'Sol — balanced Codex default' },
  'codex:terra': { cli: 'codex', model: 'gpt-5.6-terra', tier: 'fast', blurb: 'Terra — fast Codex runs' },
  'codex:luna': { cli: 'codex', model: 'gpt-5.6-luna', tier: 'deep', blurb: 'Luna — heavier Codex reasoning' },
  // Qoder CLI driving Qwen3.8-Max — third pool, independent quota.
  'qoder:max': { cli: 'qoder', model: process.env.QODER_MODEL || 'qwencloud-sg/qwen3.8-max-tp', tier: 'mid', blurb: 'Qwen3.8 Max via Qoder — independent quota pool' },
};

const LIMIT_RE = /rate.?limit(ed)?\b|usage limit reached|quota exceeded|too many requests|\b429\b|weekly limit reached|insufficient_quota|out of credits|credit usage limit|upgrade your subscription/i;
const QODER_BIN = process.env.QODER_BIN || `${process.env.HOME}/.qoder/bin/qodercli/qodercli-1.1.55`;

// `resume` is a prior CLI session id: the agent picks up where it left off.
function buildCommand(key, prompt, cwd, resume) {
  const ex = EXECUTORS[key];
  if (!ex) throw new Error(`unknown executor ${key}`);
  switch (ex.cli) {
    case 'claude':
      return {
        cmd: 'claude',
        args: [
          '-p', prompt, '--model', ex.model, '--output-format', 'stream-json', '--verbose',
          '--dangerously-skip-permissions',
          ...(resume ? ['--resume', resume] : []),
        ],
        cwd,
      };
    case 'codex':
      return {
        cmd: 'codex',
        args: resume
          ? ['exec', 'resume', resume, '--json', '-m', ex.model, '--dangerously-bypass-approvals-and-sandbox',
             '--skip-git-repo-check', '-C', cwd, prompt]
          : ['exec', '--json', '-m', ex.model, '--dangerously-bypass-approvals-and-sandbox',
             '--skip-git-repo-check', '-C', cwd, prompt],
        cwd,
      };
    case 'qoder':
      return {
        cmd: QODER_BIN,
        args: [
          '-p', prompt, '-m', ex.model, '--output-format', 'stream-json',
          '--dangerously-skip-permissions', '-w', cwd,
          ...(resume ? ['--resume', resume] : []),
        ],
        cwd,
      };
    default:
      throw new Error(`no command for ${ex.cli}`);
  }
}

// Each CLI announces its session id differently; we need it to resume later.
function sessionIdFrom(cli, e) {
  if (cli === 'claude' || cli === 'qoder') {
    if (e.type === 'system' && e.subtype === 'init') return e.session_id || null;
    return e.session_id || null;
  }
  if (cli === 'codex' && e.type === 'thread.started') return e.thread_id || null;
  return null;
}

// Each CLI speaks its own dialect; normalise to { kind, text } progress beats.
function parseLine(cli, line) {
  if (cli === 'qwen') return line.trim() ? { kind: 'text', text: line.trim() } : null;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return line.trim() ? { kind: 'text', text: line.trim() } : null;
  }

  if (cli === 'claude' || cli === 'qoder') {
    if (e.type === 'assistant') {
      for (const c of e.message?.content || []) {
        if (c.type === 'tool_use') return { kind: 'tool', text: describeTool(c.name, c.input) };
        if (c.type === 'text' && c.text.trim()) return { kind: 'text', text: c.text.trim().slice(0, 400) };
      }
      return null;
    }
    if (e.type === 'result') {
      return {
        kind: 'result', text: (e.result || '').slice(0, 20000), error: !!e.is_error,
        cost: e.total_cost_usd, ms: e.duration_ms,
        usage: e.usage ? {
          input: e.usage.input_tokens, output: e.usage.output_tokens,
          cacheRead: e.usage.cache_read_input_tokens, cacheWrite: e.usage.cache_creation_input_tokens,
        } : null,
      };
    }
    return null;
  }

  if (cli === 'codex') {
    // Codex speaks thread/turn/item events; the turn's end is the only real result.
    switch (e.type) {
      case 'item.started':
      case 'item.completed': {
        const item = e.item || {};
        if (item.type === 'agent_message' && item.text?.trim()) {
          return { kind: 'text', text: item.text.trim().slice(0, 20000) };
        }
        if (item.type === 'file_change' && e.type === 'item.started') {
          const files = (item.changes || []).map((c) => short(c.path)).slice(0, 3).join(', ');
          return { kind: 'tool', text: `editing ${files || 'files'}` };
        }
        if (item.type === 'command_execution' && e.type === 'item.started') {
          return { kind: 'tool', text: `running ${String(item.command || '').slice(0, 90)}` };
        }
        return null;
      }
      case 'turn.completed':
        return { kind: 'result', text: '', error: false };
      case 'turn.failed':
        return { kind: 'result', text: e.error?.message || 'turn failed', error: true };
      case 'error':
        return { kind: 'result', text: e.message || JSON.stringify(e).slice(0, 300), error: true };
      default:
        return null;
    }
  }
  return null;
}

function describeTool(name, input = {}) {
  const f = input.file_path || input.path || input.notebook_path;
  switch (name) {
    case 'Edit': case 'Write': case 'NotebookEdit': return `editing ${short(f)}`;
    case 'Read': return `reading ${short(f)}`;
    case 'Bash': return `running ${String(input.command || '').slice(0, 90)}`;
    case 'Grep': case 'Glob': return `searching for ${String(input.pattern || '').slice(0, 60)}`;
    case 'Task': return `delegating a subtask`;
    default: return `using ${name}`;
  }
}
const short = (p) => (p ? String(p).split('/').slice(-2).join('/') : 'a file');

export function runExecutor(key, prompt, cwd, { onProgress, onSession, signal, resume } = {}) {
  const { cmd, args } = buildCommand(key, prompt, cwd, resume);
  const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuf = '', stderrTail = '', finalText = '', limited = false, cost = 0;
  let sawResult = false, resultError = false, lastText = '', sessionId = null, usage = null;
  const beats = [];

  const feed = (chunk, isErr) => {
    const s = chunk.toString();
    if (isErr) {
      stderrTail = (stderrTail + s).slice(-4000);
      if (LIMIT_RE.test(s)) limited = true;
      return;
    }
    stdoutBuf += s;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (LIMIT_RE.test(line)) limited = true;
      if (!sessionId && line.startsWith('{')) {
        try {
          const found = sessionIdFrom(EXECUTORS[key].cli, JSON.parse(line));
          if (found) { sessionId = found; onSession?.(found); }
        } catch {}
      }
      const beat = parseLine(EXECUTORS[key].cli, line);
      if (!beat) continue;
      if (beat.kind === 'text') lastText = beat.text;
      if (beat.kind === 'result') {
        finalText = beat.text || lastText || finalText;
        if (beat.cost) cost = beat.cost;
        sawResult = true;
        resultError = !!beat.error;
        if (beat.usage) usage = beat.usage;
      }
      beats.push(beat);
      onProgress?.(beat);
    }
  };

  child.stdout.on('data', (c) => feed(c, false));
  child.stderr.on('data', (c) => feed(c, true));
  signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      resolve({
        ok: (sawResult ? !resultError : code === 0) && !limited,
        code,
        limited,
        cost,
        sessionId,
        usage,
        summary: finalText || beats.filter((b) => b.kind === 'text').slice(-1)[0]?.text || stderrTail.slice(-400) || 'no output',
        stderr: stderrTail.slice(-1000),
      });
    });
    child.on('error', (err) => resolve({ ok: false, code: -1, limited: false, summary: `failed to start ${cmd}: ${err.message}` }));
  });

  return { child, done };
}
