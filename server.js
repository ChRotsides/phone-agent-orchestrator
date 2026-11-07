// JARVIS host: HTTPS app server + realtime voice session + tool execution.
// The phone only streams microphone audio and plays audio back. Persona, tools,
// job orchestration and the API key all live here.
import 'dotenv/config';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { toolSchemas, callTool, bus, registry } from './orchestrator/index.js';
import * as sessions from './orchestrator/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8443);
// Voice provider: OpenAI's realtime model when its key is set, otherwise Qwen. Both speak
// the same realtime protocol; OpenAI's differences are adapted at the edges below.
const PROVIDER = process.env.VOICE_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'qwen');
const OPENAI = PROVIDER === 'openai';
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
const API_KEY = OPENAI ? process.env.OPENAI_API_KEY : process.env.QWEN_API_KEY;
const UPSTREAM = OPENAI
  ? `wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1'}`
  : process.env.QWEN_REALTIME_URL;
const VOICE = OPENAI
  ? (OPENAI_VOICES.has(process.env.OPENAI_VOICE) ? process.env.OPENAI_VOICE : 'cedar')
  : process.env.JARVIS_VOICE || 'daniel';

if (!API_KEY || !UPSTREAM) {
  console.error(OPENAI ? 'Missing OPENAI_API_KEY in .env' : 'Missing QWEN_API_KEY or QWEN_REALTIME_URL in .env');
  process.exit(1);
}

const INSTRUCTIONS = `You are JARVIS, the user's personal AI assistant. You are SPEAKING ALOUD: your words are
synthesised and played through the user's phone, and you hear them through its microphone. This is a voice call, not a
text chat. Never say you are text-only or that you cannot speak — you can, and you are.

Voice: dry British wit, calm precision, complete confidence. Call the user "sir" occasionally, never every sentence.
One or two sentences unless asked to elaborate. Never read out logs, code or file paths verbatim — describe them.

You command a fleet of coding agents running on the user's PC. Through them you can do ANYTHING that can be done on
that machine: read and inspect any codebase, search files and directories, explain how code works, audit, debug,
investigate why something behaves the way it does, run commands and tests, write and refactor code, and check on
your own source — this system is the "phone-agent-orchestrator" project, and you can dispatch an agent to examine it
like any other.

So: when the user asks you to look at, check, inspect, find, investigate, diagnose or explain ANYTHING on the machine,
call dispatch_task. That IS your capability. Never reply that a request is outside what you can do, that you cannot
inspect files or directories, or that your tools are limited to managing tasks — dispatch a task instead and report
what comes back. The only things you answer yourself are general conversation and questions about jobs you have run.

Questions ABOUT code — how does this work, where is this, why does it do that, what is the architecture — go to
explore_codebase, which sends an agent to investigate and write a report. Changes TO code go to dispatch_task.

When an exploration finishes you announce its headline finding in the agent's own words, and offer the full report.
If the user asks to expand, to hear it all, what exactly it found, or to continue, call read_report.
You can also read any file on the PC aloud with read_file, and find one with find_file when the name is vague.

READING ALOUD IS A DISTINCT MODE. A tool result containing a "verbatim" field is someone else's words — an agent's
report, or a file's contents. SPEAK IT EXACTLY AS WRITTEN, word for word, in full, to the end. Do not summarise it,
shorten it, rephrase it, correct it, or add commentary before or after. You are reading it aloud on their behalf, not
describing it. If more parts remain, read this part fully, then offer to continue.

When the user says "expand on that", "read it to me", "what exactly did it say", "the whole thing" or "continue", work
out from the conversation WHAT they mean: the report of the exploration you just announced (read_report), the file you
were just discussing or that you just named (read_file), or the next part of whatever you were already reading. Choose
it yourself from context. Only if it is genuinely unclear, ask in one short sentence which they mean.

LOOK BEFORE YOU LEAP. Checking, measuring, reading and investigating (read_only) you start straight away. Anything that
CHANGES the machine — creating, renaming, moving, deleting, editing, installing, committing — you first restate in one
sentence exactly what will happen, including any name, location or detail you picked yourself, and wait for a clear yes.
"Wait", "hold on", "no", or a sentence that trails off is NOT a yes: stop and listen. If the user asks you to choose
something, such as a name, propose it and ask; never act on your own proposal until they accept it. A remark about
something else ("that's good", "thanks") is not approval of a pending plan.

CORRECTIONS REPLACE, THEY DO NOT ADD. If the user corrects or changes a job you already dispatched ("no, not X, Y"),
dispatch the corrected task with replaces set to that job's id — never start a second job alongside the first. If they
say stop, cancel or never mind about a job, call cancel_task.

Do not ask which model to use — that is chosen for you — but if the user names one ("sonnet", "opus", "codex"), pass it
as executor_hint, and keep using it for follow-ups when they say "still" or "same one".

LISTENING. You hear the user through speech recognition, which is imperfect. If what you hear is a fragment or stops
mid-sentence, say at most "Go on, sir" and wait for the rest instead of acting on it. Speak English. A lone syllable or
character in another language (a single Chinese or Japanese character, say) is the recogniser mishearing noise: ignore
it. Only switch language if the user clearly speaks whole sentences in another one, and switch back when they do.
If you are cut off mid-sentence, the user wanted to speak: respond to what they said, and do not restart what you were
saying unless they ask.

When the user asks what is happening, call check_status. When they say merge, ship or land, call merge_job.
When they say clear or reset a project's session, call clear_session. To find a project, call list_projects with a
filter word rather than guessing. If a tool returns a question, ask it in your own words.`;

