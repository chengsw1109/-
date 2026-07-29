# Browser PTT Diagnostics MCP

## Value Proposition

Give the Browser PTT administrator a conversational way to inspect current and
historical connection health across devices, understand repeated disconnects,
and send a text notification to a channel.

**Target user:** the PTT system administrator.

**Pain today:** WebRTC failures happen in remote browsers and disappear after
the page or server restarts. Troubleshooting requires asking users for console
logs and `webrtc-internals` data.

**Core actions:**

1. Query current device and peer connection status.
2. Summarize recent errors, disconnects, and device history.
3. Send an administrator notification to a channel.

## Why an LLM?

**Conversational win:** the administrator can ask questions such as “Which
device disconnected most often today?” without navigating filters or writing
SQL.

**LLM contribution:** translate natural-language time ranges and device/channel
references into tool inputs, compare structured telemetry, and explain likely
failure layers.

**What the LLM lacks:** live PTT state, historical telemetry, and the ability to
publish a real channel notification. MCP supplies these capabilities.

Deterministic recovery remains in the PTT client. MCP and the LLM do not control
microphones and are not required for automatic LAN/WAN recovery.

## Product Context

- Existing app: Node.js, Express, WebSocket, and browser WebRTC.
- Existing auth: PTT username/password exchanged for a JWT.
- Database: Supabase PostgreSQL, written only by the trusted Node.js backend.
- MCP: tool-only server; no custom view.
- Package manager: npm.
- Retention: diagnostic events are retained for 30 days by default.
- Privacy: never store audio, JWTs, TURN credentials, API keys, or full private
  IP addresses.

## UX Flows

### Diagnose current or recent connection health

1. Administrator asks a natural-language status or diagnostic question.
2. The LLM calls one read-only MCP tool.
3. The tool returns bounded structured data.
4. The LLM summarizes evidence and identifies the most likely failure layer.

### Send a channel notification

1. Administrator names a channel and message.
2. The LLM calls `send_notification`.
3. The PTT backend broadcasts the message to currently connected channel
   members.
4. The tool returns delivery counts and a notification audit record.

## Tools

### `get_current_status`

- **Input:** optional `channelId`, `username`
- **Output:** current device sessions and latest peer diagnostics
- **Behavior:** read-only

### `get_recent_errors`

- **Input:** optional `channelId`, `username`, `hours` (1–168), `limit` (1–100)
- **Output:** recent error and failure events, newest first
- **Behavior:** read-only

### `get_device_history`

- **Input:** `deviceId`, optional `hours` (1–720), `limit` (1–200)
- **Output:** bounded diagnostic event history for one device
- **Behavior:** read-only

### `get_disconnect_summary`

- **Input:** optional `channelId`, `hours` (1–720), `limit` (1–50)
- **Output:** devices ranked by disconnect/failure count
- **Behavior:** read-only

### `send_notification`

- **Input:** `channelId`, `message` (1–500 characters)
- **Output:** success, recipient count, notification id
- **Behavior:** external side effect; publishes text only

## Telemetry

The browser sends authenticated, bounded diagnostic events through the existing
WebSocket connection. Events include:

- WebSocket open, close, reconnect scheduling
- WebRTC connection and ICE state changes
- selected candidate pair and candidate types
- inbound/outbound audio byte and packet counters
- microphone permission and ended-track errors
- remote audio playback failures
- network mode changes and TURN self-test outcomes

The server removes candidate addresses and credentials, validates event types
and lengths, stores current state in memory, and asynchronously persists events
to Supabase.

## Security

- Supabase secret/service credentials are server-only environment variables.
- MCP requires a dedicated bearer token.
- MCP query tools are bounded by time range and result count.
- `send_notification` only targets configured PTT channels.
- Public diagnostic tables have RLS enabled and no policies for browser roles.
- MCP and telemetry never expose or store SDP, ICE candidate addresses, audio,
  JWTs, TURN credentials, or secrets.
