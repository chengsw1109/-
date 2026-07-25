// End-to-end test of the 外網 (WAN) audio path.
//
// Spins up a real TURN server (node-turn) and the app, launches two headless
// browsers in WAN mode, forces every RTCPeerConnection to relay-only so media
// MUST traverse TURN, then verifies that EACH side receives the other's audio
// (checked via getStats inbound-rtp bytesReceived). This proves the app's
// WebRTC 外網 media path works in both directions with a working TURN server —
// so if real-world 外網 has no sound, the TURN service/credentials are the
// suspect, not the client code.
//
// Run: npm run test:wan   (needs devDeps: node-turn, playwright-core, and a
// Chromium at $CHROMIUM_PATH — defaults to this environment's pre-installed one)

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const Turn = require('node-turn');

const PORT = 3099;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TURN_PORT = 3478;
const fail = (msg) => { console.error('✗ ' + msg); shutdown(1); };

let turn, server, browser;
function shutdown(code) {
  try { browser?.close(); } catch {}
  try { server?.kill('SIGKILL'); } catch {}
  try { turn?.stop?.(); } catch {}
  process.exit(code);
}

async function waitForHealth(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

// 1) local TURN server
turn = new Turn({ authMech: 'long-term', credentials: { pttuser: 'pttpass' }, listeningPort: TURN_PORT, debugLevel: 'ERROR' });
turn.start();

// 2) the app, pointed at the local TURN via static env
server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), TURN_CREDENTIALS_URL: '', TURN_URL: `turn:127.0.0.1:${TURN_PORT}`, TURN_USERNAME: 'pttuser', TURN_CREDENTIAL: 'pttpass' },
  stdio: 'ignore',
});
await waitForHealth(`http://localhost:${PORT}/api/health`);

// 3) two browsers: 外網 mode + relay-only
browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function makePage(user, pass) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('ptt-net-mode', 'wan');
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (cfg, ...rest) {
      cfg = Object.assign({}, cfg || {}, { iceTransportPolicy: 'relay' });
      const pc = new Orig(cfg, ...rest);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  return page;
}
const inbound = (page) => page.evaluate(async () => {
  let t = 0;
  for (const pc of window.__pcs) { const s = await pc.getStats(); s.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') t += r.bytesReceived || 0; }); }
  return t;
});
const relayed = (page) => page.evaluate(async () => {
  for (const pc of window.__pcs) {
    const s = await pc.getStats(); let pair = null, local = null;
    s.forEach((r) => { if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated)) pair = r; });
    s.forEach((r) => { if (pair && r.id === pair.localCandidateId) local = r; });
    if (pc.connectionState !== 'connected' || local?.candidateType !== 'relay') return false;
  }
  return window.__pcs.length > 0;
});

const david = await makePage('david', 'd123');
const maggie = await makePage('maggie', 'm123');
await david.waitForTimeout(5000);

if (!(await relayed(david)) || !(await relayed(maggie))) fail('peers did not connect via TURN relay');

async function talk(speaker, listener) {
  const before = await inbound(listener);
  await speaker.dispatchEvent('#ptt', 'mousedown');
  await speaker.waitForTimeout(2500);
  await speaker.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup')));
  return (await inbound(listener)) - before;
}

const heardDavid = await talk(david, maggie);
const heardMaggie = await talk(maggie, david);

console.log(`[外網/relay] maggie 收到 david: +${heardDavid} bytes`);
console.log(`[外網/relay] david 收到 maggie: +${heardMaggie} bytes`);
if (heardDavid > 2000 && heardMaggie > 2000) {
  console.log('✓ PASS — both directions receive audio over TURN relay');
  shutdown(0);
} else {
  fail('one or both directions received no audio over relay');
}
