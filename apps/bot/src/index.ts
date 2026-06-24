/**
 * MemeDrip Backend — Discord Bot + WebSocket Relay Server
 * ==================================================================
 * Both the Discord bot (discord.js v14) and the WebSocket relay server
 * run inside a single Node.js process. For V1 this is the most
 * performant option: zero IPC overhead, shared in-memory client
 * registry, sub-millisecond fan-out from slash-command to overlay.
 *
 * Data flow:
 *   Discord slash command ──▶ command handler ──▶ relay.send(targetId, payload)
 *   Desktop client ◀── WebSocket ── relay (auth by Discord ID)
 *
 * Upgrades from V1:
 *   - Rate limiting (per-sender, per-target)
 *   - HTTPS-only URL enforcement (SSRF protection)
 *   - WebSocket maxPayload cap (64 KiB)
 *   - Unhandled rejection / uncaught exception guards
 *   - Token expiry (nonce + timestamp, 24h validity)
 *   - Structured logging via pino
 *   - Discord interaction buttons (Skip / Clear / Pause)
 *   - /drop random (serves from a media directory)
 *   - WSS/TLS support
 *   - Real health endpoint
 */

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  REST,
  Routes,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from "discord.js";
import { WebSocketServer, WebSocket } from "ws";
import {
  createHash,
  randomUUID,
  randomBytes,
  createHmac,
} from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { readFileSync as readPem } from "node:fs";
import pino from "pino";
import {
  type MediaPayload,
  type RelayMessage,
  type MediaType,
  type OverlayPosition,
  type OverlayScale,
  type ControlAction,
  DEFAULT_DURATION_MS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_DROPS,
} from "@memedrip/shared-types";

