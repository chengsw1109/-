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
  deviceId: getOrCreateDeviceId(),
};

// ICE config actually used for peer connections, per the selected mode.
function activeIceServers() {
  return state.netMode === 'lan' ? [] : state.iceServers;
}

function getOrCreateDeviceId() {
  const key = 'ptt-device-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = 'web-' + (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    localStorage.setItem(key, id);
  }
  return id;
}

function deviceFamily() {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  return 'Desktop';
}

function browserFamily() {
  const ua = navigator.userAgent;
  if (/CriOS/i.test(ua)) return 'Chrome iOS';
  if (/FxiOS/i.test(ua)) return 'Firefox iOS';
  if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) return 'Safari';
  if (/Edg/i.test(ua)) return 'Edge';
  if (/Chrome|Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox/i.test(ua)) return 'Firefox';
  return 'Other';
}

function reportDiagnostic(eventType, fields = {}) {
  send({
    type: 'diagnostic',
    eventType,
    networkMode: state.netMode,
    ...fields,
  });
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
    startSession(await res.json());
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// Adopt a login/session payload (token + user + channels + iceServers) and enter
// the app. The token is remembered so a reload lands straight on the usage
// screen (no re-typing) and the "re-login" button can reconnect without a form.
function startSession(data) {
  // Remove chat history written by older versions. Quick-message preferences
  // use a separate key and are intentionally preserved.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('ptt-chat-')) localStorage.removeItem(key);
  }
  state.token = data.token;
  state.me = data.user;
  state.channels = data.channels;
  if (Array.isArray(data.iceServers) && data.iceServers.length) state.iceServers = data.iceServers;
  if (data.token) localStorage.setItem('ptt-token', data.token);
  enterApp();
}

// On page load, if we still have a valid token, skip the login screen.
(async function restoreSession() {
  const token = localStorage.getItem('ptt-token');
  if (!token) return;
  $('#login').hidden = true; // don't flash the login form while we validate
  try {
    const res = await fetch('/api/session', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('session expired');
    startSession({ token, ...(await res.json()) });
  } catch {
    localStorage.removeItem('ptt-token');
    $('#login').hidden = false;
  }
})();

let appEntered = false;
async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me').textContent = state.me.username;
  if (appEntered) { connectWs(); return; } // already wired up — just (re)connect
  appEntered = true;

  const sel = $('#channel-select');
  sel.innerHTML = '';
  for (const ch of state.channels) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = ch.name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => joinChannel(sel.value));
  loadChannelChat(sel.value);

  const modeSel = $('#net-mode');
  modeSel.value = state.netMode;
  modeSel.addEventListener('change', () => {
    state.netMode = modeSel.value;
    localStorage.setItem('ptt-net-mode', state.netMode);
    reportDiagnostic('network_mode_changed', { reason: 'user selected mode' });
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

$('#logout').addEventListener('click', () => {
  localStorage.removeItem('ptt-token'); // full logout → login form next time
  location.reload();
});
$('#relogin').addEventListener('click', async () => {
  const token = state.token || localStorage.getItem('ptt-token');
  if (!token) { location.reload(); return; }
  setHint('重新連線中…');
  try {
    const res = await fetch('/api/session', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('expired');
    const data = await res.json();
    state.channels = data.channels;
    if (Array.isArray(data.iceServers) && data.iceServers.length) state.iceServers = data.iceServers;
    reconnectDelay = 1000;
    connectWs(); // reconnect + rejoin using the stored token, no password
    setHint('已重新連線');
  } catch {
    localStorage.removeItem('ptt-token');
    location.reload();
  }
});
$('#enable-audio').addEventListener('click', () => {
  resumeRemoteAudio();
});

// One-tap 外網 self-test: force relay-only against the delivered TURN servers
// and report whether we can obtain a relay address. Runs on the user's device
// (which can reach the TURN provider), so it diagnoses the real service.
$('#turn-test').addEventListener('click', runTurnTest);
async function runTurnTest() {
  const servers = state.iceServers || [];
  const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter(Boolean);
  if (!urls.some((u) => /^turns?:/i.test(u))) {
    setHint('❌ 伺服器沒有提供 TURN(啟動時未設定 TURN_CREDENTIALS_URL,見 docs/TURN.md)。');
    return;
  }
  setHint('🔍 外網 TURN 檢測中…(約 5 秒)');
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
    let relay = false;
    pc.onicecandidate = (e) => { if (e.candidate && / typ relay/.test(e.candidate.candidate)) relay = true; };
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 5000));
    setHint(relay
      ? '✅ 外網 TURN 正常(取得 relay 中繼位址)。若仍沒聲音,請確認雙方都切「外網」並重新整理。'
      : '❌ 外網 TURN 拿不到中繼位址 — TURN 帳密或服務有問題(見 docs/TURN.md)。');
    reportDiagnostic('turn_test', { relayAvailable: relay });
  } catch (ex) {
    setHint('❌ 檢測失敗:' + ex.message);
    reportDiagnostic('turn_test', {
      relayAvailable: false,
      errorName: ex.name,
      errorMessage: ex.message,
    });
  } finally {
    try { pc?.close(); } catch {}
  }
}

