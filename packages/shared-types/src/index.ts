/**
 * MemeDrip — Shared Type Definitions
 * ------------------------------------------------------------------
 * All cross-package types live here so the bot, the relay and the
 * desktop overlay compile against a single source of truth.
 */

/** Supported media types the overlay knows how to render. */
export type MediaType = "image" | "gif" | "video" | "audio";

/** Screen position for the overlay render. */
export type OverlayPosition =
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "random";

/** Scale factor for the rendered media. */
export type OverlayScale = "small" | "normal" | "large" | "fullscreen";

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
  /** Where on screen to render. Defaults to "center". */
  position?: OverlayPosition;
  /** Size factor. Defaults to "normal". */
  scale?: OverlayScale;
  /** Server-set timestamp (epoch ms). */
  timestamp: number;
}

/**
 * Control messages the desktop client can receive to manipulate
 * its active queue (triggered by Discord interaction buttons).
 */
export type ControlAction = "skip" | "clear" | "pause" | "resume";

/** Wrapper for every message exchanged over the WebSocket. */
export type RelayMessage =
  | { type: "auth"; token: string; discordId: string }
  | { type: "auth_ok" }
  | { type: "auth_error"; reason: string }
  | { type: "media"; payload: MediaPayload }
  | { type: "control"; action: ControlAction }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "error"; reason: string };

/** Default display duration (ms). */
export const DEFAULT_DURATION_MS = 5000;

/** Rate limiting constants */
export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const RATE_LIMIT_MAX_DROPS = 5; // max drops per sender per window

/** Scale → CSS size mapping */
export const SCALE_TO_CSS: Record<OverlayScale, string> = {
  small: "25vw",
  normal: "40vw",
  large: "60vw",
  fullscreen: "100vw",
};

/** Position → Tailwind flex mapping */
export const POSITION_TO_CLASS: Record<Exclude<OverlayPosition, "random">, string> = {
  center: "items-center justify-center",
  "top-left": "items-start justify-start",
  "top-right": "items-start justify-end",
  "bottom-left": "items-end justify-start",
  "bottom-right": "items-end justify-end",
};

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