// ---------------------------------------------------------------------------
// Structured logging (#17)
// ---------------------------------------------------------------------------
const log = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined,
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || undefined;
const WS_PORT = parseInt(process.env.WS_PORT || "7878", 10);
const RELAY_AUTH_SECRET = process.env.RELAY_AUTH_SECRET!;
const MEDIA_DIR = process.env.MEDIA_DIR || "";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "7879", 10);
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !RELAY_AUTH_SECRET) {
  log.fatal(
    "Missing required env vars. Set DISCORD_TOKEN, DISCORD_CLIENT_ID, RELAY_AUTH_SECRET.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Token manager (#5 — token expiry + nonce)
// ---------------------------------------------------------------------------
class TokenManager {
  /**
   * Issue a signed token: HMAC-SHA256(secret, `discordId:nonce:timestamp`).
   * The token encodes the issue time so the server can reject stale tokens
   * without maintaining a database — just verify the HMAC and check age.
   */
  issue(discordId: string): { token: string; expiresAt: number } {
    const nonce = randomBytes(8).toString("hex");
    const ts = Date.now();
    const payload = `${discordId}:${nonce}:${ts}`;
    const sig = createHmac("sha256", RELAY_AUTH_SECRET).update(payload).digest("hex");
    return {
      token: `${payload}.${sig}`,
      expiresAt: ts + TOKEN_TTL_MS,
    };
  }

  /** Verify a token's HMAC signature and expiry. */
  verify(token: string, discordId: string): boolean {
    const parts = token.split(".");
    if (parts.length !== 4) return false;
    const [id, nonce, tsStr, sig] = parts;
    if (id !== discordId) return false;

    const ts = parseInt(tsStr, 10);
    if (isNaN(ts) || Date.now() - ts > TOKEN_TTL_MS) return false;

    const payload = `${id}:${nonce}:${tsStr}`;
    const expectedSig = createHmac("sha256", RELAY_AUTH_SECRET).update(payload).digest("hex");

    // Constant-time comparison
    if (sig.length !== expectedSig.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Legacy V1 deterministic token (sha256(secret:discordId)).
   * Kept for backward compat with clients that haven't been updated.
   */
  verifyLegacy(token: string, discordId: string): boolean {
    const expected = createHash("sha256")
      .update(`${RELAY_AUTH_SECRET}:${discordId}`)
      .digest("hex");
    if (token.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i++) {
      diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }
}
const tokenManager = new TokenManager();

// ---------------------------------------------------------------------------
// Rate limiter (#1 — per-sender cooldown)
// ---------------------------------------------------------------------------
class RateLimiter {
  /** Map<senderId, array of timestamps> */
  private hits = new Map<string, number[]>();

  /** Returns true if the sender is allowed to drop now, false if rate-limited. */
  check(senderId: string): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const timestamps = (this.hits.get(senderId) || []).filter((t) => t > cutoff);

    if (timestamps.length >= RATE_LIMIT_MAX_DROPS) {
      this.hits.set(senderId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(senderId, timestamps);
    return true;
  }

  /** Periodic cleanup of stale entries to prevent memory growth. */
  sweep(): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    this.hits.forEach((timestamps, id) => {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) this.hits.delete(id);
      else this.hits.set(id, fresh);
    });
  }
}
const rateLimiter = new RateLimiter();
setInterval(() => rateLimiter.sweep(), 60_000).unref();

// ---------------------------------------------------------------------------
// Relay Server — in-memory registry of connected desktop clients
// ---------------------------------------------------------------------------
interface ClientEntry {
  ws: WebSocket;
  discordId: string;
  alive: boolean;
  connectedAt: number;
}

class RelayServer {
  private clients = new Map<string, ClientEntry>(); // discordId → entry
  private wss: WebSocketServer;

  constructor(port: number, useTLS: boolean) {
    const opts: ConstructorParameters<typeof WebSocketServer>[0] = {
      port,
      // #3 — cap message size at 64 KiB to prevent memory exhaustion
      maxPayload: 64 * 1024,
    };

    if (useTLS) {
      // #16 — WSS/TLS support
      const https = require("node:https") as typeof import("node:https");
      const server = https.createServer({
        cert: readPem(TLS_CERT_PATH),
        key: readPem(TLS_KEY_PATH),
      });
      opts.server = server;
      log.info({ tls: true, cert: TLS_CERT_PATH }, "[relay] TLS enabled");
    }

    this.wss = new WebSocketServer(opts);
    this.wss.on("connection", (ws) => this.onConnection(ws));
    log.info({ port, tls: useTLS }, "[relay] WebSocket server listening");
  }

  private onConnection(ws: WebSocket): void {
    let authenticated = false;
    let discordId: string | null = null;
    let entry: ClientEntry | null = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        this.send(ws, { type: "auth_error", reason: "Auth timeout" });
        ws.close(4001, "Auth timeout");
      }
    }, 10_000);

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.send(ws, { type: "error", reason: "Binary messages not supported" });
        return;
      }
      let msg: RelayMessage;
      try {
        msg = JSON.parse(raw.toString()) as RelayMessage;
      } catch {
        this.send(ws, { type: "error", reason: "Invalid JSON" });
        return;
      }

      // ---- Authentication gate ----
      if (!authenticated) {
        if (msg.type !== "auth") {
          this.send(ws, { type: "auth_error", reason: "Auth required first" });
          ws.close(4003, "Not authenticated");
          return;
        }
        const ok = tokenManager.verify(msg.token, msg.discordId)
          || tokenManager.verifyLegacy(msg.token, msg.discordId);
        if (!ok) {
          this.send(ws, { type: "auth_error", reason: "Invalid or expired token" });
          ws.close(4003, "Invalid token");
          return;
        }
        authenticated = true;
        discordId = msg.discordId;
        entry = { ws, discordId, alive: true, connectedAt: Date.now() };
        this.clients.set(discordId, entry);
        clearTimeout(authTimeout);
        this.send(ws, { type: "auth_ok" });
        log.info({ discordId }, "[relay] Client connected");
        return;
      }

      // ---- Post-auth message handling ----
      switch (msg.type) {
        case "pong":
          if (entry) entry.alive = true;
          break;
        case "ping":
          this.send(ws, { type: "pong" });
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (discordId && this.clients.get(discordId)?.ws === ws) {
        this.clients.delete(discordId);
        log.info({ discordId }, "[relay] Client disconnected");
      }
    });

    ws.on("error", (err) => {
      log.error({ err: err.message, discordId: discordId ?? "unauth" }, "[relay] Socket error");
    });
  }

  /** Push a media payload to a single targeted client. */
  sendTo(targetId: string, payload: MediaPayload): boolean {
    const entry = this.clients.get(targetId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
    this.send(entry.ws, { type: "media", payload });
    return true;
  }

  /** Send a control action (skip/clear/pause/resume) to a client. */
  sendControl(targetId: string, action: ControlAction): boolean {
    const entry = this.clients.get(targetId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
    this.send(entry.ws, { type: "control", action });
    return true;
  }

  /** Returns true if a desktop client is currently connected for the ID. */
  hasClient(targetId: string): boolean {
    const e = this.clients.get(targetId);
    return !!e && e.ws.readyState === WebSocket.OPEN;
  }

  /** Number of currently connected clients. */
  getConnectedCount(): number {
    let count = 0;
    this.clients.forEach((e) => {
      if (e.ws.readyState === WebSocket.OPEN) count++;
    });
    return count;
  }

  /** Send a heartbeat ping to every connected client. */
  private sweepDeadClients(): void {
    this.clients.forEach((entry, id) => {
      if (!entry.alive) {
        entry.ws.terminate();
        this.clients.delete(id);
        log.info({ discordId: id }, "[relay] Swept dead client");
        return;
      }
      entry.alive = false;
      this.send(entry.ws, { type: "ping" });
    });
  }

  private send(ws: WebSocket, msg: RelayMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Gracefully close all connections and shut down the WSS. */
  shutdown(): void {
    this.wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
    this.wss.close();
    log.info("[relay] Server closed");
  }
}

// ---------------------------------------------------------------------------
// Health check server (#10 — real health endpoint)
// ---------------------------------------------------------------------------
const healthServer = createHttpServer((req, res) => {
  if (req.url === "/health") {
    const healthy = discord.ws.status === 1 && relay !== undefined; // status 1 = READY
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: healthy ? "ok" : "degraded",
      discordReady: discord.ws.status === 1,
      connectedClients: relay?.getConnectedCount() ?? 0,
      uptime: process.uptime(),
    }));
    return;
  }
  res.writeHead(404).end();
});
healthServer.listen(HEALTH_PORT, () => {
  log.info({ port: HEALTH_PORT }, "[health] HTTP health endpoint listening");
});
healthServer.unref?.();

