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

```
Browser (public/)                 Node server (server/)
─────────────────                 ─────────────────────
login form ──POST /api/login──►   auth.js   (JWT + bcrypt, seed users)
                 │  token
                 ▼
WebSocket /ws?token=JWT ◄──────►  index.js  (express + ws, signalling)
  • control msgs (JSON text)        │
  • audio frames  (binary)          ▼
                                  rooms.js  (presence + floor control + relay)
```

- **Transport:** a single WebSocket per client carries both **control messages**
  (JSON text: `join`, `talk_start`, `talk_stop`, presence/speaking events) and
  **audio** (binary frames). The server distinguishes them via the `isBinary`
  flag.
- **Audio pipeline:** the browser captures the mic with `getUserMedia`, encodes
  with `MediaRecorder` (Opus in a WebM container) into ~200 ms chunks, and sends
  each chunk as a binary WS frame. The server forwards frames from the current
  floor holder to every *other* member of the channel. Receivers play a
  continuous stream via **Media Source Extensions** (`MediaSource` +
  `SourceBuffer`, one per transmission).
- **Floor control (half-duplex):** `rooms.js` tracks `activeSpeaker` per channel.
  `talk_start` acquires the floor (or is `talk_denied` if busy); only the floor
  holder's binary frames are relayed; `talk_stop`/disconnect release it and
  broadcast `speaking_end`.
- **Auth:** `POST /api/login` verifies against seed users and returns a JWT. The
  WS connection authenticates by passing that token in the query string
  (`/ws?token=…`). Channel access is enforced per user (`channels` allowlist, or
  `"*"` for all).

There is **no database and no external service** — all channel/presence/floor
state is in memory and resets when the server restarts.

## Repository structure

```
browser-ptt/
├── server/
│   ├── index.js     # express app + HTTP server + WebSocket server; message router
│   ├── config.js    # loads config/users.json (+ env overrides), exports config
│   ├── auth.js       # seed-user store, bcrypt hashing, JWT sign/verify, channel ACL
│   └── rooms.js      # in-memory channels: presence, floor control, audio relay
├── public/           # static client (served as-is, no build step)
│   ├── index.html    # login screen + app screen
│   ├── style.css     # dark UI, big round PTT button
│   └── app.js        # login, WS client, PTT capture, MSE playback, presence UI
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

Then open `http://localhost:3000` in **two** browser tabs/devices, sign in as
different demo users, join the **same** channel, and hold the PTT button in one
to talk to the other.

**Demo accounts** (from `config/users.json`): `admin/admin123` (all channels),
`alice/alice123` (general, team-a), `bob/bob123` (general, team-b).

**Config / env overrides:** `PORT`, `JWT_SECRET`, and `PTT_CONFIG` (path to an
alternate users config) are read in `server/config.js`.

There is **no test suite, linter, or build step** yet. To sanity-check the
server manually: `curl localhost:3000/api/health` and
`curl -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"username":"alice","password":"alice123"}'`.

## Key conventions

- **ES modules everywhere** (`"type": "module"`). Use `import`, not `require`.
- **No frontend framework and no bundler.** `public/` is plain HTML/CSS/JS served
  statically. Keep it dependency-free; don't introduce a build step without a
  strong reason.
- **The server owns the floor.** Never let a client assume it may transmit —
  always wait for `talk_granted`. Any change to who-can-talk logic belongs in
  `rooms.js`, not the client.
- **Two message planes on one socket:** JSON text = control, binary = audio.
  Preserve this split; don't base64 audio into JSON (it defeats the low-latency
  goal).
- **Keep latency low:** the ~200 ms `MediaRecorder` timeslice is the main
  latency knob. Smaller = lower latency but more overhead.
- Escape any user-derived text before inserting into the DOM (see
  `escapeHtml` in `app.js`).

## Known limitations & roadmap

Be honest about these in code and docs — do not claim features that aren't real.

- **iOS Safari** is the weak spot. Safari's `MediaRecorder` produces MP4 (not
  WebM/Opus) and its audio-only **MediaSource** support is limited, so live
  playback may not work there. The client feature-detects and shows a warning.
  Proper iPhone support needs a **WebRTC (SFU)** path — this is the main roadmap
  item.
- **In-memory state**: everything resets on restart and does not scale beyond a
  single process. A real deployment needs shared state (e.g. Redis) and/or an
  SFU.
- **Demo auth**: seed users with plaintext passwords in `config/users.json`
  (hashed at startup). Replace with a real user store + signup before production.
- **Not yet implemented (intentionally deferred):** voice recording/history and
  video. Do not add these silently — they are future work.

## For AI assistants

- When you change the WS protocol, update **both** `server/` (router in
  `index.js`, logic in `rooms.js`) **and** `public/app.js`, and refresh the
  protocol description in this file.
- Prefer extending `rooms.js` for anything about channels/presence/floor; it is
  the single source of truth for real-time state.
- After any meaningful change, re-verify with the two-tab manual test above (or a
  scripted `ws` client) — the relay + floor logic is the heart of the app.
