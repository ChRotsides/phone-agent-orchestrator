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
const API_KEY = process.env.QWEN_API_KEY;
const UPSTREAM = process.env.QWEN_REALTIME_URL;
const VOICE = process.env.JARVIS_VOICE || 'daniel';

if (!API_KEY || !UPSTREAM) {
  console.error('Missing QWEN_API_KEY or QWEN_REALTIME_URL in .env');
  process.exit(1);
}

const INSTRUCTIONS = `You are JARVIS, the user's personal AI assistant, reachable by phone.
Voice: dry British wit, calm precision, complete confidence. Call the user "sir" occasionally, never every sentence.
Keep spoken replies to one or two sentences unless asked to elaborate. Never read out logs, code or file paths verbatim — describe them.

You command a fleet of coding agents on the user's PC. When the user asks for work to be DONE, call dispatch_task immediately;
do not ask which model to use — that is chosen for you — but honour it if the user names one.
When the user asks what is happening, call check_status and report it naturally.
When the user says to merge, ship or land work, call merge_job.
When the user asks to clear, reset or restart a project's session, call clear_session.
If a tool returns a question, ask the user that question in your own words.
Answer general questions yourself without tools. Always reply in the language the user speaks.`;

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

  // The model rejects overlapping responses, so requests queue behind the one in flight.
  let responseActive = false;
  const queued = [];
  const requestResponse = () => {
    if (responseActive) { queued.push(1); return; }
    responseActive = true;
    toModel({ type: 'response.create' });
  };
  const responseFinished = () => {
    responseActive = false;
    if (queued.length) { queued.pop(); setTimeout(requestResponse, 50); }
  };

  upstream.on('open', () => {
    sendNow({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: INSTRUCTIONS,
        voice: VOICE,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'fun-asr' },
        turn_detection: { type: 'server_vad', threshold: 0.3, silence_duration_ms: 700 },
        tools: toolSchemas,
        tool_choice: 'auto',
      },
    });
    for (const m of pending.splice(0)) upstream.send(m);

    pushCurrent();
    pushSessions();
    pushJobs();
  });

  // Job events are spoken unprompted: the phone hears about completions without asking.
  const onJob = (ev) => {
    pushJobs();
    if (ev.type !== 'finished') return;
    const line = registry.describeJob(ev.job, { verbose: true });
    toModel({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text',
        text: `[SYSTEM EVENT — announce this to the user in one short sentence, in your own words, then stop] ${line}` }] },
    });
    requestResponse();
  };
  bus.on('job', onJob);

  upstream.on('message', async (raw) => {
    const e = JSON.parse(raw.toString());

    if (e.type === 'response.function_call_arguments.done') {
      let args = {};
      try { args = JSON.parse(e.arguments || '{}'); } catch {}
      console.log(`[tool] ${e.name}`, args);
      toPhone({ type: 'jarvis.tool', name: e.name, args });

      const result = await callTool(e.name, args, { conversationId: conversation?.id });
      record('tool', `${e.name}: ${result.say}`);
      console.log(`[tool] -> ${result.say}`);
      toPhone({ type: 'jarvis.tool_result', name: e.name, result });

      toModel({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: e.call_id, output: JSON.stringify(result) },
      });
      requestResponse();
      return;
    }

    if (e.type === 'session.updated') {
      upstreamReady = true;
      sendRecapOnce();
      setTimeout(openGate, 1500); // no session chosen: stop gating
    }
    if (e.type === 'error') console.error('[upstream error]', JSON.stringify(e.error).slice(0, 300));
    if (e.type === 'conversation.item.created' && process.env.JARVIS_DEBUG) {
      console.log('[item]', e.item?.role, JSON.stringify(e.item?.content)?.slice(0, 100));
    }
    if (e.type === 'response.created') responseActive = true;
    if (e.type === 'response.done') responseFinished();
    if (e.type === 'conversation.item.input_audio_transcription.completed') record('you', e.transcript);
    if (e.type === 'response.audio_transcript.done') record('jarvis', e.transcript);

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
    if (e.type === 'jarvis.voice') { toModel({ type: 'session.update', session: { voice: e.voice } }); return; }
    if (e.type === 'jarvis.vad') { toModel({ type: 'session.update', session: { turn_detection: e.enabled ? { type: 'server_vad', threshold: 0.3, silence_duration_ms: 700 } : null } }); return; }
    if (e.type === 'input_audio_buffer.append') lastAudioAt = Date.now();
    // Typed turns count as conversation too; system injections do not.
    if (e.type === 'conversation.item.create' && e.item?.role === 'user') {
      const text = e.item.content?.find((c) => c.type === 'input_text')?.text || '';
      if (text && !text.startsWith('[SYSTEM EVENT') && !text.startsWith('[SESSION RECAP')) record('you', text);
    }
    if (e.type === 'response.create') { requestResponse(); return; }
    if (CLIENT_ALLOWED.has(e.type)) toModel(e);
  });

  // Silence keepalive: the upstream closes a session idle for 180s, which would drop
  // the link exactly while a long job is running.
  const silence = Buffer.alloc(16000 * 2 * 0.2).toString('base64'); // 200 ms of 16 kHz PCM16
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
  console.log(`Voice model: ${UPSTREAM.split('model=')[1]}  ·  voice: ${VOICE}`);
});
