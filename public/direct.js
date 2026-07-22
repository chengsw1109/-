'use strict';

/* browser-ptt · serverless 1-to-1 private call
 * --------------------------------------------
 * No login, no signalling server, no media server. Two browsers connect
 * directly over WebRTC by exchanging offer/answer "codes" manually (the users
 * paste them to each other over any out-of-band channel). Once connected, both
 * audio and the PTT control channel are pure peer-to-peer.
 *
 * Reality check: WebRTC still needs to discover network paths. On the same LAN
 * that works with host candidates alone; across networks it needs a STUN server
 * (address discovery only — it never sees your audio). Behind symmetric NATs a
 * direct path may be impossible without a TURN relay, which a truly serverless
 * setup cannot provide. The "LAN only" checkbox drops STUN entirely.
 */

const $ = (s) => document.querySelector(s);

const state = {
  pc: null,
  localStream: null,
  channel: null, // RTCDataChannel for PTT control
  hasFloor: false,
};

// ---- UTF-8-safe base64 for the exchange codes -----------------------------
const encode = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
const decode = (str) => JSON.parse(decodeURIComponent(escape(atob(str.trim()))));

function iceServers() {
  return $('#lan-only').checked ? [] : [{ urls: 'stun:stun.l.google.com:19302' }];
}

// Wait until ICE candidate gathering finishes so the code is self-contained
// (non-trickle). Falls back after a short timeout if gathering stalls.
function waitIceComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 3000);
  });
}

async function ensureMic() {
  if (state.localStream) return state.localStream;
  state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = false)); // muted until PTT
  return state.localStream;
}

function makePc() {
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  pc.ontrack = (e) => {
    const el = $('#remote');
    el.srcObject = e.streams[0];
    el.play().catch(() => { $('#enable-audio').hidden = false; });
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') showCall();
    else if (s === 'failed' || s === 'disconnected' || s === 'closed') setStatus('idle', 'Disconnected');
  };
  state.pc = pc;
  return pc;
}

function setupChannel(dc) {
  state.channel = dc;
  dc.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'talk') setStatus(m.on ? 'receiving' : 'idle', m.on ? '🔊 Peer is talking' : 'Connected');
  };
}

// ---- Caller flow ----------------------------------------------------------
$('#btn-create').addEventListener('click', async () => {
  showFlow('caller');
  setHint('');
  try {
    await ensureMic();
    const pc = makePc();
    for (const t of state.localStream.getTracks()) pc.addTrack(t, state.localStream);
    setupChannel(pc.createDataChannel('ctrl'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    $('#offer-out').value = encode(pc.localDescription);
  } catch (ex) {
    setHint('⚠️ ' + ex.name + ': ' + ex.message);
  }
});

$('#connect-btn').addEventListener('click', async () => {
  try {
    const answer = decode($('#answer-in').value);
    await state.pc.setRemoteDescription(answer);
    setHint('Connecting…');
  } catch (ex) {
    setHint('⚠️ Bad reply code: ' + ex.message);
  }
});

// ---- Callee flow ----------------------------------------------------------
$('#btn-join').addEventListener('click', () => { showFlow('callee'); setHint(''); });

$('#gen-answer').addEventListener('click', async () => {
  try {
    const offer = decode($('#offer-in').value);
    await ensureMic();
    const pc = makePc();
    pc.ondatachannel = (e) => setupChannel(e.channel);
    for (const t of state.localStream.getTracks()) pc.addTrack(t, state.localStream);

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);

    $('#answer-out').value = encode(pc.localDescription);
    $('#answer-h').hidden = false;
    $('#answer-out').hidden = false;
    $('#copy-answer').hidden = false;
    setHint('Reply generated — send it back and wait to connect.');
  } catch (ex) {
    setHint('⚠️ Bad invite code: ' + ex.message);
  }
});

// ---- Copy buttons ---------------------------------------------------------
$('#copy-offer').addEventListener('click', () => copy($('#offer-out')));
$('#copy-answer').addEventListener('click', () => copy($('#answer-out')));
function copy(el) {
  el.select();
  navigator.clipboard?.writeText(el.value).catch(() => document.execCommand('copy'));
}

// ---- Connected call: PTT --------------------------------------------------
function showCall() {
  $('#setup').hidden = true;
  $('#call').hidden = false;
  setStatus('idle', 'Connected');
}
$('#enable-audio').addEventListener('click', () => {
  $('#remote').play().catch(() => {});
  $('#enable-audio').hidden = true;
});
$('#hangup').addEventListener('click', () => {
  try { state.pc?.close(); } catch {}
  location.reload();
});

const ptt = $('#ptt');
const start = (e) => { e.preventDefault(); talk(true); };
const stop = (e) => { e.preventDefault(); talk(false); };
ptt.addEventListener('mousedown', start);
ptt.addEventListener('touchstart', start, { passive: false });
window.addEventListener('mouseup', stop);
ptt.addEventListener('touchend', stop, { passive: false });
ptt.addEventListener('touchcancel', stop);
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); talk(true); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { e.preventDefault(); talk(false); } });

function talk(on) {
  if (on === state.hasFloor || !state.localStream) return;
  state.hasFloor = on;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = on));
  ptt.classList.toggle('active', on);
  setStatus(on ? 'speaking' : 'idle', on ? '🔴 You are talking' : 'Connected');
  if (state.channel?.readyState === 'open') state.channel.send(JSON.stringify({ type: 'talk', on }));
}

// ---- UI helpers -----------------------------------------------------------
function showFlow(which) {
  $('#caller').hidden = which !== 'caller';
  $('#callee').hidden = which !== 'callee';
}
function setStatus(kind, text) {
  $('#dot').className = 'dot ' + kind;
  $('#status').textContent = text;
}
function setHint(t) { $('#setup-hint').textContent = t; }

// Capability warning
if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
  setHint('⚠️ This browser does not support WebRTC.');
} else if (!location.protocol.startsWith('https') && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  setHint('⚠️ Microphone needs HTTPS (or localhost). Serve over HTTPS on real devices.');
}
