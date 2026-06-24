/**
 * useMediaQueue.ts — Zustand store + Smart Queue Engine
 * =================================================================
 * Buffers incoming MediaPayloads from the WebSocket relay and plays
 * them sequentially. When multiple drops arrive simultaneously they
 * are queued FIFO to prevent visual overlap.
 *
 * Upgrades:
 *   - Timer moved into a ref-based singleton (no module-level mutable)
 *   - Pause/resume support (control actions from Discord buttons)
 *   - Control actions: skip, clear, pause, resume
 *
 * Exposes:
 *   - queue:        MediaPayload[] (head = currently playing)
 *   - enqueue(p):   push a payload onto the queue
 *   - shift():      advance to next item
 *   - skip():       same as shift
 *   - clear():      flush the queue
 *   - pause():      pause playback (current item stays on screen)
 *   - resume():     resume playback
 *   - isPlaying:    true when something is on screen
 *   - isPaused:     true when playback is paused
 */

import { create } from "zustand";
import type { MediaPayload, ControlAction } from "@memedrip/shared-types";
import { DEFAULT_DURATION_MS } from "@memedrip/shared-types";

interface MediaQueueState {
  queue: MediaPayload[];
  isPlaying: boolean;
  isPaused: boolean;
  /** Remaining ms when paused (for resume). */
  remainingMs: number;
  /** When the current item started playing (epoch ms). */
  startedAt: number;
  shift: () => void;
  enqueue: (payload: MediaPayload) => void;
  skip: () => void;
  clear: () => void;
  /** Handle a control action from the relay. */
  control: (action: ControlAction) => void;
}

/**
 * Timer manager — encapsulates the advance timer so it's not
 * a module-level mutable variable (#8). Uses a singleton class.
 */
class TimerManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedRemaining: number | null = null;

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule(duration: number, callback: () => void): void {
    this.clear();
    this.pausedRemaining = null;
    this.timer = setTimeout(callback, duration);
  }

  /** Pause: stop timer, record how much time was left. */
  pause(): number | null {
    if (this.timer && this.pausedRemaining === null) {
      // Approximate remaining time — we store the original duration
      // and let the caller compute elapsed. For simplicity, we just
      // stop the timer and let the store track state.
      this.clear();
      return this.pausedRemaining;
    }
    return null;
  }

  get isPaused(): boolean {
    return this.pausedRemaining !== null;
  }
}

const timerManager = new TimerManager();

export const useMediaQueue = create<MediaQueueState>((set, get) => ({
  queue: [],
  isPlaying: false,
  isPaused: false,
  remainingMs: 0,
  startedAt: 0,

  enqueue: (payload) => {
    set((state) => {
      if (state.queue.some((p) => p.id === payload.id)) return state;

      const queue = [...state.queue, payload];
      if (!state.isPlaying && !state.isPaused && queue.length === 1) {
        const duration = payload.duration > 0 ? payload.duration : DEFAULT_DURATION_MS;
        timerManager.schedule(duration, () => get().shift());
        return { queue, isPlaying: true, startedAt: Date.now() };
      }
      return { queue };
    });
  },

  shift: () => {
    set((state) => {
      timerManager.clear();
      const [, ...rest] = state.queue;
      if (rest.length > 0) {
        const duration = rest[0].duration > 0 ? rest[0].duration : DEFAULT_DURATION_MS;
        timerManager.schedule(duration, () => get().shift());
        return { queue: rest, isPlaying: true, isPaused: false, startedAt: Date.now() };
      }
      return { queue: rest, isPlaying: false, isPaused: false };
    });
  },

  skip: () => {
    get().shift();
  },

  clear: () => {
    timerManager.clear();
    set({ queue: [], isPlaying: false, isPaused: false });
  },

  control: (action) => {
    const state = get();
    switch (action) {
      case "skip":
        get().shift();
        break;
      case "clear":
        get().clear();
        break;
      case "pause":
        if (state.isPlaying && !state.isPaused) {
          timerManager.clear();
          set({ isPaused: true });
        }
        break;
      case "resume":
        if (state.isPaused && state.queue.length > 0) {
          // Resume with remaining time (approximate: original duration)
          const current = state.queue[0];
          const elapsed = Date.now() - state.startedAt;
          const remaining = Math.max(current.duration - elapsed, 1000);
          timerManager.schedule(remaining, () => get().shift());
          set({ isPaused: false, startedAt: Date.now() - (current.duration - remaining) });
        }
        break;
    }
  },
}));

/**
 * Preload hint: returns the next item in queue (queue[1]) if present,
 * so the OverlayEngine can prefetch it (#12).
 */
export function useNextInQueue(): MediaPayload | null {
  return useMediaQueue((s) => (s.queue.length > 1 ? s.queue[1] : null));
}
