/**
 * OverlayEngine.tsx — The core visual renderer
 * =================================================================
 * Consumes the head of the media queue and renders the appropriate
 * media element (image, GIF, video, audio, or text label for /react).
 *
 * Upgrades:
 *   - Position & scale support (#14)
 *   - Media preloading of next item (#12)
 *   - Pause indicator
 */

import { useEffect, useState, useMemo } from "react";
import { useMediaQueue, useNextInQueue } from "./useMediaQueue";
import {
  type MediaPayload,
  type OverlayPosition,
  SCALE_TO_CSS,
  POSITION_TO_CLASS,
} from "@memedrip/shared-types";

export function OverlayEngine() {
  const queue = useMediaQueue((s) => s.queue);
  const skip = useMediaQueue((s) => s.skip);
  const isPaused = useMediaQueue((s) => s.isPaused);
  const nextItem = useNextInQueue();

  const current: MediaPayload | null = queue.length > 0 ? queue[0] : null;
  const [fadingOut, setFadingOut] = useState(false);

  // #12 — Preload next item while current is playing
  useMediaPreloader(nextItem);

  // Fade-out trigger
  useEffect(() => {
    if (!current) return;
    setFadingOut(false);
    const fadeMs = Math.max(current.duration - 150, 0);
    const fadeTimer = setTimeout(() => setFadingOut(true), fadeMs);
    return () => clearTimeout(fadeTimer);
  }, [current]);

  if (!current) return null;

  // #14 — Resolve position (handle "random")
  const position = current.position ?? "center";
  // useMemo for stable random position per media item
  const resolvedPosition = useMemo<Exclude<OverlayPosition, "random">>(() => {
    if (position === "random") return pickRandomPosition();
    return position;
  }, [position, current.id]);

  // #14 — Map position to Tailwind classes
  const positionClass = POSITION_TO_CLASS[resolvedPosition] ?? POSITION_TO_CLASS.center;

  // #14 — Map scale to CSS width
  const scale = current.scale ?? "normal";
  const maxDimension = SCALE_TO_CSS[scale] ?? SCALE_TO_CSS.normal;

  const isFullscreen = scale === "fullscreen";

  return (
    <div
      className={`fixed inset-0 flex ${positionClass}`}
      style={{ pointerEvents: "none" }}
    >
      {/* Pause indicator overlay */}
      {isPaused && (
        <div className="absolute top-4 right-4 text-white text-sm bg-black/40 px-3 py-1 rounded-full">
          ⏸ Paused
        </div>
      )}

      <div
        key={current.id}
        className={`relative ${fadingOut ? "animate-fade-out" : "animate-fade-in"}`}
        style={{
          maxWidth: isFullscreen ? "100vw" : maxDimension,
          maxHeight: isFullscreen ? "100vh" : "80vh",
          width: isFullscreen ? "100vw" : undefined,
          height: isFullscreen ? "100vh" : undefined,
          filter: isFullscreen ? "none" : "drop-shadow(0 0 20px rgba(0,0,0,0.5))",
        }}
      >
        {/* --- Text/emoji label (for /react without custom emoji) --- */}
        {!current.url && current.label && (
          <span
            style={{
              fontSize: scale === "fullscreen" ? "30rem" : scale === "large" ? "16rem" : "12rem",
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
              skip();
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

        {/* --- Audio --- */}
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

/**
 * #12 — Preload the next media item by creating a hidden Image/Video element.
 * This makes the advance from queue[0] → queue[1] appear instantly.
 */
function useMediaPreloader(nextItem: MediaPayload | null): void {
  useEffect(() => {
    if (!nextItem || !nextItem.url) return;

    // For images/GIFs, create a new Image to trigger browser cache
    if (nextItem.mediaType === "image" || nextItem.mediaType === "gif") {
      const img = new Image();
      img.src = nextItem.url;
    }
    // For videos, create a video element and preload metadata
    else if (nextItem.mediaType === "video") {
      const video = document.createElement("video");
      video.preload = "auto";
      video.src = nextItem.url;
    }
    // Audio preloads are handled by the browser's media cache automatically
  }, [nextItem]);
}

/** Pick a random position for the "random" option. */
function pickRandomPosition(): Exclude<OverlayPosition, "random"> {
  const positions: Exclude<OverlayPosition, "random">[] = [
    "center", "top-left", "top-right", "bottom-left", "bottom-right",
  ];
  return positions[Math.floor(Math.random() * positions.length)];
}