// Silence that ends the user's turn. Long enough to survive a mid-sentence pause.
const TURN_DETECTION = { type: 'server_vad', threshold: 0.55, silence_duration_ms: 1200 };

// OpenAI nests audio settings under session.audio and needs session.type; Qwen takes them flat.
const sessionConfig = () => (OPENAI
  ? {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: INSTRUCTIONS,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turn_detection: TURN_DETECTION,
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: VOICE },
      },
      tools: toolSchemas,
      tool_choice: 'auto',
    }
  : {
      modalities: ['text', 'audio'],
      instructions: INSTRUCTIONS,
      voice: VOICE,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: { model: 'fun-asr' },
      turn_detection: TURN_DETECTION,
      tools: toolSchemas,
      tool_choice: 'auto',
    });
const voiceUpdate = (voice) => (OPENAI ? { type: 'realtime', audio: { output: { voice } } } : { voice });
const vadUpdate = (td) => (OPENAI ? { type: 'realtime', audio: { input: { turn_detection: td } } } : { turn_detection: td });

// The phone and its app speak the original event names; OpenAI renamed the output ones.
const LEGACY_EVENTS = {
  'response.output_audio.delta': 'response.audio.delta',
  'response.output_audio.done': 'response.audio.done',
  'response.output_audio_transcript.delta': 'response.audio_transcript.delta',
  'response.output_audio_transcript.done': 'response.audio_transcript.done',
  'response.output_text.delta': 'response.text.delta',
  'response.output_text.done': 'response.text.done',
};

