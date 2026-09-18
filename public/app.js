const OUTPUT_RATE = 24000; // Qwen realtime returns 24 kHz PCM16
const INPUT_RATE = 16000;

const els = {
  orb: document.getElementById('orb'),
  ring: document.getElementById('ring'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  engage: document.getElementById('engage'),
  hangup: document.getElementById('hangup'),
  mute: document.getElementById('mute'),
  voice: document.getElementById('voice'),
  boot: document.getElementById('boot'),
  hud: document.getElementById('hud'),
};

let ws, micCtx, playCtx, micStream, node, muted = false;
let playHead = 0;
let sources = [];
let speaking = false;
let userTurn = null;
let assistantTurn = null;

let frames = 0, peakSeen = 0;
function diag(t) {
  const el = document.getElementById('diag');
  if (el) el.textContent = t;
}

function setStatus(t, cls = '') {
  els.status.textContent = t;
  els.status.className = 'status ' + cls;
}

function logLine(who, text) {
  const div = document.createElement('div');
  div.className = 'line ' + who;
  div.innerHTML = `<span class="who">${who === 'you' ? 'YOU' : 'JARVIS'}</span><span class="txt"></span>`;
  div.querySelector('.txt').textContent = text;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
  return div.querySelector('.txt');
}

async function engage() {
  els.engage.disabled = true;
  setStatus('requesting microphone…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (e) {
    setStatus('microphone denied: ' + e.message, 'bad');
    els.engage.disabled = false;
    return;
  }

  playCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
  await playCtx.resume();
  micCtx = new AudioContext();
  await micCtx.resume();
  await micCtx.audioWorklet.addModule('capture-worklet.js');
  node = new AudioWorkletNode(micCtx, 'capture-processor', { processorOptions: { targetRate: INPUT_RATE } });
  micCtx.createMediaStreamSource(micStream).connect(node);
  // Chrome only pulls a worklet that reaches the destination — route through a silent gain.
  const sink = micCtx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(micCtx.destination);
  diag(`mic ctx ${micCtx.sampleRate}Hz · state ${micCtx.state}`);

  setStatus('linking…');
  connect();
}

function connect() {
  ws = new WebSocket(`wss://${location.host}/rt`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'jarvis.voice', voice: els.voice.value }));
    node.port.onmessage = (e) => {
      const { pcm, level } = e.data;
      els.ring.style.setProperty('--mic', Math.min(1, level * 6).toFixed(3));
      peakSeen = Math.max(peakSeen, level);
      if (ws.readyState === WebSocket.OPEN && !muted) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64(pcm) }));
        frames++;
      }
      if (frames % 8 === 0) {
        const db = peakSeen > 0 ? (20 * Math.log10(peakSeen)).toFixed(0) : '-inf';
        diag(`mic ${db} dB · ${frames} frames sent${muted ? ' · MUTED' : ''}`);
        peakSeen *= 0.6;
      }
    };
    document.body.classList.add('live');
    els.boot.classList.add('hidden');
    els.hud.classList.remove('hidden');
    setStatus('online — speak, sir', 'ok');
    greet();
  };

  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
  ws.onclose = () => { setStatus('link closed', 'bad'); document.body.classList.remove('live'); };
  ws.onerror = () => setStatus('link error', 'bad');
}

function greet() {
  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Greet me in one short line, JARVIS. Do not use any tools.' }] },
  }));
  ws.send(JSON.stringify({ type: 'response.create' }));
}

function handleEvent(e) {
  switch (e.type) {
    case 'input_audio_buffer.speech_started':
      setStatus('listening…', 'ok');
      stopPlayback(); // barge-in
      break;
    case 'input_audio_buffer.speech_stopped':
      setStatus('thinking…');
      break;
    case 'conversation.item.input_audio_transcription.completed':
      if (e.transcript?.trim()) logLine('you', e.transcript.trim());
      userTurn = null;
      break;
    case 'response.created':
      assistantTurn = null;
      break;
    case 'response.audio.delta':
      speak(e.delta);
      break;
    case 'response.audio_transcript.delta':
      if (!assistantTurn) assistantTurn = logLine('jarvis', '');
      assistantTurn.textContent += e.delta;
      els.log.scrollTop = els.log.scrollHeight;
      break;
    case 'response.done':
      assistantTurn = null;
      setStatus('online — speak, sir', 'ok');
      break;
    case 'jarvis.tool':
      logLine('jarvis', `[${e.name}${e.args?.project ? ' · ' + e.args.project : ''}]`).parentElement.classList.add('tool');
      break;
    case 'jarvis.tool_result':
      diag(`${e.name}: ${e.result?.ok ? 'ok' : 'refused'}`);
      break;
    case 'error':
      console.warn(e.error);
      setStatus('error: ' + (e.error?.message || 'unknown'), 'bad');
      break;
  }
}

function speak(b64audio) {
  const bytes = Uint8Array.from(atob(b64audio), (c) => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer);
  const buf = playCtx.createBuffer(1, pcm.length, OUTPUT_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;

  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (playHead < now + 0.05) playHead = now + 0.05;
  src.start(playHead);
  playHead += buf.duration;
  sources.push(src);
  src.onended = () => {
    sources = sources.filter((s) => s !== src);
    if (!sources.length) setSpeaking(false);
  };
  setSpeaking(true);
}

function setSpeaking(v) {
  if (speaking === v) return;
  speaking = v;
  document.body.classList.toggle('speaking', v);
}

function stopPlayback() {
  for (const s of sources) { try { s.stop(); } catch {} }
  sources = [];
  playHead = 0;
  setSpeaking(false);
}

function b64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

els.engage.onclick = engage;
els.mute.onclick = () => {
  muted = !muted;
  node?.port.postMessage({ type: 'mute', value: muted });
  els.mute.textContent = muted ? 'UNMUTE' : 'MUTE';
  els.mute.classList.toggle('on', muted);
};
els.hangup.onclick = () => {
  stopPlayback();
  ws?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  micCtx?.close(); playCtx?.close();
  els.hud.classList.add('hidden');
  els.boot.classList.remove('hidden');
  els.engage.disabled = false;
  setStatus('offline');
};
// Push-to-talk: disables server VAD and commits the buffer on release.
const ptt = document.getElementById('ptt');
let pttMode = false;
const pttDown = (ev) => {
  ev.preventDefault();
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (!pttMode) {
    pttMode = true;
    ws.send(JSON.stringify({ type: 'jarvis.vad', enabled: false }));
  }
  stopPlayback();
  ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
  ptt.classList.add('on');
  setStatus('listening (hold)…', 'ok');
};
const pttUp = (ev) => {
  ev.preventDefault();
  if (!pttMode || ws?.readyState !== WebSocket.OPEN) return;
  ptt.classList.remove('on');
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  ws.send(JSON.stringify({ type: 'response.create' }));
  setStatus('thinking…');
};
ptt.addEventListener('pointerdown', pttDown);
ptt.addEventListener('pointerup', pttUp);
ptt.addEventListener('pointercancel', pttUp);
ptt.addEventListener('pointerleave', (e) => { if (ptt.classList.contains('on')) pttUp(e); });

els.voice.onchange = () => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'jarvis.voice', voice: els.voice.value }));
  }
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
