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
 * Scaling note: when you outgrow a single process, extract the relay
 * into its own service and use Redis Pub/Sub as the bus.  The
 * RelayServer API below already isolates that boundary.
 */

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  REST,
  Routes,
  Events,
} from "discord.js";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, createHash } from "node:crypto";
import {
  type MediaPayload,
  type RelayMessage,
  type MediaType,
  DEFAULT_DURATION_MS,
  isMediaPayload,
} from "@memedrip/shared-types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || undefined;
const WS_PORT = parseInt(process.env.WS_PORT || "7878", 10);
const RELAY_AUTH_SECRET = process.env.RELAY_AUTH_SECRET!;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !RELAY_AUTH_SECRET) {
  console.error(
    "[FATAL] Missing required env vars. Set DISCORD_TOKEN, DISCORD_CLIENT_ID, RELAY_AUTH_SECRET.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Relay Server — in-memory registry of connected desktop clients
// ---------------------------------------------------------------------------
interface ClientEntry {
  ws: WebSocket;
  discordId: string;
  /** Heartbeat: if we don't receive a pong within this window, drop. */
  alive: boolean;
}

class RelayServer {
  private clients = new Map<string, ClientEntry>(); // discordId → entry
  private wss: WebSocketServer;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    console.log(`[relay] WebSocket server listening on :${port}`);

    // Heartbeat sweep every 30s — mark dead clients and terminate them.
    setInterval(() => this.sweepDeadClients(), 30_000).unref();
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

    ws.on("message", (raw: Buffer) => {
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
        if (!this.verifyToken(msg.token, msg.discordId)) {
          this.send(ws, { type: "auth_error", reason: "Invalid token" });
          ws.close(4003, "Invalid token");
          return;
        }
        authenticated = true;
        discordId = msg.discordId;
        entry = { ws, discordId, alive: true };
        this.clients.set(discordId, entry);
        clearTimeout(authTimeout);
        this.send(ws, { type: "auth_ok" });
        console.log(`[relay] Client connected: ${discordId}`);
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
          // Desktop clients only send auth + pong; anything else is ignored.
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (discordId && this.clients.get(discordId)?.ws === ws) {
        this.clients.delete(discordId);
        console.log(`[relay] Client disconnected: ${discordId}`);
      }
    });

    ws.on("error", (err) => {
      console.error(`[relay] Socket error for ${discordId ?? "unauth"}:`, err.message);
    });
  }

  /**
   * Push a media payload to a single targeted client.
   * Returns true if delivered, false if the client is offline.
   */
  sendTo(targetId: string, payload: MediaPayload): boolean {
    const entry = this.clients.get(targetId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
    this.send(entry.ws, { type: "media", payload });
    return true;
  }

  /** Returns true if a desktop client is currently connected for the ID. */
  hasClient(targetId: string): boolean {
    const e = this.clients.get(targetId);
    return !!e && e.ws.readyState === WebSocket.OPEN;
  }

  /** Send a heartbeat ping to every connected client. */
  private sweepDeadClients(): void {
    this.clients.forEach((entry, id) => {
      if (!entry.alive) {
        entry.ws.terminate();
        this.clients.delete(id);
        console.log(`[relay] Swept dead client: ${id}`);
        return;
      }
      entry.alive = false;
      this.send(entry.ws, { type: "ping" });
    });
  }

  // --- helpers ---
  private send(ws: WebSocket, msg: RelayMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /**
   * V1 token verification: HMAC-style comparison of `sha256(secret + discordId)`.
   * In production, replace with a real JWT or OAuth exchange — the desktop
   * client obtains this token by logging in via Discord OAuth and the
   * backend signs it.  For V1 the token is derived deterministically.
   */
  private verifyToken(token: string, discordId: string): boolean {
    const expected = this.computeToken(discordId);
    // Constant-time comparison
    if (token.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  }

  /** Deterministic token = sha256(secret : discordId). */
  public computeToken(discordId: string): string {
    return createHash("sha256").update(`${RELAY_AUTH_SECRET}:${discordId}`).digest("hex");
  }

  /** Gracefully close all connections and shut down the WSS. */
  public shutdown(): void {
    this.wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
    this.wss.close();
    console.log("[relay] Server closed");
  }
}

// ---------------------------------------------------------------------------
// Discord Bot setup
// ---------------------------------------------------------------------------
const discord = new Client({
  intents: [GatewayIntentBits.Guilds], // slash commands only — minimal intents
});

// Slash command definitions
const dropCommand = new SlashCommandBuilder()
  .setName("drop")
  .setDescription("Drop media onto a user's screen via MemeDrip overlay")
  .addStringOption((o) =>
    o.setName("media_url").setDescription("Direct URL to image / GIF / video / audio").setRequired(true),
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
      // Guild-scoped = instant registration (great for dev)
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body });
      console.log(`[discord] Registered guild commands in ${DISCORD_GUILD_ID}`);
    } else {
      // Global = propagates within ~1h
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
      console.log("[discord] Registered global commands");
    }
  } catch (err) {
    console.error("[discord] Command registration failed:", err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// URL validation — block obviously malicious inputs
// ---------------------------------------------------------------------------
const ALLOWED_MEDIA_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
];

function validateMediaUrl(raw: string): { ok: boolean; mediaType?: MediaType; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http(s) URLs are allowed" };
  }
  const pathname = url.pathname.toLowerCase();
  const ext = pathname.slice(pathname.lastIndexOf("."));
  if (!ALLOWED_MEDIA_EXTENSIONS.includes(ext)) {
    return { ok: false, reason: `Blocked file extension: ${ext || "(none)"}` };
  }
  // Auto-detect media type from extension if not provided
  const typeMap: Record<string, MediaType> = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "gif",
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".mp3": "audio", ".wav": "audio", ".ogg": "audio",
  };
  return { ok: true, mediaType: typeMap[ext] ?? "image" };
}