// The phone records 16 kHz PCM16; OpenAI only accepts 24 kHz. Linear interpolation is
// plenty for speech going into a recogniser.
function upsample16to24(b64) {
  const src = Buffer.from(b64, 'base64');
  const n = src.length >> 1;
  const m = Math.floor((n * 3) / 2);
  const out = Buffer.alloc(m * 2);
  for (let i = 0; i < m; i++) {
    const x = (i * 2) / 3, j = Math.floor(x), f = x - j;
    const a = src.readInt16LE(j * 2);
    const b = j + 1 < n ? src.readInt16LE((j + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out.toString('base64');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, upstream: UPSTREAM, jobs: registry.allJobs().length }));
const jobView = (j) => ({
  id: j.id, state: j.state, executor: j.executor, project: j.project?.name,
  task: j.task, branch: j.branch, lastBeat: j.lastBeat, changes: j.changes,
  resumed: !!j.resumed, merged: !!j.merged, continues: j.continues, conversationId: j.conversationId,
  createdAt: j.createdAt, finishedAt: j.finishedAt,
  summary: j.result?.summary?.slice(0, 600),
});
app.get('/api/jobs', (_req, res) => res.json(registry.allJobs().map(jobView)));
app.get('/api/sessions', (_req, res) => res.json(sessions.listConversations()));
app.get('/api/sessions/:id', (req, res) => res.json(sessions.getConversation(req.params.id) || {}));

// Installing over the VPN: the phone downloads the APK from here, so no adb and no
// Wi-Fi are needed. Plain HTTP, because Chrome refuses downloads over a bad certificate.
const APK = path.join(__dirname, 'app/build/app/outputs/flutter-apk/app-debug.apk');

function apkHandler(req, res) {
  if (req.url === '/app.apk') {
    if (!fs.existsSync(APK)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('no APK built yet — run: cd app && flutter build apk --debug');
    }
    const { size, mtime } = fs.statSync(APK);
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': size,
      'content-disposition': 'attachment; filename="jarvis.apk"',
      'last-modified': mtime.toUTCString(),
    });
    return fs.createReadStream(APK).pipe(res);
  }
  const built = fs.existsSync(APK) ? new Date(fs.statSync(APK).mtime).toLocaleString('en-GB') : 'not built';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{background:#04080d;color:#cfeeff;font:15px ui-monospace,monospace;display:flex;flex-direction:column;
gap:18px;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}
a{color:#04080d;background:#5bd8ff;padding:16px 28px;border-radius:10px;text-decoration:none;letter-spacing:3px}
small{color:#1d6f8f;line-height:1.6}</style>
<div style="color:#5bd8ff;letter-spacing:7px">J.A.R.V.I.S</div>
<a href="/app.apk">INSTALL</a>
<small>built ${built}<br>allow "install unknown apps" if Android asks<br>then set the host to this address</small>`);
}

http.createServer(apkHandler).listen(Number(process.env.HTTP_PORT || 8080), '0.0.0.0', () => {
  console.log(`APK install page on http://<host>:${process.env.HTTP_PORT || 8080}/`);
});

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, 'certs/key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs/cert.pem')),
  },
  app,
);

const wss = new WebSocketServer({ server, path: '/rt' });
const CLIENT_ALLOWED = new Set([
  'input_audio_buffer.append', 'input_audio_buffer.commit', 'input_audio_buffer.clear',
  'response.create', 'response.cancel', 'conversation.item.create',
]);

