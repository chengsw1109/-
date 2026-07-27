# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## Project overview

**browser-ptt** is a browser-based push-to-talk (PTT) walkie-talkie. Users open a
web page — no app install — sign in, pick a channel, and hold a button to talk to
everyone else in that channel in real time (~0.2–1 s latency).

It is deliberately **half-duplex**, like a real walkie-talkie: within a channel
only one person holds the "floor" (can transmit) at a time. The server is the
authority on who holds the floor, which keeps audio routing simple and
unambiguous.

## Architecture

Audio travels **peer-to-peer over WebRTC** (a mesh). The server never sees audio
— it only relays signalling and enforces the floor. This is what makes iOS
Safari work (its `MediaRecorder`/MediaSource support is too limited for a
server-relayed audio path).

```
Browser (public/)                     Node server (server/)
─────────────────                     ─────────────────────
login form ──POST /api/login────────► auth.js  (JWT + bcrypt, seed users;
                 │  token + iceServers          returns ICE server config)
                 ▼
WebSocket /ws?token=JWT ◄───────────► index.js (express + ws)
  control + WebRTC signalling only       │
  (JSON text; NO audio here)             ▼
                                      rooms.js (presence + floor control +
                                                signalling relay)

audio: Browser ◄══ RTCPeerConnection (mesh, P2P) ══► Browser
```

- **Two planes:**
  - *Signalling/control* over WebSocket (JSON): `join`, `leave`, `talk_start`,
    `talk_stop`, `signal` (WebRTC offer/answer/ICE), `chat` (text message), plus
    server → client `joined`, `peer_joined`, `peer_left`, `speaking`,
    `speaking_end`, `talk_granted`, `talk_denied`, `chat`.
  - *Text chat* rides the WebSocket (server-relayed), deliberately **not** a
    WebRTC data channel — so it still works when the P2P audio path fails (its
    purpose is to tell a peer to switch to 外網/TURN). Messages are broadcast to
    the channel, sanitized and length-capped in `rooms.js`, and escaped before
    DOM insertion in `app.js`.
  - *Media* over WebRTC directly between browsers. No audio bytes pass through
    Node.
- **WebRTC mesh:** on joining a channel, each member opens an
  `RTCPeerConnection` to every other member and publishes its mic track. To
  avoid offer glare, the peer with the greater `peerId` is the initiator. Each
  connection carries an audio track for the whole session.
- **Half-duplex via track muting:** every peer keeps its mic track connected but
  **muted** (`track.enabled = false`). The server grants the floor to one speaker
  at a time; on `talk_granted` that peer unmutes (`enabled = true`), on release it
  re-mutes. Because the track is negotiated once and only toggled, there is **no
  renegotiation on talk** → minimal latency.
- **Floor control (server-authoritative):** `rooms.js` tracks `activeSpeaker` per
  channel. `talk_start` acquires the floor (or `talk_denied` if busy);
  `talk_stop`/disconnect releases it and broadcasts `speaking_end`. This governs
  the UX even though media is P2P — without it, two unmuted peers would be full
  duplex.
- **Peer identity:** each *connection* gets a `peerId` (UUID). Presence/online
  list is by username (deduped); WebRTC routing is by `peerId`.
- **ICE:** the client uses the `iceServers` returned at login. Default is Google
  STUN; a TURN server can be added via env (`TURN_URL`/`TURN_USERNAME`/
  `TURN_CREDENTIAL`, or a dynamic `TURN_CREDENTIALS_URL`). A **內網/外網 (LAN/WAN)
  toggle** in the channel UI lets the client pick per session: LAN mode uses an
  **empty** `iceServers` (host candidates only) so it never touches STUN/TURN or
  the TURN quota; WAN mode uses the server-provided STUN+TURN. The choice is kept
  in `localStorage` and switching rebuilds the peer connections.
- **Auth:** `POST /api/login` verifies seed users and returns a JWT (+ allowed
  channels + ICE config). The WS authenticates via `?token=` in the URL. Channel
  access is per user (`channels` allowlist, or `"*"`).

