# 🎨 MemeDrip

> Ultra-low-latency Discord-to-Desktop media overlay. Trigger images, GIFs, video, and audio via Discord slash commands — rendered instantly on a target user's screen through a transparent, click-through desktop overlay.

## Architecture

```
┌──────────────┐     slash command      ┌─────────────────────────────┐
│  Discord     │ ─────────────────────▶ │  Backend (Node.js)          │
│  User        │                        │  ├─ Discord Bot (discord.js)│
└──────────────┘                        │  └─ WebSocket Relay (ws)    │
                                        │     in-memory client map    │
                                        └──────────┬──────────────────┘
                                                   │ WS push (MediaPayload)
                                                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Desktop Client (Tauri 2.0 + React)                          │
│  ├─ WebSocket client (exponential backoff reconnect)          │
│  ├─ Smart Queue Engine (Zustand) — sequential playback       │
│  └─ Transparent, borderless, always-on-top, click-through    │
└──────────────────────────────────────────────────────────────┘
```

### V1 Design Decisions
- **Single-process backend**: The Discord bot and WebSocket relay share one Node.js process. Zero IPC overhead → sub-millisecond fan-out. When you need to scale, extract the relay and use Redis Pub/Sub.
- **Deterministic auth tokens**: `sha256(RELAY_AUTH_SECRET : discordId)`. For production, replace with Discord OAuth token exchange.
- **Click-through**: Achieved at two levels — Tauri's `set_ignore_cursor_events(true)` in Rust + CSS `pointer-events: none`.

## Monorepo Structure

```
memedrip/
├── package.json              # npm workspaces root
├── tsconfig.base.json        # shared TS config
├── .env.example              # backend env vars
├── packages/
│   └── shared-types/         # @memedrip/shared-types
│       └── src/index.ts      # MediaPayload, RelayMessage, guards
├── apps/
│   ├── bot/                  # @memedrip/bot (Discord + WS relay)
│   │   ├── src/index.ts      # bot + relay server
│   │   ├── Dockerfile        # multi-stage build
│   │   └── docker-compose.yml
│   └── overlay/              # @memedrip/overlay (Tauri desktop client)
│       ├── src-tauri/        # Rust backend
│       │   ├── src/lib.rs    # window setup, click-through
│       │   ├── src/main.rs   # entry point
│       │   ├── Cargo.toml
│       │   └── tauri.conf.json
│       ├── src/              # React frontend
│       │   ├── App.tsx
│       │   ├── OverlayEngine.tsx   # media renderer
│       │   ├── useMediaQueue.ts    # Zustand smart queue store
│       │   ├── useWebSocket.ts     # resilient WS client
│       │   └── index.css
│       ├── index.html
│       ├── vite.config.ts
│       └── tailwind.config.js
```

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 18 | Backend + frontend build |
| npm | ≥ 9 | Workspace management |
| Rust | ≥ 1.77 | Tauri desktop client |
| Docker | ≥ 24 | Backend deployment (optional) |
| Discord Bot Token | — | [Developer Portal](https://discord.com/developers/applications) |

## Setup & Build Instructions

### 1. Clone & install dependencies

```bash
git clone <your-repo-url> memedrip
cd memedrip
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your Discord bot token, client ID, and a random secret
```

Create a Discord application at https://discord.com/developers/applications, create a bot, copy the token into `DISCORD_TOKEN`, and the application ID into `DISCORD_CLIENT_ID`.

For guild-scoped (instant) command registration, set `DISCORD_GUILD_ID` to your test server's ID. Leave blank for global commands (propagates in ~1 hour).

### 3. Build shared types

```bash
npm run build:shared
```

### 4A. Run the backend (development)

```bash
npm run dev:bot
```

This runs the bot with `tsx watch` for hot reload.

### 4B. Deploy the backend with Docker

```bash
cd apps/bot
docker compose up -d --build
```

The WebSocket relay listens on port `7878` (configurable via `WS_PORT`).

### 5. Build & run the desktop overlay client

#### Prerequisites for Tauri
- **Windows**: install [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)
- **Linux**: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
- **macOS**: install Xcode Command Line Tools

#### Configure overlay env

```bash
cd apps/overlay
cp .env.example .env
```

Generate your auth token:

```bash
node -e "const c=require('crypto');const h=c.createHash('sha256');h.update('YOUR_RELAY_AUTH_SECRET:YOUR_DISCORD_ID');console.log(h.digest('hex'))"
```

Set `VITE_AUTH_TOKEN` to the output, `VITE_DISCORD_ID` to your Discord user ID, and `VITE_WS_URL` to your relay server.

#### Development mode

```bash
cd apps/overlay
npm install   # if not already installed at root
npx tauri dev
```

#### Production build

```bash
cd apps/overlay
npx tauri build
```

This produces a platform installer (`.msi` on Windows, `.deb`/`.AppImage` on Linux).

## Usage

1. Start the backend (bot + relay).
2. Start the Tauri overlay client — it connects to the relay and sits as a transparent overlay on your screen.
3. In Discord, use the slash commands:

### `/drop`
Drop media onto a target user's screen.
```
/drop media_url:https://example.com/meme.gif target:@user type:gif duration:5
```
| Parameter | Required | Description |
|-----------|----------|-------------|
| `media_url` | ✅ | Direct URL to image/GIF/video/audio |
| `target` | ✅ | Discord user to receive the drop |
| `type` | ❌ | `image` / `gif` / `video` / `audio` (auto-detected) |
| `duration` | ❌ | Seconds (1–60, default 5) |

### `/react`
Flash a large emoji on a target's screen.
```
/react emoji:🔥 target:@user duration:3
```
| Parameter | Required | Description |
|-----------|----------|-------------|
| `emoji` | ✅ | Unicode emoji or Discord custom emoji |
| `target` | ✅ | Discord user to receive the reaction |
| `duration` | ❌ | Seconds (1–30, default 3) |

## Smart Queue Engine

When multiple drops arrive simultaneously, they are queued FIFO and played sequentially to prevent visual overlap:

- **Default duration**: 5 seconds per media item
- **Dedup**: Payloads with duplicate IDs are ignored
- **Auto-advance**: Timer-based shift when duration expires
- **Skip**: `skip()` immediately advances to the next item
- **Fade**: 150ms CSS fade-out before the queue advances

## Network Resilience

The desktop WebSocket client implements:
- **Exponential backoff**: 1s → 2s → 4s → … → 30s (max)
- **Heartbeat**: ping/pong every 25s; dead connections are swept
- **Auth gate**: 10s timeout; closes connection on auth failure

## Performance Notes

- The overlay window is **hardware-accelerated** via WebView2/WebKitGTK
- CSS animations use `transform` and `opacity` only (GPU-composited, no repaint)
- `will-change: transform, opacity` hints the compositor
- The overlay process is lightweight — typically < 50MB RAM, near-zero CPU when idle
- `pointer-events: none` + `set_ignore_cursor_events(true)` = zero input overhead during gaming

## Security

- Media URLs are validated: HTTPS/HTTP only, whitelisted extensions
- Auth tokens use constant-time comparison
- The overlay window prevents accidental close (Alt+F4 blocked)
- Non-root Docker user in production image

## License

MIT