wss.on('connection', (client) => {
  console.log('[rt] phone connected');
  const upstream = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const pending = [];
  const toPhone = (o) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(o));
  const sendNow = (o) => {
    const s = JSON.stringify(o);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(s);
    else pending.push(s);
  };

  // Nothing the phone says may overtake the session recap, or the model answers
  // the first question without its own history.
  let gateOpen = false;
  const gated = [];
  const toModel = (o) => (gateOpen ? sendNow(o) : gated.push(o));
  const openGate = () => {
    if (gateOpen) return;
    gateOpen = true;
    for (const o of gated.splice(0)) sendNow(o);
  };

  let lastAudioAt = Date.now();
  let conversation = null;
  // Self-interruption watch: an interrupt landing while JARVIS is still talking is
  // almost always his own voice coming back through the microphone.
  let speakingUntil = 0;
  let selfCuts = 0;

  const pushJobs = () => toPhone({ type: 'jarvis.jobs', jobs: registry.allJobs().slice(-30).reverse().map(jobView) });
  const pushSessions = () => toPhone({ type: 'jarvis.sessions', sessions: sessions.listConversations(30) });
  const pushCurrent = () =>
    toPhone({ type: 'jarvis.session', session: conversation ? { id: conversation.id, name: conversation.name, lines: conversation.lines } : null });

  // The recap can only go out once both the link and the chosen session exist,
  // and the two arrive in either order.
  let upstreamReady = false, recapSent = false;
  const sendRecapOnce = () => {
    if (!upstreamReady || recapSent || !conversation) return;
    const recap = sessions.recapFor(conversation.id);
    recapSent = true;
    if (!recap) { openGate(); return; }
    console.log(`[session] handed back ${conversation.lines.length} lines of history`);
    sendNow({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text',
        text: `[SESSION RECAP — what was said earlier in this session "${conversation.name}". Do not read it back; just continue naturally.]\n${recap}` }] },
    });
    openGate();
  };

  const record = (who, text) => {
    if (!conversation || !text?.trim()) return;
    sessions.appendLine(conversation.id, who, text);
    conversation = sessions.getConversation(conversation.id) || conversation;
  };

  // The model rejects overlapping responses, so a request made while one is in flight waits
  // for it. One response answers everything added before it, so a follow-up only goes out
  // when something new has arrived since; otherwise JARVIS repeats himself.
  let responseActive = false;
  let awaitingCreated = false;
  let wantResponse = false;
  let unanswered = 0;
  const addItem = (item) => {
    toModel({ type: 'conversation.item.create', item });
    unanswered++;
  };
  const requestResponse = () => {
    if (responseActive) { wantResponse = true; return; }
    responseActive = true;
    awaitingCreated = true;
    wantResponse = false;
    unanswered = 0;
    toModel({ type: 'response.create' });
  };

  // Barge-in: when the user talks over JARVIS the reply is cancelled, and what is still
  // streaming for it never reaches the phone.
  let userSpeaking = false;
  let cutting = false;

  // Each finished job is announced once. An announcement the user talks over is restated
  // after they have been answered.
  const announcements = new Map(); // job id -> { line, state: 'queued' | 'speaking' }
  const announced = new Set();
  const queueAnnouncement = (text) => {
    addItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    requestResponse();
  };
  const announcementsCut = () => {
    const cut = [...announcements].filter(([, a]) => a.state === 'speaking');
    if (!cut.length) return;
    for (const [, a] of cut) a.state = 'queued';
    addItem({ type: 'message', role: 'user', content: [{ type: 'input_text',
      text: `[SYSTEM EVENT — the user spoke over you while you were reporting ${cut.map(([id]) => `job ${id}`).join(' and ')}. Answer what they say first, then briefly restate the result] ${cut.map(([, a]) => a.line).join(' ')}` }] });
    // Normally the user's own turn triggers the next reply; if it was only noise, restate anyway.
    setTimeout(() => {
      if ([...announcements.values()].some((a) => a.state === 'queued') && !responseActive && !userSpeaking) requestResponse();
    }, 6000);
  };

  const responseStarted = () => {
    responseActive = true;
    cutting = false;
    // A reply the server started on its own (end of the user's turn) also covers what came before.
    if (awaitingCreated) awaitingCreated = false;
    else unanswered = 0;
    for (const a of announcements.values()) if (a.state === 'queued') a.state = 'speaking';
  };
  const responseFinished = (res) => {
    const wasCut = cutting || res?.status === 'cancelled';
    responseActive = false;
    cutting = false;
    if (wasCut) announcementsCut();
    else {
      for (const [id, a] of announcements) if (a.state === 'speaking') { announcements.delete(id); announced.add(id); }
    }
    if (wantResponse && unanswered > 0 && !userSpeaking) setTimeout(requestResponse, 50);
    else if (!userSpeaking) wantResponse = false;
  };

  upstream.on('open', () => {
    sendNow({ type: 'session.update', session: sessionConfig() });
    for (const m of pending.splice(0)) upstream.send(m);

    pushCurrent();
    pushSessions();
    pushJobs();
  });

  // Job events are spoken unprompted: the phone hears about completions without asking.
  const onJob = (ev) => {
    pushJobs();
    if (ev.type !== 'finished') return;
    const { job } = ev;
    // A job replaced by a correction is not news; its replacement reports instead.
    if (job.replacedBy || announced.has(job.id) || announcements.has(job.id)) return;
    const line = registry.describeJob(job, { verbose: true });
    announcements.set(job.id, { line, state: 'queued' });
    queueAnnouncement(`[SYSTEM EVENT — announce this to the user in one short sentence, in your own words, then stop] ${line}`);
  };
  bus.on('job', onJob);

  upstream.on('message', async (raw) => {
    let e = JSON.parse(raw.toString());
    if (OPENAI) {
      if (LEGACY_EVENTS[e.type]) e.type = LEGACY_EVENTS[e.type];
      // OpenAI's tool call is complete, name included, on output_item.done; reshape it into
      // the event the tool path below already handles, and drop the nameless one.
      if (e.type === 'response.function_call_arguments.done') return;
      if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
        e = { type: 'response.function_call_arguments.done', name: e.item.name, call_id: e.item.call_id, arguments: e.item.arguments };
      }
    }

    if (e.type === 'response.function_call_arguments.done') {
      let args = {};
      try { args = JSON.parse(e.arguments || '{}'); } catch {}
      console.log(`[tool] ${e.name}`, args);
      toPhone({ type: 'jarvis.tool', name: e.name, args });

      const result = await callTool(e.name, args, { conversationId: conversation?.id });
      record('tool', `${e.name}: ${result.say}`);
      console.log(`[tool] -> ${result.say}`);
      toPhone({ type: 'jarvis.tool_result', name: e.name, result });

      addItem({ type: 'function_call_output', call_id: e.call_id, output: JSON.stringify(result) });
      requestResponse();
      return;
    }

    // What was still streaming for a reply the user talked over.
    if (cutting && /^response\.(audio|audio_transcript|text)\.delta$/.test(e.type)) return;

    if (e.type === 'response.audio.delta' && e.delta) {
      const ms = (Buffer.from(e.delta, 'base64').length / 48000) * 1000; // 24 kHz PCM16
      speakingUntil = Math.max(speakingUntil, Date.now()) + ms;
    }
    if (e.type === 'input_audio_buffer.speech_started') {
      userSpeaking = true;
      const overlap = speakingUntil - Date.now();
      if (overlap > 0) {
        selfCuts++;
        console.log(`[vad] interrupt while speaking — ${Math.round(overlap)}ms of audio left (self-cut #${selfCuts})`);
      }
      // The phone has already dropped its queued audio; stop the model producing more.
      if (responseActive && !cutting) {
        cutting = true;
        speakingUntil = 0;
        toModel({ type: 'response.cancel' });
        console.log('[vad] user spoke over the reply — cancelled it');
      }
    }
    if (e.type === 'input_audio_buffer.speech_stopped') userSpeaking = false;
    if (e.type === 'session.updated') {
      upstreamReady = true;
      sendRecapOnce();
      setTimeout(openGate, 1500); // no session chosen: stop gating
    }
    if (e.type === 'error') console.error('[upstream error]', JSON.stringify(e.error).slice(0, 300));
    if (e.type === 'conversation.item.created' && process.env.JARVIS_DEBUG) {
      console.log('[item]', e.item?.role, JSON.stringify(e.item?.content)?.slice(0, 100));
    }
    if (e.type === 'response.created') responseStarted();
    if (e.type === 'conversation.item.input_audio_transcription.completed') record('you', e.transcript);
    if (e.type === 'response.audio_transcript.done') record('jarvis', cutting && e.transcript ? `${e.transcript} [cut off]` : e.transcript);
    if (e.type === 'response.done') responseFinished(e.response);

    // Everything else streams to the phone untouched (audio, transcripts, state).
    toPhone(e);
  });

  upstream.on('unexpected-response', (_q, res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      console.error('[rt] upstream HTTP', res.statusCode, body.slice(0, 300));
      toPhone({ type: 'error', error: { message: `upstream ${res.statusCode}` } });
      client.close();
    });
  });
  upstream.on('error', (err) => {
    console.error('[rt] upstream error', err.message);
    toPhone({ type: 'error', error: { message: err.message } });
    client.close();
  });
  upstream.on('close', () => client.close());

  client.on('message', (raw) => {
    let e;
    try { e = JSON.parse(raw.toString()); } catch { return; }
    if (e.type === 'jarvis.session.start') {
      // Open a named session: an existing one is resumed, otherwise a new one begins.
      conversation = (e.id && sessions.getConversation(e.id)) || sessions.createConversation(e.name);
      console.log(`[session] ${e.id ? 'resumed' : 'started'} "${conversation.name}" (${conversation.id})`);
      sendRecapOnce();
      pushCurrent();
      pushSessions();
      return;
    }
    if (e.type === 'jarvis.session.list') { pushSessions(); return; }
    if (e.type === 'jarvis.session.open') {
      const conv = sessions.getConversation(e.id);
      if (conv) toPhone({ type: 'jarvis.session.detail', session: conv });
      return;
    }
    if (e.type === 'jarvis.session.rename') { sessions.renameConversation(e.id, e.name); pushSessions(); return; }
    if (e.type === 'jarvis.session.delete') { sessions.deleteConversation(e.id); pushSessions(); return; }
    if (e.type === 'jarvis.jobs.refresh') { pushJobs(); return; }
    if (e.type === 'jarvis.voice') {
      // The phone's voice list is Qwen's; OpenAI ignores names it doesn't have.
      if (!OPENAI || OPENAI_VOICES.has(e.voice)) toModel({ type: 'session.update', session: voiceUpdate(e.voice) });
      return;
    }
    if (e.type === 'jarvis.vad') { toModel({ type: 'session.update', session: vadUpdate(e.enabled ? TURN_DETECTION : null) }); return; }
    if (e.type === 'input_audio_buffer.append') {
      lastAudioAt = Date.now();
      if (OPENAI && e.audio) e.audio = upsample16to24(e.audio);
    }
    // Typed turns count as conversation too; system injections do not.
    if (e.type === 'conversation.item.create' && e.item?.role === 'user') {
      const text = e.item.content?.find((c) => c.type === 'input_text')?.text || '';
      if (text && !text.startsWith('[SYSTEM EVENT') && !text.startsWith('[SESSION RECAP')) record('you', text);
    }
    if (e.type === 'input_audio_buffer.commit' || e.type === 'conversation.item.create') unanswered++;
    if (e.type === 'response.create') { requestResponse(); return; }
    if (CLIENT_ALLOWED.has(e.type)) toModel(e);
  });

  // Silence keepalive: the upstream closes a session idle for 180s, which would drop
  // the link exactly while a long job is running.
  const silence = Buffer.alloc((OPENAI ? 24000 : 16000) * 2 * 0.2).toString('base64'); // 200 ms of PCM16, sent as-is
  const keepalive = setInterval(() => {
    if (Date.now() - lastAudioAt > 25_000) toModel({ type: 'input_audio_buffer.append', audio: silence });
  }, 20_000);

  client.on('close', () => {
    console.log('[rt] phone disconnected');
    clearInterval(keepalive);
    bus.off('job', onJob);
    upstream.close();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`JARVIS host listening on :${PORT}`);
  console.log(`Voice model: ${PROVIDER} ${UPSTREAM.split('model=')[1]}  ·  voice: ${VOICE}`);
});