There is **no database and no media server** — all channel/presence/floor state
is in memory and resets on restart.

### Two modes

1. **Channels (default, `/`)** — the login + channel walkie-talkie described
   above. The server does signalling, presence, and floor control; audio is a
   WebRTC mesh.
2. **Serverless 1-to-1 (`/direct.html`)** — no login and **no signalling
   server**. Two browsers connect by exchanging offer/answer "codes" out-of-band,
   via **QR** or copy/paste. Audio and a PTT control `RTCDataChannel` are pure
   P2P; the Node server only serves the static file. It shares `style.css` but is
   otherwise independent of `app.js`/`server`.
   - **Codes** are `deflate-raw` compressed (`CompressionStream`, with a plain
     base64 fallback) then base64url'd, so they fit in a scannable QR. The QR
     encodes a deep link `…/direct.html#o=<code>` (offer) / `#a=<code>` (answer).
   - **QR encoder** is vendored at `public/vendor/qrcode.js` (byte-mode, adapted
     from Nayuki, MIT). Its correctness is verified by decoding its output with
     `jsQR` (a dev-only dep) — see the round-trip check when changing it.
   - **Scanning:** the invite QR is opened with the phone's **native camera**
     (works on iOS), which loads the deep link and pre-fills the callee screen.
     Reading the reply back into the caller's existing tab needs an in-page
     `BarcodeDetector` (Chrome/Android); iOS Safari lacks it, so the reply falls
     back to copy/paste. The second handshake message must land in the tab that
     created the offer, so it can never come via a fresh deep-link navigation.
   - ICE gathering is non-trickle (bundled into the code); a "LAN only" toggle
     drops STUN. This mode **cannot use TURN**, so it can't traverse symmetric
     NATs — documented honestly in the UI.

## Repository structure

```
browser-ptt/
├── server/
│   ├── index.js     # express app + HTTP + WebSocket server; message router
│   ├── config.js    # loads config/users.json (+ env), builds iceServers list
│   ├── auth.js       # seed-user store, bcrypt hashing, JWT sign/verify, channel ACL
│   └── rooms.js      # in-memory channels: presence, floor control, WebRTC signalling relay
├── public/           # static client (served as-is, no build step)
│   ├── index.html    # login screen + app screen + hidden audio sink
│   ├── style.css     # dark UI, big round PTT button
│   ├── app.js        # login, WS signalling, WebRTC mesh, PTT mic toggle, presence UI
│   ├── direct.html   # serverless 1-to-1 mode (no login)
│   ├── direct.js     # offer/answer exchange (QR or paste); P2P audio + PTT data channel
│   └── vendor/
│       └── qrcode.js # vendored byte-mode QR encoder (adapted from Nayuki, MIT)
├── config/
│   └── users.json    # jwtSecret, channels, and seed users (DEMO passwords)
├── package.json      # ESM ("type":"module"); start / dev scripts
└── CLAUDE.md
```

## Development workflow

Verified commands (Node ≥ 18; developed on Node 22):

```bash
npm install        # install express, ws, jsonwebtoken, bcryptjs
npm start          # run the server on http://localhost:3000
npm run dev        # same, with --watch auto-reload
```

Then open `http://localhost:3000` in **two** browser tabs, sign in as different
demo users, join the **same** channel, and hold the PTT button in one to talk to
the other. (`localhost` is a secure context, so the mic works without HTTPS.)

**Testing across real devices/networks:** WebRTC requires a **secure context** —
`getUserMedia` only works over HTTPS (or localhost). Serve behind an HTTPS
reverse proxy / tunnel for phones and remote peers. Peers behind strict
(symmetric) NATs also need a **TURN** server; STUN alone won't connect them.

**Demo accounts** (from `config/users.json`): `david/d123` (admin, all channels),
`maggie/m123` (all channels). The UI is Traditional Chinese (`zh-Hant`); channel
display names live in `config/users.json` (`一般`, `A 組`, `B 組`).

