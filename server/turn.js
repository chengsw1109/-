import { config } from './config.js';

// Resolves the ICE servers sent to clients at login.
//
// If TURN_CREDENTIALS_URL is set, we fetch a fresh ICE-servers array from it
// (providers like metered.live hand out short-lived TURN credentials via such
// an endpoint) and cache the result briefly so we don't hit the API on every
// login. The static STUN (and any static TURN from env) is always kept as a
// baseline / fallback.

const TTL_MS = 30 * 60 * 1000; // re-fetch dynamic credentials at most every 30 min
let cache = { at: 0, servers: [] };

async function fetchDynamicIceServers() {
  if (!config.turnCredentialsUrl) return [];
  if (cache.servers.length && Date.now() - cache.at < TTL_MS) return cache.servers;
  try {
    const res = await fetch(config.turnCredentialsUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const servers = await res.json();
    if (Array.isArray(servers) && servers.length) cache = { at: Date.now(), servers };
    return cache.servers;
  } catch (err) {
    console.warn('[turn] could not fetch TURN credentials:', err.message);
    return cache.servers; // fall back to last good (or empty)
  }
}

export async function resolveIceServers() {
  const dynamic = await fetchDynamicIceServers();
  if (!dynamic.length) return config.iceServers;
  // Keep our STUN entry first, then the provider's (TURN + its own STUN).
  return [config.iceServers[0], ...dynamic];
}
