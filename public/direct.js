'use strict';

/* browser-ptt · serverless 1-to-1 private call (with QR exchange)
 * --------------------------------------------------------------
 * No login, no signalling server, no media server. Two browsers connect
 * directly over WebRTC by exchanging offer/answer codes — either by scanning a
 * QR (which encodes a deep link the phone camera can open) or copy/paste. Once
 * connected, audio and the PTT control channel are pure peer-to-peer.
 *
 * Codes are deflate-compressed (CompressionStream) then base64url'd so they fit
 * in a scannable QR. The QR is a URL like <origin>/direct.html#o=<code>; the
 * receiver's camera opens it and the page pre-fills the invite. iOS Safari has
 * no in-page BarcodeDetector, so on iOS the invite is scanned with the native
 * camera and the reply falls back to copy/paste; Chrome/Android can scan the
 * reply in-page too.
 */

const $ = (s) => document.querySelector(s);

const state = { pc: null, localStream: null, channel: null, hasFloor: false };
const hasCompression = typeof CompressionStream !== 'undefined';
const canScanInPage = 'BarcodeDetector' in window;

// ---- code (de)compression + base64url -------------------------------------
async function deflate(str) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}
function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
// tag: 'c' = compressed, 'p' = plain (fallback when no CompressionStream)
async function packDesc(desc) {
  const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  if (hasCompression) return 'c' + b64urlEncode(await deflate(json));
  return 'p' + b64urlEncode(new TextEncoder().encode(json));
}
async function unpackCode(code) {
  code = code.trim();
  const tag = code[0], bytes = b64urlDecode(code.slice(1));
  const json = tag === 'c' ? await inflate(bytes)
    : tag === 'p' ? new TextDecoder().decode(bytes)
      : (() => { throw new Error('unrecognized code'); })();
  return JSON.parse(json);
}

// ---- QR rendering (SVG via vendored encoder) ------------------------------
function deepLink(param, code) {
  return location.origin + location.pathname + '#' + param + '=' + code;
}
function renderQR(container, text) {
  container.hidden = false;
  let qr;
  try { qr = QR.encode(text, 'L'); }
  catch { container.innerHTML = '<p class="muted small">連線碼太長,無法產生 QR — 請改用複製貼上。</p>'; return; }
  const n = qr.size, quiet = 4, dim = n + quiet * 2;
  let path = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.getModule(x, y)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  container.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="240" height="240" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// ---- WebRTC ---------------------------------------------------------------
function iceServers() {
  return $('#lan-only').checked ? [] : [{ urls: 'stun:stun.l.google.com:19302' }];
}
function waitIceComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 3000);
  });
}
async function ensureMic() {
  if (state.localStream) return state.localStream;
  state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
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
    else if (s === 'failed' || s === 'disconnected' || s === 'closed') setStatus('idle', '已斷線');
  };
  state.pc = pc;
  return pc;
}
function setupChannel(dc) {
  state.channel = dc;
  dc.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'talk') setStatus(m.on ? 'receiving' : 'idle', m.on ? '🔊 對方正在說話' : '已連線');
  };
}

// ---- Caller ---------------------------------------------------------------
async function createInvite() {
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
    const code = await packDesc(pc.localDescription);
    $('#offer-out').value = code;
    renderQR($('#offer-qr'), deepLink('o', code));
  } catch (ex) {
    setHint('⚠️ ' + ex.name + ': ' + ex.message);
  }
}
async function connectWithReply() {
  try {
    const answer = await unpackCode($('#answer-in').value);
    await state.pc.setRemoteDescription(answer);
    setHint('連線中…');
  } catch (ex) {
    setHint('⚠️ 回覆碼無效:' + ex.message);
  }
}

// ---- Callee ---------------------------------------------------------------
async function generateReply() {
  try {
    const offer = await unpackCode($('#offer-in').value);
    await ensureMic();
    const pc = makePc();
    pc.ondatachannel = (e) => setupChannel(e.channel);
    for (const t of state.localStream.getTracks()) pc.addTrack(t, state.localStream);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);
    const code = await packDesc(pc.localDescription);
    $('#answer-out').value = code;
    $('#answer-h').hidden = false;
    $('#answer-manual').hidden = false;
    renderQR($('#answer-qr'), deepLink('a', code));
    setHint('回覆已就緒 — 讓對方掃描(或把碼傳給對方)。之後會自動連線。');
  } catch (ex) {
    setHint('⚠️ 邀請碼無效:' + ex.message);
  }
}
function startCalleeFromCode(code) {
  showFlow('callee');
  $('#offer-in').value = code;
  setHint('已載入邀請 — 請點「產生回覆」。');
}

