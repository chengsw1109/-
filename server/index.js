import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { login, verifyToken, allowedChannels, canAccessChannel } from './auth.js';
import { resolveIceServers } from './turn.js';
import {
  cleanupOldEvents,
  getInMemoryStatus,
  isPersistenceConfigured,
  recordDisconnect,
  recordEvent,
  recordNotification,
  registerDevice,
} from './diagnostics.js';
import * as rooms from './rooms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

// --- REST: login -----------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: '帳號或密碼錯誤' });
  res.json({
    ...result,
    channels: allowedChannels({ ...result.user }),
    iceServers: await resolveIceServers(),
  });
});

// Restore a session from a still-valid token (no password) — powers auto-login
// on reload and the "re-login" button, and hands back fresh ICE servers.
app.get('/api/session', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  const principal = verifyToken(token);
  if (!principal) return res.status(401).json({ error: '未授權' });
  res.json({
    user: { username: principal.username, role: principal.role, channels: principal.channels },
    channels: allowedChannels(principal),
    iceServers: await resolveIceServers(),
  });
});

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  diagnostics: {
    persistenceConfigured: isPersistenceConfigured(),
    activeStatuses: getInMemoryStatus().length,
  },
}));

// MCP calls this protected endpoint to publish a real channel notification.
// It is intentionally unavailable until a dedicated shared secret is set.
app.post('/api/admin/notify', (req, res) => {
  const auth = req.headers.authorization || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!config.mcpSharedSecret || supplied !== config.mcpSharedSecret) {
    return res.status(401).json({ error: '未授權' });
  }
  const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : '';
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  const actor = typeof req.body?.actor === 'string' ? req.body.actor : 'MCP administrator';
  if (!config.channels.some((channel) => channel.id === channelId)) {
    return res.status(404).json({ error: '頻道不存在' });
  }
  if (!message.trim() || message.length > 500) {
    return res.status(400).json({ error: '通知內容必須為 1–500 字' });
  }
  const result = rooms.systemChat(channelId, actor, message);
  recordNotification({
    channelId,
    actor,
    message: result.message,
    recipientCount: result.delivered,
  });
  return res.json({
    success: true,
    notificationId: result.id || null,
    channelId,
    recipientCount: result.delivered,
  });
});

const server = createServer(app);

// --- WebSocket: signalling, presence, floor control ------------------------
// Audio does NOT flow through here — it goes peer-to-peer over WebRTC. This
// socket only carries control messages and relays WebRTC offers/answers/ICE.
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Authenticate from the token in the query string: /ws?token=JWT
  const url = new URL(req.url, 'http://localhost');
  const principal = verifyToken(url.searchParams.get('token') || '');
  if (!principal) {
    ws.close(4001, 'unauthorized');
    return;
  }
  ws.peerId = randomUUID();
  ws.username = principal.username;
  ws.principal = principal;
  ws.channelId = null;
  rooms.register(ws);

  // Heartbeat: the browser auto-replies to protocol-level pings with a pong.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // no binary audio path anymore
    if (data.length > 20000) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'join':
        if (!canAccessChannel(principal, msg.channel)) {
          ws.send(JSON.stringify({ type: 'error', message: '無權限進入此頻道' }));
          return;
        }
        rooms.join(ws, msg.channel);
        recordEvent(ws, {
          eventType: 'ws_connected',
          statusKey: 'session',
          networkMode: ws.networkMode,
        });
        break;
      case 'leave':
        rooms.leave(ws);
        break;
      case 'signal':
        if (msg.to) rooms.signal(ws, msg.to, msg.data);
        break;
      case 'chat':
        if (typeof msg.text === 'string') rooms.chat(ws, msg.text);
        break;
      case 'talk_start':
        rooms.requestFloor(ws);
        break;
      case 'talk_stop':
        rooms.releaseFloor(ws);
        break;
      case 'device_hello':
        registerDevice(ws, msg);
        break;
      case 'diagnostic':
        ws.networkMode = msg.networkMode === 'wan' ? 'wan' : 'lan';
        recordEvent(ws, msg);
        break;
      default:
        break;
    }
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    recordDisconnect(ws, 'socket closed');
    rooms.leave(ws);
    rooms.unregister(ws);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Detect dead connections (phone asleep, Wi-Fi dropped, tunnel hiccup) that
// never sent a proper close — otherwise a departed peer lingers as "online".
// Each round: terminate anyone who didn't pong since the last ping, then ping
// everyone. terminate() fires 'close', which runs cleanup and updates presence.
const HEARTBEAT_MS = 10000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { ws.terminate(); }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(config.port, () => {
  console.log(`browser-ptt listening on http://localhost:${config.port}`);
});

cleanupOldEvents();
const diagnosticCleanup = setInterval(cleanupOldEvents, 24 * 60 * 60 * 1000);
diagnosticCleanup.unref?.();