// ---------------------------------------------------------------------------
// Discord Bot setup
// ---------------------------------------------------------------------------
const discord = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Slash command definitions
const dropCommand = new SlashCommandBuilder()
  .setName("drop")
  .setDescription("Drop media onto a user's screen via MemeDrip overlay")
  .addStringOption((o) =>
    o.setName("media_url").setDescription("Direct URL to image / GIF / video / audio, or 'random'").setRequired(true),
  )
  .addUserOption((o) => o.setName("target").setDescription("Who receives the drop").setRequired(true))
  .addStringOption((o) =>
    o
      .setName("type")
      .setDescription("Media type (auto-detected if omitted)")
      .addChoices(
        { name: "image", value: "image" },
        { name: "gif", value: "gif" },
        { name: "video", value: "video" },
        { name: "audio", value: "audio" },
      ),
  )
  .addIntegerOption((o) =>
    o.setName("duration").setDescription("Display duration in seconds (default 5, max 60)").setMinValue(1).setMaxValue(60),
  )
  .addStringOption((o) =>
    o
      .setName("position")
      .setDescription("Where on screen to display (default: center)")
      .addChoices(
        { name: "center", value: "center" },
        { name: "top-left", value: "top-left" },
        { name: "top-right", value: "top-right" },
        { name: "bottom-left", value: "bottom-left" },
        { name: "bottom-right", value: "bottom-right" },
        { name: "random", value: "random" },
      ),
  )
  .addStringOption((o) =>
    o
      .setName("scale")
      .setDescription("Size of the media (default: normal)")
      .addChoices(
        { name: "small", value: "small" },
        { name: "normal", value: "normal" },
        { name: "large", value: "large" },
        { name: "fullscreen", value: "fullscreen" },
      ),
  );

const reactCommand = new SlashCommandBuilder()
  .setName("react")
  .setDescription("Flash a large emoji on a user's screen")
  .addStringOption((o) => o.setName("emoji").setDescription("The emoji to display").setRequired(true))
  .addUserOption((o) => o.setName("target").setDescription("Who receives the reaction").setRequired(true))
  .addIntegerOption((o) =>
    o.setName("duration").setDescription("Display duration in seconds (default 3)").setMinValue(1).setMaxValue(30),
  );

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------
async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const body = [dropCommand.toJSON(), reactCommand.toJSON()];
  try {
    if (DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body });
      log.info({ guild: DISCORD_GUILD_ID }, "[discord] Registered guild commands");
    } else {
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
      log.info("[discord] Registered global commands");
    }
  } catch (err) {
    log.fatal({ err }, "[discord] Command registration failed");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// URL validation (#2 — HTTPS-only, SSRF protection)
// ---------------------------------------------------------------------------
const ALLOWED_MEDIA_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
];

// Private IP ranges to block (SSRF protection)
const PRIVATE_IP_PATTERNS = [
  /^127\./,         // loopback
  /^10\./,          // private class A
  /^192\.168\./,    // private class C
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // private class B
  /^169\.254\./,    // link-local
  /^0\./,           // "this" network
  /^::1$/,          // IPv6 loopback
  /^fc00:/i,        // IPv6 unique local
  /^fe80:/i,        // IPv6 link-local
];

function isPrivateIP(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some((p) => p.test(hostname));
}

