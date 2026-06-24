/**
 * MemeDrip — Shared Type Definitions
 * ------------------------------------------------------------------
 * All cross-package types live here so the bot, the relay and the
 * desktop overlay compile against a single source of truth.
 */

/** Supported media types the overlay knows how to render. */
export type MediaType = "image" | "gif" | "video" | "audio";

/**
 * Core payload broadcast to a desktop client when a Discord user
 * triggers `/drop` or `/react`.
 */
export interface MediaPayload {
  /** Unique id (crypto.randomUUID) — used for dedup and queue keys. */
  id: string;
  /** Discord ID of the user who sent the command. */
  senderId: string;
  /** Discord ID of the user whose screen should display the media. */
  targetId: string;
  /** Discriminator for the renderer. */
  mediaType: MediaType;
  /** Direct URL to the media resource (validated, https preferred). */
  url: string;
  /** Display duration in milliseconds. Default 5000. */
  duration: number;
  /** Optional display label (e.g. emoji for /react). */
  label?: string;
  /** Server-set timestamp (epoch ms). */
  timestamp: number;
}

/** Wrapper for every message exchanged over the WebSocket. */
export type RelayMessage =
  | { type: "auth"; token: string; discordId: string }
  | { type: "auth_ok" }
  | { type: "auth_error"; reason: string }
  | { type: "media"; payload: MediaPayload }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "error"; reason: string };

/** Default display duration (ms). */
export const DEFAULT_DURATION_MS = 5000;

/** Quick guard to validate a MediaPayload at runtime. */
export function isMediaPayload(v: unknown): v is MediaPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.senderId === "string" &&
    typeof o.targetId === "string" &&
    (o.mediaType === "image" ||
      o.mediaType === "gif" ||
      o.mediaType === "video" ||
      o.mediaType === "audio") &&
    typeof o.url === "string" &&
    typeof o.duration === "number" &&
    typeof o.timestamp === "number"
  );
}
