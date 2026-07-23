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
  // 'lan' = 內網: no STUN/TURN, host candidates only → zero external traffic,
  // never touches the TURN quota. 'wan' = 外網: use the server's STUN + TURN.
  netMode: localStorage.getItem('ptt-net-mode') || 'lan',
  localStream: null,
  selfPeerId: null,
  peers: new Map(), // peerId -> { pc, audioEl, pendingIce:[], haveRemote:bool, username }
  hasFloor: false,
  currentSpeaker: null,
};

// ICE config actually used for peer connections, per the selected mode.
function activeIceServers() {
  return state.netMode === 'lan' ? [] : state.iceServers;
}

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

  const modeSel = $('#net-mode');
  modeSel.value = state.netMode;
  modeSel.addEventListener('change', () => {
    state.netMode = modeSel.value;
    localStorage.setItem('ptt-net-mode', state.netMode);
    setHint(state.netMode === 'lan' ? '已切換為內網（區網直連，不使用 TURN）' : '已切換為外網（需要時用 TURN）');
    // Rebuild peer connections so the new ICE setting takes effect.
    if (state.channel) { teardownPeers(); send({ type: 'join', channel: state.channel }); }
  });

  if (!CAN_WEBRTC) {
    setHint('⚠️ 此瀏覽器不支援 WebRTC,無法語音。');
  } else {
    $('#ptt').disabled = false; // enabled even before mic — the press acquires it (iOS)
    if (!location.protocol.startsWith('https') && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      setHint('⚠️ 麥克風需要 HTTPS(或 localhost)。實機請以 HTTPS 提供服務。');
    }
    await ensureMic(); // desktop fast path; iOS falls back to the PTT-press gesture
  }
  connectWs();
}

$('#logout').addEventListener('click', () => location.reload());
$('#enable-audio').addEventListener('click', () => {
  for (const { audioEl } of state.peers.values()) audioEl?.play?.().catch(() => {});
  $('#enable-audio').hidden = true;
});

// Returns true if a mic track is available. On iOS Safari getUserMedia must run
// inside a user gesture, so this may fail at login and succeed later on a PTT
// press — see requestTalk().
async function ensureMic() {
  if (state.localStream) return true;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // muted until we hold the floor
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    return true;
  } catch (ex) {
    state.localStream = null; // listen-only for now
    setHint('⚠️ 尚未取得麥克風(' + ex.name + '):按住「說話」鍵即可允許並啟用。');
    return false;
  }
}

// ---- WebSocket signalling (with auto-reconnect) ---------------------------
const seenChat = new Set(); // chat message ids already rendered (de-dup)
let reconnectTimer = null;
let reconnectDelay = 1000; // backoff, reset on a successful open

function connectWs() {
  clearTimeout(reconnectTimer);
  // Close any previous socket so we never end up with two live connections
  // (which would deliver every broadcast — chat included — more than once).
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.onmessage = null; state.ws.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onopen = () => {
    reconnectDelay = 1000;
    setHint('');
    // Rejoin the current channel and rebuild peer connections (they died with
    // the old socket). Keep the chat log — don't clear it on a reconnect.
    const ch = $('#channel-select').value;
    state.channel = ch;
    teardownPeers();
    send({ type: 'join', channel: ch });
  };
  ws.onclose = (ev) => {
    if (ev.code === 4001) { setStatus('idle', '已斷線'); setHint('⚠️ 連線授權失效,請重新登入。'); return; }
    scheduleReconnect();
  };
  ws.onmessage = (ev) => handleSignal(JSON.parse(ev.data));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  setStatus('idle', `已斷線,${Math.round(reconnectDelay / 1000)} 秒後自動重連…`);
  reconnectTimer = setTimeout(() => {
    setStatus('idle', '重新連線中…');
    connectWs();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000); // cap at 15s
}

// Reconnect immediately when the network returns or the tab/phone wakes,
// instead of waiting out the backoff timer.
function maybeReconnect() {
  if (!state.token) return; // not logged in yet
  const rs = state.ws?.readyState;
  if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
  reconnectDelay = 1000;
  connectWs();
}
window.addEventListener('online', maybeReconnect);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybeReconnect();
});

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function joinChannel(channelId) {
  if (!channelId) return;
  state.channel = channelId;
  teardownPeers();
  $('#chat-log').innerHTML = ''; // chat is per-channel
  seenChat.clear();
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
    case 'chat':
      if (msg.id) {
        if (seenChat.has(msg.id)) break; // ignore duplicate delivery
        seenChat.add(msg.id);
      }
      renderChat(msg.user, msg.text, msg.ts);
      break;
    case 'error':
      setHint('⚠️ ' + msg.message);
      break;
  }
}

// ---- WebRTC mesh ----------------------------------------------------------
function createPeer(peerId, username) {
  const pc = new RTCPeerConnection({ iceServers: activeIceServers() });
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
    const s = pc.connectionState;
    // Media is P2P; make a failed path visible instead of silently muted.
    if (s === 'connected') { if ($('#hint').textContent.includes('語音')) setHint(''); }
    else if (s === 'failed') {
      setHint(state.netMode === 'lan'
        ? '⚠️ 語音無法連線。若對方不在同一區網,請把「連線模式」切成「外網」。'
        : '⚠️ 語音無法連線,對方網路可能需要 TURN 中繼伺服器(見說明)。');
    }
    if (s === 'failed' || s === 'closed') removePeer(peerId);
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

async function requestTalk() {
  if (state.hasFloor) return;
  if (!state.localStream) {
    // iOS Safari: this press is a user gesture, so getUserMedia can succeed now
    // even though it failed at login. Acquire, then rebuild the peer connections
    // so the mic track is negotiated into the SDP (adding a track to an already
    // negotiated connection would otherwise need a renegotiation the peer misses).
    const ok = await ensureMic();
    if (!ok) return;
    if (state.channel) { teardownPeers(); send({ type: 'join', channel: state.channel }); }
    setHint('🎤 麥克風已啟用,請再按一次「按住說話」即可開始。');
    return;
  }
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

// ---- Text chat (over WebSocket, works even when audio P2P fails) ----------
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  input.value = '';
});
$('#chat-quick').addEventListener('click', () => {
  send({ type: 'chat', text: '🔈 我聽不到聲音,請把「連線模式」切成「外網」。' });
});

function renderChat(user, text, ts) {
  const ul = $('#chat-log');
  const li = document.createElement('li');
  const mine = user === state.me.username;
  if (mine) li.classList.add('mine');
  const time = new Date(ts || Date.now()).toLocaleTimeString('zh-Hant', { hour: '2-digit', minute: '2-digit' });
  li.innerHTML = `<span class="chat-meta">${escapeHtml(user)} · ${time}</span><span class="chat-text">${escapeHtml(text)}</span>`;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
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
