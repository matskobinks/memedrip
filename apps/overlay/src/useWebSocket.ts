/**
 * useWebSocket.ts — Resilient WebSocket client hook
 * =================================================================
 * Connects to the MemeDrip relay server with exponential backoff
 * auto-reconnection. Authenticates on connect, handles ping/pong
 * heartbeats, and feeds incoming MediaPayloads into the queue store.
 */

import { useEffect, useRef } from "react";
import type { RelayMessage, MediaPayload } from "@memedrip/shared-types";
import { useMediaQueue } from "./useMediaQueue";

// Configuration
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:7878";
const DISCORD_ID = import.meta.env.VITE_DISCORD_ID ?? "";
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN ?? "";

// Backoff parameters
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * A hook that manages the WebSocket lifecycle.
 * Returns nothing — it feeds directly into the Zustand store.
 */
export function useRelayConnection(): void {
  const enqueue = useMediaQueue((s) => s.enqueue);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldReconnectRef = useRef(true);

  useEffect(() => {
    function connect(): void {
      if (!DISCORD_ID || !AUTH_TOKEN) {
        console.error(
          "[ws] Missing VITE_DISCORD_ID or VITE_AUTH_TOKEN — cannot connect.",
        );
        return;
      }

      console.log(`[ws] Connecting to ${WS_URL}…`);
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        console.log("[ws] Connected — sending auth");
        backoffRef.current = INITIAL_BACKOFF_MS; // reset backoff
        send(ws, { type: "auth", token: AUTH_TOKEN, discordId: DISCORD_ID });
        // Start heartbeat
        heartbeatTimerRef.current = setInterval(() => {
          send(ws, { type: "ping" });
        }, HEARTBEAT_INTERVAL_MS);
      });

      ws.addEventListener("message", (event) => {
        let msg: RelayMessage;
        try {
          msg = JSON.parse(event.data) as RelayMessage;
        } catch {
          console.warn("[ws] Received malformed message");
          return;
        }

        switch (msg.type) {
          case "auth_ok":
            console.log("[ws] Authenticated ✓");
            break;
          case "auth_error":
            console.error("[ws] Auth failed:", msg.reason);
            shouldReconnectRef.current = false; // don't retry on auth failure
            ws.close();
            break;
          case "ping":
            send(ws, { type: "pong" });
            break;
          case "pong":
            // Heartbeat response — nothing to do
            break;
          case "media":
            console.log("[ws] Received media payload:", msg.payload.id);
            enqueue(msg.payload as MediaPayload);
            break;
          case "error":
            console.warn("[ws] Server error:", msg.reason);
            break;
        }
      });

      ws.addEventListener("close", (event) => {
        console.log(`[ws] Closed (code=${event.code}, reason=${event.reason})`);
        cleanup();
        if (shouldReconnectRef.current) {
          scheduleReconnect();
        }
      });

      ws.addEventListener("error", (event) => {
        console.error("[ws] Socket error:", event);
        // The close handler will trigger reconnect
      });
    }

    function scheduleReconnect(): void {
      const delay = backoffRef.current;
      console.log(`[ws] Reconnecting in ${delay}ms…`);
      backoffRef.current = Math.min(
        backoffRef.current * BACKOFF_MULTIPLIER,
        MAX_BACKOFF_MS,
      );
      reconnectTimerRef.current = setTimeout(connect, delay);
    }

    function cleanup(): void {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    }

    function send(ws: WebSocket, msg: RelayMessage): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }

    connect();

    // Cleanup on unmount
    return () => {
      shouldReconnectRef.current = false;
      cleanup();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close(1000, "Component unmounted");
        wsRef.current = null;
      }
    };
  }, [enqueue]);
}
