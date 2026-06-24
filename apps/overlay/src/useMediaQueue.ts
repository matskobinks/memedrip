/**
 * useMediaQueue.ts — Zustand store + Smart Queue Engine
 * =================================================================
 * Buffers incoming MediaPayloads from the WebSocket relay and plays
 * them sequentially. When multiple drops arrive simultaneously they
 * are queued FIFO to prevent visual overlap.
 *
 * Exposes:
 *   - queue:        MediaPayload[] (head = currently playing)
 *   - enqueue(p):   push a payload onto the queue
 *   - skip():       immediately advance to the next item
 *   - clear():     flush the queue
 *   - isPlaying:    true when something is on screen
 */

import { create } from "zustand";
import type { MediaPayload } from "@memedrip/shared-types";
import { DEFAULT_DURATION_MS } from "@memedrip/shared-types";

interface MediaQueueState {
  queue: MediaPayload[];
  isPlaying: boolean;
  /** Advance the queue — called automatically by the timer. */
  shift: () => void;
  /** Add a new media payload to the queue (dedup by id). */
  enqueue: (payload: MediaPayload) => void;
  /** Skip the currently-displayed item. */
  skip: () => void;
  /** Flush the entire queue. */
  clear: () => void;
}

// Timer handle kept outside the store to avoid re-renders.
let advanceTimer: ReturnType<typeof setTimeout> | null = null;

export const useMediaQueue = create<MediaQueueState>((set, get) => ({
  queue: [],
  isPlaying: false,

  enqueue: (payload) => {
    set((state) => {
      // Dedup: if the payload id is already in the queue, ignore it.
      if (state.queue.some((p) => p.id === payload.id)) return state;

      const queue = [...state.queue, payload];
      // If nothing is currently playing, start playback immediately.
      // Otherwise, the advance timer will pick it up.
      if (!state.isPlaying && queue.length === 1) {
        scheduleAdvance(payload.duration, get);
        return { queue, isPlaying: true };
      }
      return { queue };
    });
  },

  shift: () => {
    set((state) => {
      // Clear any pending timer — we're advancing now.
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
      const [, ...rest] = state.queue;
      if (rest.length > 0) {
        scheduleAdvance(rest[0].duration, get);
        return { queue: rest, isPlaying: true };
      }
      return { queue: rest, isPlaying: false };
    });
  },

  skip: () => {
    // Delegating to shift() achieves the skip effect.
    get().shift();
  },

  clear: () => {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    set({ queue: [], isPlaying: false });
  },
}));

/**
 * Schedule an automatic advance after `duration` ms.
 * Uses DEFAULT_DURATION_MS if duration is invalid/zero.
 */
function scheduleAdvance(duration: number, get: () => MediaQueueState): void {
  const ms = duration > 0 ? duration : DEFAULT_DURATION_MS;
  if (advanceTimer) clearTimeout(advanceTimer);
  advanceTimer = setTimeout(() => {
    get().shift();
  }, ms);
}
