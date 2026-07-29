import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load a root .env file (KEY=VALUE lines) into process.env if present — no
// dependency and no Node flag, so `npm start` picks it up on any Node ≥ 18.
// Real environment variables always win over .env values.
function loadDotEnv() {
  const envPath = join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

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
  // Optional: a URL that returns a fresh ICE-servers JSON array (e.g. metered's
  // https://<app>.metered.live/api/v1/turn/credentials?apiKey=...). When set,
  // the server fetches short-lived TURN credentials from it at login time.
  turnCredentialsUrl: process.env.TURN_CREDENTIALS_URL || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  mcpSharedSecret: process.env.PTT_MCP_SHARED_SECRET || '',
  diagnosticRetentionDays: Math.max(1, Number(process.env.DIAGNOSTIC_RETENTION_DAYS) || 30),
};
