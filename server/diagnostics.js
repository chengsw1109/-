import { config } from './config.js';

const EVENT_TYPES = new Set([
  'client_ready',
  'network_mode_changed',
  'ws_connected',
  'ws_disconnected',
  'ws_reconnect_scheduled',
  'webrtc_state',
  'webrtc_stats',
  'mic_error',
  'track_ended',
  'audio_play_error',
  'peer_error',
  'turn_test',
]);
const STATE_VALUES = new Set([
  'new', 'connecting', 'connected', 'disconnected', 'failed', 'closed',
  'checking', 'completed',
]);
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const currentStatus = new Map();
let warnedUnavailable = false;

function cleanText(value, max = 160) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max)
    : null;
}

function cleanInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function allowed(value, values) {
  return values.has(value) ? value : null;
}

function supabaseHeaders(prefer = 'return=minimal') {
  return {
    apikey: config.supabaseServiceRoleKey,
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  };
}

async function supabaseRequest(path, options = {}) {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return null;
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...supabaseHeaders(options.prefer),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Supabase ${response.status}: ${body}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function persist(promise) {
  promise.catch((error) => {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn('[diagnostics] persistence unavailable:', error.message);
    }
  });
}

export function isPersistenceConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

export function registerDevice(ws, payload = {}) {
  const deviceId = cleanText(payload.deviceId, 96);
  if (!deviceId) return false;
  ws.deviceId = deviceId;
  ws.deviceFamily = cleanText(payload.deviceFamily, 40) || 'unknown';
  ws.browserFamily = cleanText(payload.browserFamily, 40) || 'unknown';
  const row = {
    device_id: deviceId,
    username: ws.username,
    device_family: ws.deviceFamily,
    browser_family: ws.browserFamily,
    last_seen_at: new Date().toISOString(),
  };
  ws.deviceReady = supabaseRequest('ptt_devices?on_conflict=device_id', {
    method: 'POST',
    body: JSON.stringify(row),
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  persist(ws.deviceReady);
  recordEvent(ws, { eventType: 'client_ready', statusKey: 'session' });
  return true;
}

function sanitizeEvent(ws, payload = {}) {
  if (!ws.deviceId) return null;
  const eventType = cleanText(payload.eventType, 48);
  if (!EVENT_TYPES.has(eventType)) return null;
  const peerId = cleanText(payload.peerId, 96);
  const statusKey = cleanText(payload.statusKey, 120) || peerId || 'session';
  const details = {};
  if (typeof payload.relayAvailable === 'boolean') details.relay_available = payload.relayAvailable;
  const operation = cleanText(payload.operation, 80);
  if (operation) details.operation = operation;
  const reason = cleanText(payload.reason, 160);
  if (reason) details.reason = reason;

  return {
    statusKey,
    row: {
      device_id: ws.deviceId,
      username: ws.username,
      channel_id: cleanText(ws.channelId, 80),
      session_id: cleanText(ws.peerId, 96),
      peer_id: peerId,
      event_type: eventType,
      network_mode: payload.networkMode === 'lan' || payload.networkMode === 'wan'
        ? payload.networkMode
        : null,
      connection_state: allowed(payload.connectionState, STATE_VALUES),
      ice_state: allowed(payload.iceState, STATE_VALUES),
      candidate_type: allowed(payload.candidateType, CANDIDATE_TYPES),
      remote_candidate_type: allowed(payload.remoteCandidateType, CANDIDATE_TYPES),
      protocol: cleanText(payload.protocol, 24),
      inbound_bytes: cleanInteger(payload.inboundBytes),
      outbound_bytes: cleanInteger(payload.outboundBytes),
      packets_received: cleanInteger(payload.packetsReceived),
      packets_lost: cleanInteger(payload.packetsLost),
      error_name: cleanText(payload.errorName, 80),
      error_message: cleanText(payload.errorMessage, 240),
      details,
    },
  };
}

export function recordEvent(ws, payload = {}) {
  const event = sanitizeEvent(ws, payload);
  if (!event) return false;
  const now = new Date().toISOString();
  const status = { ...event.row, status_key: event.statusKey, updated_at: now };
  delete status.details;
  currentStatus.set(`${status.device_id}:${status.status_key}`, status);

  const deviceReady = ws.deviceReady || Promise.resolve();
  persist(deviceReady.then(() => supabaseRequest('ptt_connection_events', {
    method: 'POST',
    body: JSON.stringify({ ...event.row, created_at: now }),
  })));
  persist(deviceReady.then(() => supabaseRequest('ptt_current_status?on_conflict=device_id,status_key', {
    method: 'POST',
    body: JSON.stringify(status),
    prefer: 'resolution=merge-duplicates,return=minimal',
  })));
  return true;
}

export function recordDisconnect(ws, reason) {
  if (!ws.deviceId) return;
  recordEvent(ws, {
    eventType: 'ws_disconnected',
    statusKey: 'session',
    networkMode: ws.networkMode,
    reason,
  });
}

export function getInMemoryStatus() {
  return [...currentStatus.values()];
}

export function recordNotification({ channelId, actor, message, recipientCount }) {
  persist(supabaseRequest('ptt_notifications', {
    method: 'POST',
    body: JSON.stringify({
      channel_id: cleanText(channelId, 80),
      actor: cleanText(actor, 80) || 'MCP administrator',
      message: cleanText(message, 500),
      recipient_count: cleanInteger(recipientCount) || 0,
    }),
  }));
}

export function cleanupOldEvents() {
  if (!isPersistenceConfigured()) return;
  const cutoff = new Date(Date.now() - config.diagnosticRetentionDays * 86400000).toISOString();
  persist(supabaseRequest(`ptt_connection_events?created_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'DELETE',
  }));
}