// ---------------------------------------------------------------------------
// Interaction handler
// ---------------------------------------------------------------------------
discord.on(Events.InteractionCreate, async (interaction) => {
  // Narrow to chat-input slash commands; ignore buttons, menus, etc.
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "drop") {
    await handleDrop(interaction);
  } else if (interaction.commandName === "react") {
    await handleReact(interaction);
  }
});

async function handleDrop(interaction: ChatInputCommandInteraction): Promise<void> {
  const mediaUrl = interaction.options.getString("media_url", true);
  const targetUser = interaction.options.getUser("target", true);
  const explicitType = interaction.options.getString("type") as MediaType | null;
  const durationSec = interaction.options.getInteger("duration") ?? 5;

  const validation = validateMediaUrl(mediaUrl);
  if (!validation.ok) {
    await interaction.reply({ content: `❌ Invalid media URL: ${validation.reason}`, ephemeral: true });
    return;
  }

  const payload: MediaPayload = {
    id: randomUUID(),
    senderId: interaction.user.id,
    targetId: targetUser.id,
    mediaType: explicitType ?? validation.mediaType ?? "image",
    url: mediaUrl,
    duration: Math.min(durationSec, 60) * 1000,
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

  await interaction.reply({
    content: `🎨 Dropped **${payload.mediaType}** onto <@${targetUser.id}>'s screen!`,
    ephemeral: true,
  });
}

async function handleReact(interaction: ChatInputCommandInteraction): Promise<void> {
  const emoji = interaction.options.getString("emoji", true);
  const targetUser = interaction.options.getUser("target", true);
  const durationSec = interaction.options.getInteger("duration") ?? 3;

  // Render emoji as text overlay — no URL needed, we pass it as a "label".
  // If it's a custom Discord emoji, extract the image CDN URL.
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
    url: emojiUrl ?? "", // empty url = render as text label
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

  await interaction.reply({
    content: `⚡ Reacted ${emoji} onto <@${targetUser.id}>'s screen!`,
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// Bot lifecycle
// ---------------------------------------------------------------------------
const relay = new RelayServer(WS_PORT);

discord.once(Events.ClientReady, async (c) => {
  console.log(`[discord] Logged in as ${c.user.tag}`);
  await registerCommands();
});

discord.on(Events.Error, (err) => {
  console.error("[discord] Client error:", err);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal: string): void {
  console.log(`\n[shutdown] Received ${signal}, closing connections…`);
  discord.destroy();
  relay.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
discord.login(DISCORD_TOKEN).catch((err) => {
  console.error("[discord] Login failed:", err);
  process.exit(1);
});
