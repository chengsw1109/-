# 📻 browser-ptt

A browser-based **push-to-talk walkie-talkie**. Open a web page, sign in, pick a
channel, and **hold to talk** to everyone else on that channel in real time — no
app install required.

Works on Android, Windows, Mac, and Linux in modern browsers (Chrome, Edge,
Firefox). See [iOS Safari](#limitations) below.

## Features

- 🎤 **Push-to-Talk** — hold the button (or the spacebar) to transmit
- 🔊 **Real-time voice** — ~0.2–1 s latency over WebSocket
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

**Demo accounts:** `admin/admin123`, `alice/alice123`, `bob/bob123`
(configure in [`config/users.json`](config/users.json)).

### Configuration

| Env var      | Default              | Purpose                          |
| ------------ | -------------------- | -------------------------------- |
| `PORT`       | `3000`               | HTTP/WS port                     |
| `JWT_SECRET` | value in config file | overrides the JWT signing secret |
| `PTT_CONFIG` | `config/users.json`  | path to an alternate users config |

## How it works

The browser captures the mic (`getUserMedia`), encodes Opus/WebM chunks with
`MediaRecorder`, and streams them as binary WebSocket frames. The server relays
frames from the current floor holder to the rest of the channel; receivers play a
continuous stream via Media Source Extensions. The server enforces one speaker
per channel. See [`CLAUDE.md`](CLAUDE.md) for the full architecture.

## Limitations

- **iOS Safari**: live playback may not work (limited audio MediaSource/WebM
  support). The client warns when it detects this. Full iPhone support is planned
  via a WebRTC (SFU) path.
- **In-memory state** — resets on restart, single process only.
- **Demo auth** — plaintext seed passwords (hashed at startup); replace before
  production.
- **Not implemented yet:** voice recording/history and video (roadmap).

## License

MIT