function liveMicTrack() {
  return state.localStream?.getAudioTracks().find((track) => track.readyState === 'live') || null;
}

function reportPlayError(ex) {
  console.error('remote audio play() failed', ex);
  $('#enable-audio').hidden = false;
  reportDiagnostic('audio_play_error', {
    errorName: ex.name,
    errorMessage: ex.message,
  });
}

async function resumeRemoteAudio() {
  const attempts = [];
  for (const { audioEl } of state.peers.values()) {
    if (audioEl?.srcObject) attempts.push(audioEl.play().catch(reportPlayError));
  }
  await Promise.all(attempts);
  const audioEls = [...state.peers.values()].map((entry) => entry.audioEl).filter(Boolean);
  if (audioEls.length && audioEls.every((audioEl) => !audioEl.paused)) {
    $('#enable-audio').hidden = true;
  }
}

// Returns true if a mic track is available. On iOS Safari getUserMedia must run
// inside a user gesture, so this may fail at login and succeed later on a PTT
// press — see requestTalk().
async function ensureMic() {
  if (liveMicTrack()) return true;
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of state.localStream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        reportDiagnostic('track_ended', { reason: 'microphone track ended' });
      }, { once: true });
    }
    // Keep the track enabled; half-duplex muting is done per sender via
    // replaceTrack() — reliable on iOS Safari, unlike toggling track.enabled
    // (which iOS may not resume, so the peer never hears you).
    return true;
  } catch (ex) {
    state.localStream = null; // listen-only for now
    setHint('⚠️ 尚未取得麥克風(' + ex.name + '):按住「說話」鍵即可允許並啟用。');
    reportDiagnostic('mic_error', {
      errorName: ex.name,
      errorMessage: ex.message,
      operation: 'getUserMedia',
    });
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
  ws.onopen = async () => {
    reconnectDelay = 1000;
    setHint('');
    ws.send(JSON.stringify({
      type: 'device_hello',
      deviceId: state.deviceId,
      deviceFamily: deviceFamily(),
      browserFamily: browserFamily(),
    }));
    // iPhones commonly reconnect after a network change or waking from sleep.
    // Refresh short-lived TURN credentials before creating new peer connections.
    try {
      const res = await fetch('/api/session', { headers: { Authorization: 'Bearer ' + state.token } });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length) state.iceServers = data.iceServers;
      }
    } catch (ex) {
      console.warn('could not refresh ICE servers during reconnect', ex);
    }
    if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    // Rejoin the current channel and rebuild peer connections (they died with
    // the old socket). Keep the chat log — don't clear it on a reconnect.
    const ch = $('#channel-select').value;
    state.channel = ch;
    teardownPeers();
    send({ type: 'join', channel: ch });
  };
  ws.onclose = (ev) => {
    if (ev.code === 4001) { localStorage.removeItem('ptt-token'); setStatus('idle', '已斷線'); setHint('⚠️ 連線授權失效,請重新登入(按登出)。'); return; }
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
  teardownPeers();
  loadChannelChat(channelId); // sets state.channel + restores this channel's saved messages
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
  const entry = {
    pc,
    audioEl: null,
    pendingIce: [],
    haveRemote: false,
    username,
    peerId,
    audioSender: null,
    statsTimer: null,
  };
  state.peers.set(peerId, entry);

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      const sender = pc.addTrack(track, state.localStream);
      if (track.kind === 'audio') {
        entry.audioSender = sender;
      }
    }
  } else {
    // listen-only: still need an audio m-line to receive the remote track
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', to: peerId, data: { kind: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    // Safari may deliver a track without populating event.streams.
    const stream = e.streams[0] || new MediaStream([e.track]);
    attachAudio(peerId, stream);
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    reportDiagnostic('webrtc_state', {
      statusKey: peerId,
      peerId,
      connectionState: s,
      iceState: pc.iceConnectionState,
    });
    // Media is P2P; make a failed path visible instead of silently muted.
    if (s === 'connected') { if ($('#hint').textContent.includes('語音')) setHint(''); }
    else if (s === 'failed') {
      setHint(state.netMode === 'lan'
        ? '⚠️ 語音無法連線。若對方不在同一區網,請把「連線模式」切成「外網」。'
        : '⚠️ 語音無法連線,對方網路可能需要 TURN 中繼伺服器(見說明)。');
    }
    if (s === 'failed' || s === 'closed') removePeer(peerId);
  };
  pc.oniceconnectionstatechange = () => {
    reportDiagnostic('webrtc_state', {
      statusKey: peerId,
      peerId,
      connectionState: pc.connectionState,
      iceState: pc.iceConnectionState,
    });
  };
  entry.statsTimer = setInterval(() => reportPeerStats(peerId, entry), 10000);
  return entry;
}

