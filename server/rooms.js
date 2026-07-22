// In-memory channel state: presence + half-duplex floor control.
//
// Half-duplex means a channel has at most ONE active speaker at a time, just
// like a real walkie-talkie. The server is the single source of truth for who
// holds the floor, which also makes audio routing unambiguous: while a user
// holds the floor, their binary frames are forwarded to everyone else in the
// channel and nobody else's frames are accepted.

const channels = new Map(); // channelId -> { members:Set<ws>, activeSpeaker:ws|null }

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

// De-duplicated list of usernames currently in the channel.
function presence(ch) {
  const names = new Set();
  for (const ws of ch.members) names.add(ws.username);
  return [...names];
}

export function join(ws, channelId) {
  leave(ws); // ensure a connection is only ever in one channel
  const ch = getChannel(channelId);
  ch.members.add(ws);
  ws.channelId = channelId;

  send(ws, {
    type: 'joined',
    channel: channelId,
    members: presence(ch),
    speaking: ch.activeSpeaker ? ch.activeSpeaker.username : null,
  });
  broadcast(ch, { type: 'presence', channel: channelId, members: presence(ch) }, { except: ws });
}

export function leave(ws) {
  const id = ws.channelId;
  if (!id) return;
  const ch = channels.get(id);
  ws.channelId = null;
  if (!ch) return;

  // If the leaver held the floor, release it for everyone.
  if (ch.activeSpeaker === ws) {
    ch.activeSpeaker = null;
    broadcast(ch, { type: 'speaking_end', channel: id, user: ws.username });
  }
  ch.members.delete(ws);
  broadcast(ch, { type: 'presence', channel: id, members: presence(ch) });
}

// Try to acquire the floor (PTT pressed). Returns true if granted.
export function requestFloor(ws) {
  const ch = channels.get(ws.channelId);
  if (!ch) {
    send(ws, { type: 'error', message: 'Not in a channel' });
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

// Release the floor (PTT released or transmission ended).
export function releaseFloor(ws) {
  const ch = channels.get(ws.channelId);
  if (!ch || ch.activeSpeaker !== ws) return;
  ch.activeSpeaker = null;
  broadcast(ch, { type: 'speaking_end', channel: ws.channelId, user: ws.username });
}

// Forward an audio frame from the current speaker to the rest of the channel.
export function relayAudio(ws, chunk) {
  const ch = channels.get(ws.channelId);
  if (!ch || ch.activeSpeaker !== ws) return; // only the floor holder may stream
  for (const peer of ch.members) {
    if (peer === ws) continue;
    if (peer.readyState === peer.OPEN) peer.send(chunk, { binary: true });
  }
}
