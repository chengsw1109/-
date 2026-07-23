// In-memory channel state: presence, half-duplex floor control, and WebRTC
// signalling relay.
//
// Media (audio) travels peer-to-peer over WebRTC — it does NOT pass through
// this server. The server's job for media is only to relay the small SDP/ICE
// signalling messages between peers so they can establish those P2P links.
//
// Half-duplex means a channel has at most ONE active speaker at a time, like a
// real walkie-talkie. Peers keep their mic track connected but muted; the floor
// holder is the only one allowed to unmute. The server is the source of truth
// for who holds the floor.

const channels = new Map(); // channelId -> { members:Set<ws>, activeSpeaker:ws|null }
const byPeerId = new Map(); // peerId -> ws (for addressing signalling messages)

export function register(ws) {
  byPeerId.set(ws.peerId, ws);
}
export function unregister(ws) {
  byPeerId.delete(ws.peerId);
}

function getChannel(id) {
  let ch = channels.get(id);
  if (!ch) {
    ch = { members: new Set(), activeSpeaker: null };
    channels.set(id, ch);
  }
  return ch;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(ch, obj, { except } = {}) {
  const msg = JSON.stringify(obj);
  for (const ws of ch.members) {
    if (ws === except) continue;
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// De-duplicated list of usernames in the channel (for the online list UI).
function presence(ch) {
  const names = new Set();
  for (const ws of ch.members) names.add(ws.username);
  return [...names];
}

// One entry per connection (needed for WebRTC — each connection is a peer).
function peerList(ch, except) {
  const out = [];
  for (const ws of ch.members) {
    if (ws === except) continue;
    out.push({ peerId: ws.peerId, username: ws.username });
  }
  return out;
}

export function join(ws, channelId) {
  leave(ws); // a connection is only ever in one channel
  const ch = getChannel(channelId);
  ch.members.add(ws);
  ws.channelId = channelId;

  // Tell the joiner who is already here so it can open peer connections.
  send(ws, {
    type: 'joined',
    channel: channelId,
    self: { peerId: ws.peerId, username: ws.username },
    peers: peerList(ch, ws),
    members: presence(ch),
    speaking: ch.activeSpeaker ? ch.activeSpeaker.username : null,
  });
  // Tell existing members a new peer arrived.
  broadcast(
    ch,
    { type: 'peer_joined', channel: channelId, peerId: ws.peerId, username: ws.username, members: presence(ch) },
    { except: ws }
  );
}

export function leave(ws) {
  const id = ws.channelId;
  if (!id) return;
  const ch = channels.get(id);
  ws.channelId = null;
  if (!ch) return;

  if (ch.activeSpeaker === ws) {
    ch.activeSpeaker = null;
    broadcast(ch, { type: 'speaking_end', channel: id, user: ws.username });
  }
  ch.members.delete(ws);
  broadcast(ch, { type: 'peer_left', channel: id, peerId: ws.peerId, username: ws.username, members: presence(ch) });
}

// Relay a WebRTC signalling message (offer / answer / ICE candidate) to a
// specific peer in the same channel.
export function signal(ws, to, data) {
  const target = byPeerId.get(to);
  if (target && target.channelId === ws.channelId && target.readyState === target.OPEN) {
    target.send(JSON.stringify({ type: 'signal', from: ws.peerId, data }));
  }
}

// Relay a text chat message to everyone in the channel (sender included).
// Goes over the WebSocket, NOT WebRTC — so it still works when the P2P audio
// path is broken (its main purpose: telling a peer to switch to 外網/TURN).
export function chat(ws, text) {
  const ch = channels.get(ws.channelId);
  if (!ch) return;
  const clean = String(text).replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 500).trim();
  if (!clean) return;
  broadcast(ch, { type: 'chat', channel: ws.channelId, user: ws.username, text: clean, ts: Date.now() });
}

// Try to acquire the floor (PTT pressed). Returns true if granted.
export function requestFloor(ws) {
  const ch = channels.get(ws.channelId);
  if (!ch) {
    send(ws, { type: 'error', message: '尚未加入頻道' });
    return false;
  }
  if (ch.activeSpeaker && ch.activeSpeaker !== ws) {
    send(ws, { type: 'talk_denied', by: ch.activeSpeaker.username });
    return false;
  }
  ch.activeSpeaker = ws;
  send(ws, { type: 'talk_granted' });
  broadcast(ch, { type: 'speaking', channel: ws.channelId, user: ws.username }, { except: ws });
  return true;
}

// Release the floor (PTT released, tab closed, etc.).
export function releaseFloor(ws) {
  const ch = channels.get(ws.channelId);
  if (!ch || ch.activeSpeaker !== ws) return;
  ch.activeSpeaker = null;
  broadcast(ch, { type: 'speaking_end', channel: ws.channelId, user: ws.username });
}