async function reportPeerStats(peerId, entry) {
  if (entry.pc.connectionState === 'closed') return;
  try {
    const report = await entry.pc.getStats();
    let selectedPairId = null;
    let selectedPair = null;
    let inboundBytes = 0;
    let outboundBytes = 0;
    let packetsReceived = 0;
    let packetsLost = 0;
    const rows = new Map();
    report.forEach((row) => {
      rows.set(row.id, row);
      if (row.type === 'transport' && row.selectedCandidatePairId) {
        selectedPairId = row.selectedCandidatePairId;
      }
      if (row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated) {
        selectedPair = row;
      }
      if (row.type === 'inbound-rtp' && row.kind === 'audio') {
        inboundBytes += Number(row.bytesReceived || 0);
        packetsReceived += Number(row.packetsReceived || 0);
        packetsLost += Number(row.packetsLost || 0);
      }
      if (row.type === 'outbound-rtp' && row.kind === 'audio') {
        outboundBytes += Number(row.bytesSent || 0);
      }
    });
    if (selectedPairId && rows.has(selectedPairId)) selectedPair = rows.get(selectedPairId);
    const local = selectedPair ? rows.get(selectedPair.localCandidateId) : null;
    const remote = selectedPair ? rows.get(selectedPair.remoteCandidateId) : null;
    reportDiagnostic('webrtc_stats', {
      statusKey: peerId,
      peerId,
      connectionState: entry.pc.connectionState,
      iceState: entry.pc.iceConnectionState,
      candidateType: local?.candidateType,
      remoteCandidateType: remote?.candidateType,
      protocol: local?.protocol,
      inboundBytes,
      outboundBytes,
      packetsReceived,
      packetsLost,
    });
  } catch (ex) {
    if (entry.pc.connectionState !== 'closed') {
      reportDiagnostic('peer_error', {
        statusKey: peerId,
        peerId,
        operation: 'getStats',
        errorName: ex.name,
        errorMessage: ex.message,
      });
    }
  }
}

async function connectToPeer(peerId, username, initiator) {
  if (state.peers.has(peerId)) return;
  const entry = createPeer(peerId, username);
  const { pc } = entry;
  if (initiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await mutePeerAfterNegotiation(entry);
      send({ type: 'signal', to: peerId, data: { kind: 'offer', sdp: pc.localDescription } });
    } catch (ex) {
      console.error('offer failed', ex);
      reportDiagnostic('peer_error', {
        statusKey: peerId,
        peerId,
        operation: 'createOffer',
        errorName: ex.name,
        errorMessage: ex.message,
      });
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
      await mutePeerAfterNegotiation(entry);
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
    reportDiagnostic('peer_error', {
      statusKey: from,
      peerId: from,
      operation: 'signal',
      errorName: ex.name,
      errorMessage: ex.message,
    });
  }
}