**Config / env overrides** (read in `server/config.js`): `PORT`, `JWT_SECRET`,
`PTT_CONFIG` (alternate users config path), `STUN_URL`,
`TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL`, and `TURN_CREDENTIALS_URL`.
`server/config.js` also loads a root **`.env`** (KEY=VALUE) at startup if present
— no dependency, no Node flag, so `npm start` picks it up on any Node ≥ 18; real
environment variables still win. `.env` is gitignored; see `.env.example`.

There is no linter or build step. To sanity-check the server manually:
`curl localhost:3000/api/health` and
`curl -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"username":"david","password":"d123"}'`.

**WAN audio test** — `npm run test:wan` (`test/wan-audio.mjs`) is a self-contained
end-to-end check of the 外網 path: it starts a real TURN server (`node-turn`),
launches two headless browsers (`playwright-core`) forced to **relay-only** so
media must traverse TURN, and asserts each side receives the other's audio via
`getStats`. Dev-only deps; needs a Chromium at `$CHROMIUM_PATH`. Use it to prove
the client 外網 media path works — a real-world "no sound on 外網" then points at
the TURN service/credentials, not the code.

## Key conventions

- **ES modules everywhere** (`"type": "module"`). Use `import`, not `require`.
- **No frontend framework and no bundler.** `public/` is plain HTML/CSS/JS served
  statically. Keep it dependency-free; don't introduce a build step without a
  strong reason. If client code genuinely needs a library (e.g. the QR encoder),
  **vendor a single self-contained file** under `public/vendor/` — no CDN/import
  (the app must work offline and under a strict CSP). Verification-only tooling
  (like `jsqr`) belongs in `devDependencies`, never shipped to the client.
- **The server owns the floor.** Never let a client assume it may transmit —
  always wait for `talk_granted`. Any change to who-can-talk logic belongs in
  `rooms.js`, not the client.
- **Audio is P2P (WebRTC), never through the server.** The WebSocket carries
  control + signalling only. Don't reintroduce a server audio relay.
- **Toggle, don't renegotiate.** PTT changes `track.enabled`, not the set of
  tracks — this keeps talk latency to just the RTP path. Avoid add/removeTrack on
  talk (it forces SDP renegotiation).
- **`peerId` for WebRTC routing, username for the UI.** Presence dedupes by
  username; signalling addresses connections by `peerId`.
- Escape any user-derived text before inserting into the DOM (see
  `escapeHtml` in `app.js`).

## Known limitations & roadmap

Be honest about these in code and docs — do not claim features that aren't real.

- **iOS Safari: supported** via the WebRTC path (this is why we use WebRTC rather
  than MediaRecorder+MediaSource). Requires HTTPS on real devices, and remote
  audio playback may need the one-time "Tap to enable audio" fallback the client
  shows when autoplay is blocked.
- **Mesh scaling**: full-mesh WebRTC means every pair of members holds a
  connection (~N² connections, and each speaker uploads to N−1 peers). Fine for
  small channels; large channels need an **SFU** (mediasoup / LiveKit / Janus) —
  the main roadmap item. Half-duplex keeps bandwidth modest (only one real audio
  stream at a time), which softens but does not remove this limit.
- **NAT traversal**: STUN only by default. Peers behind symmetric NATs need a
  **TURN** server (`TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL`).
- **In-memory state**: presence/floor reset on restart and don't span multiple
  processes. Multi-instance needs shared state (e.g. Redis) for signalling.
- **Demo auth**: seed users with plaintext passwords in `config/users.json`
  (hashed at startup). Replace with a real user store + signup before production.
- **Not yet implemented (intentionally deferred):** voice recording/history and
  video. Do not add these silently — they are future work.

## For AI assistants

- When you change the WS protocol, update **both** `server/` (router in
  `index.js`, logic in `rooms.js`) **and** `public/app.js`, and refresh the
  protocol description in this file.
- Prefer extending `rooms.js` for anything about channels/presence/floor/
  signalling relay; it is the single source of truth for real-time state.
- Signalling and floor logic can be verified with a scripted `ws` client (no
  browser needed). The actual **media path (offer/answer/ICE/track)** can only be
  verified in real browsers — do the two-tab manual test after WebRTC changes.