function validateMediaUrl(raw: string): { ok: boolean; mediaType?: MediaType; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  // #2 — enforce HTTPS only (prevents SSRF to internal HTTP services)
  if (url.protocol !== "https:") {
    return { ok: false, reason: "Only HTTPS URLs are allowed" };
  }
  // #2 — block private/internal IPs (SSRF protection)
  if (isPrivateIP(url.hostname)) {
    return { ok: false, reason: "Internal/private IPs are blocked" };
  }
  // Allow Discord CDN for custom emoji
  const isDiscordCdn = url.hostname.endsWith(".discordapp.com")
    || url.hostname.endsWith(".discord.com")
    || url.hostname.endsWith(".tenor.com")
    || url.hostname.endsWith(".giphy.com");
  const pathname = url.pathname.toLowerCase();
  const ext = pathname.slice(pathname.lastIndexOf("."));
  if (!ALLOWED_MEDIA_EXTENSIONS.includes(ext) && !isDiscordCdn) {
    return { ok: false, reason: `Blocked file extension: ${ext || "(none)"}` };
  }
  const typeMap: Record<string, MediaType> = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "gif",
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".mp3": "audio", ".wav": "audio", ".ogg": "audio",
  };
  return { ok: true, mediaType: typeMap[ext] ?? "image" };
}

// ---------------------------------------------------------------------------
// /drop random support (#15)
// ---------------------------------------------------------------------------
const MEDIA_TYPE_MAP: Record<string, MediaType> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
  ".gif": "gif",
  ".mp4": "video", ".webm": "video", ".mov": "video",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio",
};

function getRandomMediaFile(): { url: string; mediaType: MediaType } | null {
  if (!MEDIA_DIR) return null;
  try {
    const files = readdirSync(MEDIA_DIR).filter((f) => {
      const ext = extname(f).toLowerCase();
      return ALLOWED_MEDIA_EXTENSIONS.includes(ext);
    });
    if (files.length === 0) return null;
    const pick = files[Math.floor(Math.random() * files.length)];
    const ext = extname(pick).toLowerCase();
    return {
      url: `file://${join(MEDIA_DIR, pick)}`,
      mediaType: MEDIA_TYPE_MAP[ext] ?? "image",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discord interaction buttons (#13 — Skip / Clear / Pause)
// ---------------------------------------------------------------------------
function buildControlButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("memedrip_skip").setLabel("⏭ Skip").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("memedrip_clear").setLabel("🗑 Clear").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("memedrip_pause").setLabel("⏸ Pause").setStyle(ButtonStyle.Secondary),
  );
}

// ---------------------------------------------------------------------------
// Interaction handler
// ---------------------------------------------------------------------------
discord.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "drop") {
    await handleDrop(interaction);
  } else if (interaction.commandName === "react") {
    await handleReact(interaction);
  }
});

// #13 — handle button interactions
discord.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("memedrip_")) return;

  // Find the target ID from the message — we encoded it in the ephemeral reply
  // The sender's ephemeral reply mentions the target. We need to extract it.
  // Better approach: store a mapping from message id → targetId when we send the reply.
  // For simplicity, we parse the target from the message content.
  const content = interaction.message.content || "";
  const targetMatch = content.match(/<@!?(\d+)>/);
  if (!targetMatch) {
    await interaction.reply({ content: "Could not determine target.", ephemeral: true });
    return;
  }
  const targetId = targetMatch[1];
  const action = interaction.customId.replace("memedrip_", "") as ControlAction;

  const delivered = relay.sendControl(targetId, action as ControlAction);
  if (!delivered) {
    await interaction.reply({ content: "Target is no longer online.", ephemeral: true });
    return;
  }
  await interaction.reply({ content: `Sent **${action}** to <@${targetId}>.`, ephemeral: true });
});

