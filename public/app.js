'use strict';

/* browser-ptt client (WebRTC mesh)
 * --------------------------------
 * Signalling + presence + floor control run over a WebSocket. Audio runs
 * peer-to-peer over WebRTC (works on iOS Safari, unlike MediaRecorder+MSE).
 *
 * Model: on joining a channel each member opens an RTCPeerConnection to every
 * other member (a mesh) and publishes its mic track — but keeps it MUTED
 * (track.enabled = false). PTT half-duplex is server-authoritative: on
 * `talk_granted` the floor holder unmutes its track; on release it mutes again.
 * No renegotiation happens on talk, so latency is just the RTP path (~0.2–1s).
 *
 * Mesh suits small channels. Large channels want an SFU (see CLAUDE.md).
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: null,
  me: null,
  channels: [],
  channel: null,
  ws: null,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  localStream: null,
  selfPeerId: null,
  peers: new Map(), // peerId -> { pc, audioEl, pendingIce:[], haveRemote:bool, username }
  hasFloor: false,
  currentSpeaker: null,
};

// ---- Capability check -----------------------------------------------------
const CAN_WEBRTC = typeof RTCPeerConnection !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia;

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
    if (!res.ok) throw new Error((await res.json()).error || '登入失敗');
    const data = await res.json();
    state.token = data.token;
    state.me = data.user;
    state.channels = data.channels;
    if (Array.isArray(data.iceServers) && data.iceServers.length) state.iceServers = data.iceServers;
    enterApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

async function enterApp() {
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

  if (!CAN_WEBRTC) {
    setHint('⚠️ 此瀏覽器不支援 WebRTC,無法語音。');
  } else {
    if (!location.protocol.startsWith('https') && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      setHint('⚠️ 麥克風需要 HTTPS(或 localhost)。實機請以 HTTPS 提供服務。');
    }
    await ensureMic(); // request mic up front so tracks are ready before peers connect
  }
  connectWs();
}

$('#logout').addEventListener('click', () => location.reload());
$('#enable-audio').addEventListener('click', () => {
  for (const { audioEl } of state.peers.values()) audioEl?.play?.().catch(() => {});
  $('#enable-audio').hidden = true;
});

async function ensureMic() {
  if (state.localStream) return state.localStream;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // muted until we hold the floor
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    $('#ptt').disabled = false;
  } catch (ex) {
    state.localStream = null; // listen-only mode
    setHint('⚠️ 無法使用麥克風(' + ex.name + '),你可以收聽但不能說話。');
  }
  return state.localStream;
}

// ---- WebSocket signalling -------------------------------------------------
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onopen = () => joinChannel($('#channel-select').value);
  ws.onclose = () => setStatus('idle', '已斷線');
  ws.onmessage = (ev) => handleSignal(JSON.parse(ev.data));
}

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function joinChannel(channelId) {
  if (!channelId) return;
  state.channel = channelId;
  teardownPeers();
  send({ type: 'join', channel: channelId });
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'joined':
      state.selfPeerId = msg.self.peerId;
      renderPresence(msg.members, msg.speaking);
      setStatus(msg.speaking ? 'receiving' : 'idle', msg.speaking ? `🔊 ${msg.speaking} 正在說話` : '待機');
      // Connect to everyone already here. Deterministic initiator avoids glare:
      // the peer with the greater id sends the offer.
      for (const p of msg.peers) connectToPeer(p.peerId, p.username, state.selfPeerId > p.peerId);
      break;
    case 'peer_joined':
      renderPresence(msg.members);
      connectToPeer(msg.peerId, msg.username, state.selfPeerId > msg.peerId);
      break;
    case 'peer_left':
      removePeer(msg.peerId);
      renderPresence(msg.members);
      break;
    case 'signal':
      onSignal(msg.from, msg.data);
      break;
    case 'talk_granted':
      setFloor(true);
      break;
    case 'talk_denied':
      setStatus('idle', `📢 ${msg.by} 正在說話`);
      break;
    case 'speaking':
      state.currentSpeaker = msg.user;
      renderPresence(null, msg.user);
      setStatus('receiving', `🔊 ${msg.user} 正在說話`);
      break;
    case 'speaking_end':
      state.currentSpeaker = null;
      renderPresence(null, null);
      setStatus('idle', '待機');
      break;
    case 'error':
      setHint('⚠️ ' + msg.message);
      break;
  }
}

// ---- WebRTC mesh ----------------------------------------------------------
function createPeer(peerId, username) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const entry = { pc, audioEl: null, pendingIce: [], haveRemote: false, username };
  state.peers.set(peerId, entry);

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  } else {
    // listen-only: still need an audio m-line to receive the remote track
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', to: peerId, data: { kind: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = (e) => attachAudio(peerId, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') removePeer(peerId);
  };
  return entry;
}

async function connectToPeer(peerId, username, initiator) {
  if (state.peers.has(peerId)) return;
  const { pc } = createPeer(peerId, username);
  if (initiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'signal', to: peerId, data: { kind: 'offer', sdp: pc.localDescription } });
    } catch (ex) {
      console.error('offer failed', ex);
    }
  }
}

async function onSignal(from, data) {
  let entry = state.peers.get(from);
  if (!entry) entry = createPeer(from);
  const { pc } = entry;
  try {
    if (data.kind === 'offer') {
      await pc.setRemoteDescription(data.sdp);
      entry.haveRemote = true;
      await drainIce(entry);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', to: from, data: { kind: 'answer', sdp: pc.localDescription } });
    } else if (data.kind === 'answer') {
      await pc.setRemoteDescription(data.sdp);
      entry.haveRemote = true;
      await drainIce(entry);
    } else if (data.kind === 'ice') {
      if (entry.haveRemote) await pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pendingIce.push(data.candidate);
    }
  } catch (ex) {
    console.error('signal handling failed', ex);
  }
}

async function drainIce(entry) {
  for (const c of entry.pendingIce) await entry.pc.addIceCandidate(c).catch(() => {});
  entry.pendingIce = [];
}

function attachAudio(peerId, stream) {
  const entry = state.peers.get(peerId);
  if (!entry) return;
  let el = entry.audioEl;
  if (!el) {
    el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true; // required for iOS
    $('#audio-sink').appendChild(el);
    entry.audioEl = el;
  }
  el.srcObject = stream;
  el.play().catch(() => { $('#enable-audio').hidden = false; }); // autoplay may need a tap
}

function removePeer(peerId) {
  const entry = state.peers.get(peerId);
  if (!entry) return;
  try { entry.pc.close(); } catch {}
  if (entry.audioEl) {
    entry.audioEl.srcObject = null;
    entry.audioEl.remove();
  }
  state.peers.delete(peerId);
}

function teardownPeers() {
  for (const id of [...state.peers.keys()]) removePeer(id);
}

// ---- Floor / mic toggle ---------------------------------------------------
function setFloor(on) {
  state.hasFloor = on;
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  $('#ptt').classList.toggle('active', on);
  setStatus(on ? 'speaking' : 'idle', on ? '🔴 你正在說話' : '待機');
}

// ---- PTT button -----------------------------------------------------------
const pttBtn = $('#ptt');
const pressStart = (e) => { e.preventDefault(); requestTalk(); };
const pressEnd = (e) => { e.preventDefault(); endTalk(); };
pttBtn.addEventListener('mousedown', pressStart);
pttBtn.addEventListener('touchstart', pressStart, { passive: false });
window.addEventListener('mouseup', pressEnd);
pttBtn.addEventListener('touchend', pressEnd, { passive: false });
pttBtn.addEventListener('touchcancel', pressEnd);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); requestTalk(); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { e.preventDefault(); endTalk(); } });

function requestTalk() {
  if (state.hasFloor || !state.localStream) return;
  send({ type: 'talk_start' }); // server replies talk_granted / talk_denied
}
function endTalk() {
  if (!state.hasFloor) return;
  setFloor(false);
  send({ type: 'talk_stop' });
}

// ---- Presence UI ----------------------------------------------------------
let lastMembers = [];
function renderPresence(members, speaking = state.currentSpeaker) {
  if (members) lastMembers = members;
  state.currentSpeaker = speaking;
  $('#online-count').textContent = lastMembers.length;
  const ul = $('#online-list');
  ul.innerHTML = '';
  for (const name of lastMembers) {
    const li = document.createElement('li');
    if (name === speaking) li.classList.add('talking');
    li.innerHTML = `<span>👤 ${escapeHtml(name)}${name === state.me.username ? '(你)' : ''}</span><span class="mic">🎙️</span>`;
    ul.appendChild(li);
  }
}

// ---- Helpers --------------------------------------------------------------
function setStatus(kind, text) {
  $('#status-dot').className = 'dot ' + kind;
  $('#status-text').textContent = text;
}
function setHint(text) { $('#hint').textContent = text; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
