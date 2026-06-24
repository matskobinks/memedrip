/**
 * OverlayEngine.tsx — The core visual renderer
 * =================================================================
 * Consumes the head of the media queue and renders the appropriate
 * media element (image, GIF, video, audio, or text label for /react).
 *
 * Uses CSS animations for fade-in/out (GPU-accelerated transforms) to
 * keep CPU usage minimal during competitive gaming.
 *
 * The entire overlay is pointer-events:none (set in index.html and
 * Tauri's set_ignore_cursor_events) so it never blocks input.
 */

import { useEffect, useState } from "react";
import { useMediaQueue } from "./useMediaQueue";
import type { MediaPayload } from "@memedrip/shared-types";

export function OverlayEngine() {
  const queue = useMediaQueue((s) => s.queue);
  const skip = useMediaQueue((s) => s.skip);

  const current: MediaPayload | null = queue.length > 0 ? queue[0] : null;
  const [fadingOut, setFadingOut] = useState(false);

  // Trigger fade-out shortly before the queue advances so the exit
  // animation is visible.  The actual shift happens via the timer in
  // useMediaQueue.
  useEffect(() => {
    if (!current) return;
    setFadingOut(false);

    // Schedule a fade-out 150ms before the item expires.
    const fadeMs = Math.max(current.duration - 150, 0);
    const fadeTimer = setTimeout(() => setFadingOut(true), fadeMs);
    return () => clearTimeout(fadeTimer);
  }, [current]);

  // --- Nothing to display ---
  if (!current) return null;

  // --- Render based on media type ---
  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ pointerEvents: "none" }}
    >
      <div
        key={current.id}
        className={`relative ${fadingOut ? "animate-fade-out" : "animate-fade-in"}`}
        style={{
          maxWidth: "60vw",
          maxHeight: "80vh",
          filter: "drop-shadow(0 0 20px rgba(0,0,0,0.5))",
        }}
      >
        {/* --- Text/emoji label (for /react without custom emoji) --- */}
        {!current.url && current.label && (
          <span
            style={{
              fontSize: "12rem",
              lineHeight: 1,
              userSelect: "none",
            }}
          >
            {current.label}
          </span>
        )}

        {/* --- Image / GIF --- */}
        {(current.mediaType === "image" || current.mediaType === "gif") && current.url && (
          <img
            src={current.url}
            alt="MemeDrip media"
            className="max-w-full max-h-full object-contain"
            draggable={false}
            onError={() => {
              console.error(`[overlay] Failed to load image: ${current.url}`);
              skip(); // skip broken media
            }}
          />
        )}

        {/* --- Video --- */}
        {current.mediaType === "video" && current.url && (
          <video
            src={current.url}
            autoPlay
            muted
            className="max-w-full max-h-full object-contain"
            onEnded={skip}
            onError={() => {
              console.error(`[overlay] Failed to load video: ${current.url}`);
              skip();
            }}
          />
        )}

        {/* --- Audio (visualize as a pulsing icon) --- */}
        {current.mediaType === "audio" && current.url && (
          <>
            <audio
              src={current.url}
              autoPlay
              onEnded={skip}
              onError={() => {
                console.error(`[overlay] Failed to load audio: ${current.url}`);
                skip();
              }}
            />
            <div className="flex flex-col items-center gap-4">
              <svg width="120" height="120" viewBox="0 0 24 24" fill="white">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
              <span className="text-white text-2xl font-bold drop-shadow-lg">
                🔊 Now Playing
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
