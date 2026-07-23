# 📻 browser-ptt

A browser-based **push-to-talk walkie-talkie**. Open a web page, sign in, pick a
channel, and **hold to talk** to everyone else on that channel in real time — no
app install required.

Works on **iPhone/iPad (Safari)**, Android, Windows, Mac, and Linux in modern
browsers (Chrome, Edge, Firefox, Safari) — audio runs over **WebRTC**.

## Features

- 🎤 **Push-to-Talk** — hold the button (or the spacebar) to transmit
- 🔊 **Real-time voice** — ~0.2–1 s latency, peer-to-peer over WebRTC
- 👥 **Group channels** — talk to everyone in the same channel
- 📻 **Half-duplex** — one speaker at a time, like a real walkie-talkie
- 📍 **Who's talking** indicator and 🟢 **online list**
- 🔒 **Login + per-user channel permissions** (JWT)
- 🌐 **No install** — just open the page

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

Open the page in **two** tabs or devices, sign in as different users, join the
**same** channel, and hold PTT in one to talk to the other.

**Demo accounts:** `david/d123`, `maggie/m123`
(configure in [`config/users.json`](config/users.json)).

### Configuration

| Env var                | Default                      | Purpose                            |
| ---------------------- | ---------------------------- | ---------------------------------- |
| `PORT`                 | `3000`                       | HTTP/WS port                       |
| `JWT_SECRET`           | value in config file         | overrides the JWT signing secret   |
| `PTT_CONFIG`           | `config/users.json`          | path to an alternate users config  |
| `STUN_URL`             | `stun:stun.l.google.com:19302` | STUN server for WebRTC           |
| `TURN_URL` (+ `_USERNAME`/`_CREDENTIAL`) | –          | TURN relay for strict NATs         |

## How it works

Audio runs **peer-to-peer over WebRTC** (a mesh) — it never passes through the
server. The WebSocket carries only signalling, presence, and floor control. Each
member keeps its mic track connected but muted; the server grants the floor to
one speaker at a time, who unmutes while transmitting. See [`CLAUDE.md`](CLAUDE.md)
for the full architecture.

> **Note:** WebRTC needs a **secure context** — the mic only works over HTTPS (or
> `localhost`). Serve behind HTTPS for real devices.

## Serverless 1-to-1 private call

Open [`/direct.html`](public/direct.html) for a **login-free, signalling-server-free**
one-to-one mode. One person taps *Create invite* and shows a **QR code**; the other
**scans it with their phone camera**, which opens the page and generates a reply.
After that the two browsers are connected **directly** — audio and the PTT control
channel are pure peer-to-peer, and the server is not involved in the call at all (it
only served the page). Copy/paste of the codes works too if you'd rather not scan.

- **QR exchange:** codes are compressed and encoded into a scannable QR (deep
  link). The invite is scanned with the native camera (works on iPhone); reading
  the reply back in-page uses `BarcodeDetector` where available (Chrome/Android),
  otherwise fall back to paste.
- **LAN only** checkbox drops STUN entirely (works within one network with zero
  external servers).
- Across networks it uses a public STUN server for address discovery only.
- It **cannot** use a TURN relay, so it won't connect two peers that are both
  behind symmetric NATs — that genuinely requires a relay server.

## Limitations

- **Mesh scaling** — full-mesh WebRTC is great for small channels but grows as
  ~N² connections; large channels need an **SFU** (roadmap). Half-duplex keeps
  bandwidth modest since only one stream is live at a time.
- **NAT traversal** — STUN only by default; peers behind symmetric NATs need a
  **TURN** server (`TURN_URL`).
- **In-memory state** — resets on restart, single process only.
- **Demo auth** — plaintext seed passwords (hashed at startup); replace before
  production.
- **Not implemented yet:** voice recording/history and video (roadmap).

## License

MIT
