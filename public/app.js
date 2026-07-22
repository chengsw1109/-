'use strict';

/* browser-ptt client
 * ------------------
 * Flow: login -> POST /api/login -> open WS(/ws?token=) -> join a channel.
 * PTT: press -> {talk_start}. On {talk_granted} start MediaRecorder and stream
 * Opus/WebM chunks as binary WS frames. Release -> stop recorder + {talk_stop}.
 * Receiving: on {speaking} spin up a MediaSource player and append incoming
 * binary frames; on {speaking_end} end the stream.
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: null,
  me: null,
  channels: [],
  channel: null,
  ws: null,
  micStream: null,
  recorder: null,
  hasFloor: false,
  player: null,
};

// ---- Audio capability detection ------------------------------------------
const MIME = pickMime();
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || null;
}
// MediaSource with opus is what the receiver needs for continuous playback.
const CAN_PLAY = typeof MediaSource !== 'undefined' &&
  MediaSource.isTypeSupported?.('audio/webm;codecs=opus');

// ---- Login ----------------------------------------------------------------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#username').value.trim(),
        password: $('#password').value,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'login failed');
    const data = await res.json();
    state.token = data.token;
    state.me = data.user;
    state.channels = data.channels;
    enterApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me').textContent = state.me.username;

  const sel = $('#channel-select');
  sel.innerHTML = '';
  for (const ch of state.channels) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = ch.name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => joinChannel(sel.value));

  if (!MIME) setHint('⚠️ This browser cannot capture audio (no MediaRecorder). You can still listen where supported.');
  else if (!CAN_PLAY) setHint('⚠️ Playback of live audio is limited in this browser (e.g. iOS Safari). Transmit works; receiving may not.');

  connectWs();
}

$('#logout').addEventListener('click', () => location.reload());

// ---- WebSocket ------------------------------------------------------------
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => joinChannel($('#channel-select').value);
  ws.onclose = () => setStatus('idle', 'Disconnected');
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      // binary audio frame from the current speaker
      state.player?.push(ev.data);
      return;
    }
    handleSignal(JSON.parse(ev.data));
  };
}

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function joinChannel(channelId) {
  if (!channelId) return;
  state.channel = channelId;
  stopPlayback();
  send({ type: 'join', channel: channelId });
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'joined':
      renderPresence(msg.members, msg.speaking);
      if (msg.speaking && msg.speaking !== state.me.username) startPlayback(msg.speaking);
      else setStatus('idle', 'Idle');
      break;
    case 'presence':
      renderPresence(msg.members);
      break;
    case 'talk_granted':
      beginTransmit();
      break;
    case 'talk_denied':
      setStatus('idle', `📢 ${msg.by} is talking`);
      endTransmit(); // ensure local button state resets
      break;
    case 'speaking':
      startPlayback(msg.user);
      break;
    case 'speaking_end':
      stopPlayback();
      setStatus('idle', 'Idle');
      break;
    case 'error':
      setHint('⚠️ ' + msg.message);
      break;
  }
}

// ---- Presence / who is talking -------------------------------------------
let currentSpeaker = null;
function renderPresence(members, speaking = currentSpeaker) {
  currentSpeaker = speaking;
  $('#online-count').textContent = members.length;
  const ul = $('#online-list');
  ul.innerHTML = '';
  for (const name of members) {
    const li = document.createElement('li');
    if (name === speaking) li.classList.add('talking');
    li.innerHTML = `<span>👤 ${escapeHtml(name)}${name === state.me.username ? ' (you)' : ''}</span><span class="mic">🎙️</span>`;
    ul.appendChild(li);
  }
}

// ---- PTT button -----------------------------------------------------------
const pttBtn = $('#ptt');
if (MIME) pttBtn.disabled = false;

const pressStart = (e) => { e.preventDefault(); requestTalk(); };
const pressEnd = (e) => { e.preventDefault(); endTalk(); };
pttBtn.addEventListener('mousedown', pressStart);
pttBtn.addEventListener('touchstart', pressStart, { passive: false });
window.addEventListener('mouseup', pressEnd);
pttBtn.addEventListener('touchend', pressEnd, { passive: false });
pttBtn.addEventListener('touchcancel', pressEnd);
// Spacebar as PTT on desktop
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); requestTalk(); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { e.preventDefault(); endTalk(); } });

function requestTalk() {
  if (state.hasFloor || !MIME) return;
  send({ type: 'talk_start' }); // server replies talk_granted / talk_denied
}

function endTalk() {
  if (!state.hasFloor) return;
  endTransmit();
  send({ type: 'talk_stop' });
}

async function beginTransmit() {
  try {
    if (!state.micStream) {
      state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    state.hasFloor = true;
    pttBtn.classList.add('active');
    setStatus('speaking', '🔴 You are talking');

    const rec = new MediaRecorder(state.micStream, { mimeType: MIME });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0 && state.ws?.readyState === WebSocket.OPEN) state.ws.send(e.data);
    };
    rec.start(200); // emit a chunk every 200ms for low latency
    state.recorder = rec;
  } catch (ex) {
    setHint('⚠️ Microphone access denied: ' + ex.message);
    send({ type: 'talk_stop' });
  }
}

function endTransmit() {
  state.hasFloor = false;
  pttBtn.classList.remove('active');
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  state.recorder = null;
  setStatus('idle', 'Idle');
}

// ---- Playback (MediaSource) -----------------------------------------------
function startPlayback(speaker) {
  setStatus('receiving', `🔊 ${speaker} is talking`);
  if (!CAN_PLAY) return;
  stopPlayback();
  state.player = new StreamPlayer();
  state.player.start();
}

function stopPlayback() {
  if (state.player) {
    state.player.end();
    state.player = null;
  }
}

class StreamPlayer {
  start() {
    this.queue = [];
    this.sb = null;
    this.ended = false;
    this.ms = new MediaSource();
    this.audio = new Audio();
    this.audio.src = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => {
      try {
        this.sb = this.ms.addSourceBuffer('audio/webm;codecs=opus');
        this.sb.mode = 'sequence';
        this.sb.addEventListener('updateend', () => this._flush());
        this._flush();
      } catch (e) { /* unsupported */ }
    });
    this.audio.play().catch(() => {/* autoplay may require a gesture */});
  }
  push(chunk) { this.queue.push(chunk); this._flush(); }
  _flush() {
    if (!this.sb || this.sb.updating) return;
    if (this.queue.length) {
      try { this.sb.appendBuffer(this.queue.shift()); } catch (e) {/* quota */}
    } else if (this.ended && this.ms.readyState === 'open') {
      try { this.ms.endOfStream(); } catch (e) {}
    }
  }
  end() {
    this.ended = true;
    try { this._flush(); } catch (e) {}
  }
}

// ---- Small helpers --------------------------------------------------------
function setStatus(kind, text) {
  const dot = $('#status-dot');
  dot.className = 'dot ' + kind;
  $('#status-text').textContent = text;
}
function setHint(text) { $('#hint').textContent = text; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
