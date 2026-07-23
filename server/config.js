import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.PTT_CONFIG || join(__dirname, '..', 'config', 'users.json');

const raw = JSON.parse(readFileSync(configPath, 'utf8'));

// ICE servers sent to the browser for WebRTC. STUN is enough on the same LAN
// or over the open internet with friendly NATs; a TURN server (set via env) is
// needed to relay media when peers are behind symmetric NATs.
function iceServers() {
  const servers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    // TURN_URL may be a comma-separated list (e.g. udp + tcp + tls/443) so that
    // clients behind strict NATs can fall back to whichever transport gets out.
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

export const config = {
  jwtSecret: process.env.JWT_SECRET || raw.jwtSecret || 'dev-secret',
  channels: raw.channels || [],
  users: raw.users || [],
  port: Number(process.env.PORT) || 3000,
  iceServers: iceServers(),
};