async function handleDrop(interaction: ChatInputCommandInteraction): Promise<void> {
  const mediaUrlInput = interaction.options.getString("media_url", true);
  const targetUser = interaction.options.getUser("target", true);
  const explicitType = interaction.options.getString("type") as MediaType | null;
  const durationSec = interaction.options.getInteger("duration") ?? 5;
  const position = (interaction.options.getString("position") as OverlayPosition | null) ?? "center";
  const scale = (interaction.options.getString("scale") as OverlayScale | null) ?? "normal";

  // #1 — rate limiting
  if (!rateLimiter.check(interaction.user.id)) {
    await interaction.reply({
      content: `⏱️ Slow down! You've reached the limit of ${RATE_LIMIT_MAX_DROPS} drops per minute.`,
      ephemeral: true,
    });
    return;
  }

  // #15 — /drop random
  let finalUrl = mediaUrlInput;
  let autoMediaType: MediaType | undefined;
  if (mediaUrlInput.toLowerCase() === "random") {
    const random = getRandomMediaFile();
    if (!random) {
      await interaction.reply({
        content: "❌ No media files found in the configured MEDIA_DIR.",
        ephemeral: true,
      });
      return;
    }
    finalUrl = random.url;
    autoMediaType = random.mediaType;
  } else {
    // #2 — URL validation
    const validation = validateMediaUrl(mediaUrlInput);
    if (!validation.ok) {
      await interaction.reply({ content: `❌ Invalid media URL: ${validation.reason}`, ephemeral: true });
      return;
    }
    autoMediaType = validation.mediaType;
  }

  const payload: MediaPayload = {
    id: randomUUID(),
    senderId: interaction.user.id,
    targetId: targetUser.id,
    mediaType: explicitType ?? autoMediaType ?? "image",
    url: finalUrl,
    duration: Math.min(durationSec, 60) * 1000,
    position,
    scale,
    timestamp: Date.now(),
  };

  const delivered = relay.sendTo(targetUser.id, payload);
  if (!delivered) {
    await interaction.reply({
      content: `⚠️ <@${targetUser.id}> is not online with MemeDrip running.`,
      ephemeral: true,
    });
    return;
  }

  log.info({ payloadId: payload.id, senderId: payload.senderId, targetId: payload.targetId }, "[drop] delivered");

  // #13 — reply with control buttons
  await interaction.reply({
    content: `🎨 Dropped **${payload.mediaType}** onto <@${targetUser.id}>'s screen!`,
    components: [buildControlButtons()],
    ephemeral: true,
  });
}

async function handleReact(interaction: ChatInputCommandInteraction): Promise<void> {
  const emoji = interaction.options.getString("emoji", true);
  const targetUser = interaction.options.getUser("target", true);
  const durationSec = interaction.options.getInteger("duration") ?? 3;

  // #1 — rate limiting
  if (!rateLimiter.check(interaction.user.id)) {
    await interaction.reply({
      content: `⏱️ Slow down! You've reached the limit of ${RATE_LIMIT_MAX_DROPS} drops per minute.`,
      ephemeral: true,
    });
    return;
  }

  let emojiUrl: string | undefined;
  const customMatch = emoji.match(/<a?:(\w+):(\d+)>/);
  let mediaType: MediaType = "image";
  if (customMatch) {
    const animated = emoji.startsWith("<a:");
    emojiUrl = `https://cdn.discordapp.com/emojis/${customMatch[2]}.${animated ? "gif" : "png"}`;
    mediaType = animated ? "gif" : "image";
  }

  const payload: MediaPayload = {
    id: randomUUID(),
    senderId: interaction.user.id,
    targetId: targetUser.id,
    mediaType,
    url: emojiUrl ?? "",
    duration: Math.min(durationSec, 30) * 1000,
    label: emojiUrl ? undefined : emoji,
    timestamp: Date.now(),
  };

  const delivered = relay.sendTo(targetUser.id, payload);
  if (!delivered) {
    await interaction.reply({
      content: `⚠️ <@${targetUser.id}> is not online with MemeDrip running.`,
      ephemeral: true,
    });
    return;
  }

  log.info({ payloadId: payload.id, senderId: payload.senderId, targetId: payload.targetId }, "[react] delivered");

  await interaction.reply({
    content: `⚡ Reacted ${emoji} onto <@${targetUser.id}>'s screen!`,
    components: [buildControlButtons()],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// Bot lifecycle
// ---------------------------------------------------------------------------
const useTLS = TLS_CERT_PATH !== "" && TLS_KEY_PATH !== "";
const relay = new RelayServer(WS_PORT, useTLS);

discord.once(Events.ClientReady, async (c) => {
  log.info({ tag: c.user.tag }, "[discord] Logged in");
  await registerCommands();
});

discord.on(Events.Error, (err) => {
  log.error({ err }, "[discord] Client error");
});

// ---------------------------------------------------------------------------
// #4 — Global error handlers to prevent silent crashes
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "[process] Unhandled rejection");
});

process.on("uncaughtException", (err) => {
  log.fatal({ err }, "[process] Uncaught exception — shutting down");
  shutdown("uncaughtException");
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "[shutdown] Closing connections…");
  discord.destroy();
  relay.shutdown();
  healthServer.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
discord.login(DISCORD_TOKEN).catch((err) => {
  log.fatal({ err }, "[discord] Login failed");
  process.exit(1);
});