// ---- In-page QR scanning (BarcodeDetector; not on iOS Safari) --------------
function codeFromScan(raw) {
  const h = raw.indexOf('#');
  if (h >= 0) {
    const p = new URLSearchParams(raw.slice(h + 1));
    return p.get('o') || p.get('a') || raw.trim();
  }
  return raw.trim();
}
async function scanQR(onResult) {
  if (!canScanInPage) { setHint('此瀏覽器無法頁內掃描 — 請改用貼上連線碼。'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch (e) { setHint('無法使用相機:' + e.message); return; }
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  const overlay = $('#scanner'), video = $('#scan-video');
  overlay.hidden = false; video.srcObject = stream; await video.play().catch(() => {});
  let stopped = false;
  const stop = () => { stopped = true; overlay.hidden = true; stream.getTracks().forEach((t) => t.stop()); };
  $('#scan-cancel').onclick = stop;
  const tick = async () => {
    if (stopped) return;
    try {
      const found = await det.detect(video);
      if (found.length) { stop(); onResult(codeFromScan(found[0].rawValue)); return; }
    } catch { /* keep trying */ }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- Connected call: PTT --------------------------------------------------
function showCall() {
  $('#setup').hidden = true;
  $('#call').hidden = false;
  setStatus('idle', '已連線');
}
function talk(on) {
  if (on === state.hasFloor || !state.localStream) return;
  state.hasFloor = on;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = on));
  $('#ptt').classList.toggle('active', on);
  setStatus(on ? 'speaking' : 'idle', on ? '🔴 你正在說話' : '已連線');
  if (state.channel?.readyState === 'open') state.channel.send(JSON.stringify({ type: 'talk', on }));
}

// ---- Wire up UI -----------------------------------------------------------
$('#btn-create').addEventListener('click', createInvite);
$('#btn-join').addEventListener('click', () => { showFlow('callee'); setHint(''); });
$('#gen-answer').addEventListener('click', generateReply);
$('#connect-btn').addEventListener('click', connectWithReply);
$('#scan-invite').addEventListener('click', () => scanQR((code) => { $('#offer-in').value = code; generateReply(); }));
$('#scan-reply').addEventListener('click', () => scanQR((code) => { $('#answer-in').value = code; connectWithReply(); }));
$('#copy-offer').addEventListener('click', () => copy($('#offer-out')));
$('#copy-answer').addEventListener('click', () => copy($('#answer-out')));
$('#enable-audio').addEventListener('click', () => { $('#remote').play().catch(() => {}); $('#enable-audio').hidden = true; });
$('#hangup').addEventListener('click', () => { try { state.pc?.close(); } catch {} location.reload(); });

const ptt = $('#ptt');
const down = (e) => { e.preventDefault(); talk(true); };
const up = (e) => { e.preventDefault(); talk(false); };
ptt.addEventListener('mousedown', down);
ptt.addEventListener('touchstart', down, { passive: false });
window.addEventListener('mouseup', up);
ptt.addEventListener('touchend', up, { passive: false });
ptt.addEventListener('touchcancel', up);
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); talk(true); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { e.preventDefault(); talk(false); } });

function copy(el) { el.select(); navigator.clipboard?.writeText(el.value).catch(() => document.execCommand('copy')); }
function showFlow(which) { $('#caller').hidden = which !== 'caller'; $('#callee').hidden = which !== 'callee'; }
function setStatus(kind, text) { $('#dot').className = 'dot ' + kind; $('#status').textContent = text; }
function setHint(t) { $('#setup-hint').textContent = t; }

// Show in-page scan buttons only where supported.
if (canScanInPage) { $('#scan-invite').hidden = false; $('#scan-reply').hidden = false; }

// Deep link: a scanned invite opens <origin>/direct.html#o=<code>.
(function handleDeepLink() {
  if (!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('o')) startCalleeFromCode(p.get('o'));
  else if (p.has('a')) setHint('這是回覆碼 — 請在發起邀請的裝置上開啟,或貼到那台裝置的邀請畫面。');
})();

// 能力偵測警告
if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
  setHint('⚠️ 此瀏覽器不支援 WebRTC。');
} else if (!location.protocol.startsWith('https') && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  setHint('⚠️ 麥克風需要 HTTPS(或 localhost)。實機請以 HTTPS 提供服務。');
}
