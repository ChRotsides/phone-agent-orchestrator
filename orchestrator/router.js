// Routing: qwen3.8-max picks the executor; deterministic rules cover the cases it shouldn't get wrong.
import { EXECUTORS } from './executors.js';
import { isLimited, limitedExecutors } from './registry.js';

const BASE = process.env.QWEN_BASE_URL || 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
// Routing is a 7-way classification, not deep reasoning: the flash model is both
// faster and adequate, with the deterministic guards below catching its mistakes.
const BRAIN = process.env.ORCHESTRATOR_MODEL || 'qwen3.8-flash';

const ROUTER_PROMPT = `You route coding tasks to one of several agent CLIs. Answer with JSON only.

Available executors:
{{ROSTER}}

Rules of thumb:
- Trivial or narrow edits (rename, add a log line, bump a version, one-file tweak) -> a "fast" tier executor.
- Normal feature work, bugfixes, tests -> "mid" tier.
- Architecture changes, multi-file refactors, subtle debugging, anything the user calls hard/important -> "deep" tier.
- Prefer claude:* for sprawling repo-wide reasoning, codex:* for precise test-driven code work, qoder:max when the others are limited.
- Never pick an executor listed as unavailable.
- When genuinely unsure, choose a "mid" tier executor rather than guessing high or low.
- An exploration or read-only investigation of a large codebase is "normal" unless the question is subtle.

Reply as JSON: {"executor":"<key>","difficulty":"trivial|normal|hard","why":"<12 words max>","clarify":"<question or empty>"}
Set "clarify" only if the task is too vague to start at all.`;

function roster() {
  return Object.entries(EXECUTORS)
    .map(([k, v]) => `- ${k} (${v.tier}): ${v.blurb}${isLimited(k) ? '  [UNAVAILABLE: rate limited]' : ''}`)
    .join('\n');
}

function firstAvailable(...keys) {
  return keys.find((k) => EXECUTORS[k] && !isLimited(k)) || Object.keys(EXECUTORS).find((k) => !isLimited(k)) || 'claude:sonnet';
}

// The user's word is final: "use opus", "with codex", "send it to luna".
export function explicitChoice(text = '') {
  const t = text.toLowerCase();
  const direct = Object.keys(EXECUTORS).find((k) => t.includes(k.replace(':', ' ')) || t.includes(k));
  if (direct) return direct;
  const alias = [
    [/\bopus\b/, 'claude:opus'], [/\bsonnet\b/, 'claude:sonnet'], [/\bfable\b/, 'claude:fable'],
    [/\bluna\b/, 'codex:luna'], [/\bterra\b/, 'codex:terra'], [/\bsol\b/, 'codex:sol'],
    [/\bqwen\b|\bqoder\b/, 'qoder:max'], [/\bclaude\b/, 'claude:sonnet'], [/\bcodex\b/, 'codex:sol'],
  ].find(([re]) => re.test(t));
  return alias?.[1] || null;
}

export async function route(task, { hint, spoken } = {}) {
  const forced = explicitChoice(hint || '') || explicitChoice(spoken || '') || explicitChoice(task);
  if (forced) return { executor: forced, difficulty: 'unknown', why: 'you asked for it', forced: true };

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: BRAIN,
        messages: [
          { role: 'system', content: ROUTER_PROMPT.replace('{{ROSTER}}', roster()) },
          { role: 'user', content: task },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`router HTTP ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    if (!EXECUTORS[parsed.executor] || isLimited(parsed.executor)) {
      parsed.executor = firstAvailable(parsed.executor, 'claude:sonnet', 'codex:sol', 'qoder:max');
      parsed.why = (parsed.why || '') + ' (rerouted, first choice unavailable)';
    }
    return parsed;
  } catch (err) {
    // Brain unreachable: fall back to a length/keyword heuristic rather than refusing the job.
    const t = task.toLowerCase();
    const hard = /refactor|architect|migrat|debug|why|redesign|performance|security|whole|entire/.test(t) || task.length > 300;
    const trivial = /rename|typo|comment|bump|log line|readme|format/.test(t) && task.length < 120;
    const executor = firstAvailable(hard ? 'claude:opus' : trivial ? 'claude:fable' : 'claude:sonnet');
    return { executor, difficulty: hard ? 'hard' : trivial ? 'trivial' : 'normal', why: `heuristic (router offline: ${err.message})` };
  }
}

export const availability = () => ({ limited: limitedExecutors(), all: Object.keys(EXECUTORS) });