async function mutePeerAfterNegotiation(entry) {
  // The real track must be present while Safari generates SDP so the m-line is
  // negotiated as sendrecv. Detach it only after setLocalDescription().
  if (!state.hasFloor && entry.audioSender) {
    await entry.audioSender.replaceTrack(null);
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
  if (el.srcObject !== stream) el.srcObject = stream;
  el.play().catch(reportPlayError); // autoplay may need a tap on iOS Safari
}

function removePeer(peerId) {
  const entry = state.peers.get(peerId);
  if (!entry) return;
  clearInterval(entry.statsTimer);
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
  // Unmute/mute by attaching or detaching the real track on each peer's sender
  // (replaceTrack) rather than toggling track.enabled — the latter is unreliable
  // on iOS Safari, which is why the peer couldn't hear an iPhone.
  const track = liveMicTrack();
  for (const entry of state.peers.values()) {
    if (entry.audioSender) {
      entry.audioSender.replaceTrack(on ? track : null).catch((ex) => {
        console.error('audio sender replaceTrack() failed', ex);
        setHint('⚠️ 無法切換麥克風:' + ex.message);
        reportDiagnostic('peer_error', {
          statusKey: entry.peerId,
          peerId: entry.peerId,
          operation: 'replaceTrack',
          errorName: ex.name,
          errorMessage: ex.message,
        });
      });
    }
  }
  $('#ptt').classList.toggle('active', on);
  setStatus(on ? 'speaking' : 'idle', on ? '🔴 你正在說話' : '待機');
}

// ---- PTT button -----------------------------------------------------------
const pttBtn = $('#ptt');
const pressStart = (e) => {
  e.preventDefault();
  // Keep this call in the original user gesture so iOS can unlock playback.
  resumeRemoteAudio();
  requestTalk();
};
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
  if (!liveMicTrack()) {
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
const DEFAULT_QUICK_MESSAGES = [
  '🔈 我聽不到聲音，請把「連線模式」切成「外網」。',
];
const QUICK_MESSAGES_KEY = 'ptt-quick-messages';

function getCustomQuickMessages() {
  try {
    const messages = JSON.parse(localStorage.getItem(QUICK_MESSAGES_KEY) || '[]');
    return Array.isArray(messages) ? messages.filter((text) => typeof text === 'string' && text.trim()) : [];
  } catch {
    return [];
  }
}

function saveCustomQuickMessages(messages) {
  localStorage.setItem(QUICK_MESSAGES_KEY, JSON.stringify(messages));
}

// Short label for a chip (the default notice is long); the full text is sent.
function quickLabel(text) {
  return text.length > 16 ? text.slice(0, 15) + '…' : text;
}

function makeQuickChip(text, removable) {
  const chip = document.createElement('span');
  chip.className = 'chip';
  const t = document.createElement('button');
  t.type = 'button';
  t.className = 'chip-text';
  t.textContent = quickLabel(text);
  t.title = text;
  t.addEventListener('click', () => send({ type: 'chat', text }));
  chip.appendChild(t);
  if (removable) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chip-del';
    del.textContent = '×';
    del.setAttribute('aria-label', '刪除');
    del.addEventListener('click', () => {
      saveCustomQuickMessages(getCustomQuickMessages().filter((m) => m !== text));
      renderQuickMessages();
    });
    chip.appendChild(del);
  }
  return chip;
}

// Render tappable quick-phrase chips: fixed defaults, then the user's custom
// ones (each removable). Tapping a chip sends it as a chat message.
function renderQuickMessages() {
  const box = $('#quick-chips');
  box.innerHTML = '';
  for (const text of DEFAULT_QUICK_MESSAGES) box.appendChild(makeQuickChip(text, false));
  for (const text of getCustomQuickMessages()) box.appendChild(makeQuickChip(text, true));
}

// 加入: save whatever is in the message box as a reusable quick phrase.
$('#quick-add-btn').addEventListener('click', () => {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  const messages = getCustomQuickMessages();
  if (!DEFAULT_QUICK_MESSAGES.includes(text) && !messages.includes(text)) {
    messages.push(text);
    saveCustomQuickMessages(messages);
  }
  input.value = '';
  renderQuickMessages();
});
renderQuickMessages();

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

// Chat is intentionally session-only. Login and channel changes start empty.
function loadChannelChat(channel) {
  state.channel = channel;
  $('#chat-log').innerHTML = '';
  seenChat.clear();
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
