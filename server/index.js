import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { login, verifyToken, allowedChannels, canAccessChannel } from './auth.js';
import * as rooms from './rooms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

// --- REST: login -----------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'invalid credentials' });
  res.json({
    ...result,
    channels: allowedChannels({ ...result.user }),
    iceServers: config.iceServers,
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // no binary audio path anymore
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'join':
        if (!canAccessChannel(principal, msg.channel)) {
          ws.send(JSON.stringify({ type: 'error', message: 'access denied to channel' }));
          return;
        }
        rooms.join(ws, msg.channel);
        break;
      case 'leave':
        rooms.leave(ws);
        break;
      case 'signal':
        if (msg.to) rooms.signal(ws, msg.to, msg.data);
        break;
      case 'talk_start':
        rooms.requestFloor(ws);
        break;
      case 'talk_stop':
        rooms.releaseFloor(ws);
        break;
      default:
        break;
    }
  });

  const cleanup = () => {
    rooms.leave(ws);
    rooms.unregister(ws);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(config.port, () => {
  console.log(`browser-ptt listening on http://localhost:${config.port}`);
});
