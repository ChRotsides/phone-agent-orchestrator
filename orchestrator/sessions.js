// Two kinds of session, both persisted:
//  - conversation sessions: what was said on the phone, browsable and resumable
//  - agent sessions: the underlying CLI session per project+executor, so follow-ups
//    continue the same agent instead of starting one that lost the thread
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.JARVIS_STATE || path.join(__dirname, '..', 'state');
const CONV_DIR = path.join(ROOT, 'conversations');
const AGENT_FILE = path.join(ROOT, 'agent-sessions.json');

fs.mkdirSync(CONV_DIR, { recursive: true });

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const convPath = (sid) => path.join(CONV_DIR, `${sid}.json`);

// ---------- conversation sessions ----------

export function createConversation(name) {
  const conv = {
    id: id(),
    name: name || defaultName(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lines: [],
    jobIds: [],
  };
  save(conv);
  return conv;
}

function defaultName() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hh}:${mm}`;
}

function save(conv) {
  conv.updatedAt = Date.now();
  fs.writeFileSync(convPath(conv.id), JSON.stringify(conv));
}

export function getConversation(sid) {
  try {
    return JSON.parse(fs.readFileSync(convPath(sid), 'utf8'));
  } catch {
    return null;
  }
}

export function listConversations(limit = 50) {
  return fs
    .readdirSync(CONV_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
        const lastSpoken = [...c.lines].reverse().find((l) => l.who !== 'tool');
        return {
          id: c.id,
          name: c.name,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          turns: c.lines.filter((l) => l.who !== 'tool').length,
          jobs: c.jobIds.length,
          preview: lastSpoken?.text?.slice(0, 80) || '',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function appendLine(sid, who, text) {
  const conv = getConversation(sid);
  if (!conv || !text?.trim()) return;
  const last = conv.lines[conv.lines.length - 1];
  if (last && last.who === who && last.text === text) return; // ignore duplicate flushes
  conv.lines.push({ who, text: text.trim(), at: Date.now() });
  if (conv.lines.length > 500) conv.lines.splice(0, conv.lines.length - 500);
  save(conv);
}

export function attachJob(sid, jobId) {
  const conv = getConversation(sid);
  if (!conv || conv.jobIds.includes(jobId)) return;
  conv.jobIds.push(jobId);
  save(conv);
}

export function renameConversation(sid, name) {
  const conv = getConversation(sid);
  if (!conv) return null;
  conv.name = name;
  save(conv);
  return conv;
}

export function deleteConversation(sid) {
  try {
    fs.unlinkSync(convPath(sid));
    return true;
  } catch {
    return false;
  }
}

// Resuming a conversation means handing the new voice session a compact recap,
// since the realtime model starts empty on every connection.
export function recapFor(sid, maxTurns = 12) {
  const conv = getConversation(sid);
  if (!conv || !conv.lines.length) return null;
  const turns = conv.lines.filter((l) => l.who !== 'tool').slice(-maxTurns);
  if (!turns.length) return null;
  return turns.map((l) => `${l.who === 'you' ? 'User' : 'You'}: ${l.text}`).join('\n');
}

// ---------- agent sessions ----------

function readAgents() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
  } catch {
    return {};
  }
}
const writeAgents = (data) => fs.writeFileSync(AGENT_FILE, JSON.stringify(data, null, 2));

const agentKey = (project, executor) => `${project || 'scratch'}::${executor}`;

export function getAgentSession(project, executor) {
  const entry = readAgents()[agentKey(project, executor)];
  return entry?.current ? { id: entry.current, at: entry.updatedAt || 0 } : null;
}

export function setAgentSession(project, executor, sessionId) {
  if (!sessionId) return;
  const all = readAgents();
  const k = agentKey(project, executor);
  const entry = all[k] || { history: [] };
  if (entry.current && entry.current !== sessionId && !entry.history.includes(entry.current)) {
    entry.history.push(entry.current);
  }
  entry.current = sessionId;
  entry.updatedAt = Date.now();
  all[k] = entry;
  writeAgents(all);
}

// "Clear the session for pond detection" — forget the pointer, keep the transcripts on disk.
export function clearAgentSessions(project) {
  const all = readAgents();
  const prefix = `${project || 'scratch'}::`;
  let cleared = 0;
  for (const [k, entry] of Object.entries(all)) {
    if (!k.startsWith(prefix) || !entry.current) continue;
    entry.history = [...(entry.history || []), entry.current];
    delete entry.current;
    entry.clearedAt = Date.now();
    all[k] = entry;
    cleared++;
  }
  writeAgents(all);
  return cleared;
}

export function agentSessionSummary() {
  return Object.entries(readAgents())
    .filter(([, v]) => v.current)
    .map(([k, v]) => ({ project: k.split('::')[0], executor: k.split('::')[1], session: v.current, updatedAt: v.updatedAt }));
}
