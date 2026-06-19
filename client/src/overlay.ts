const root = document.getElementById("overlay-root");

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let currentVolume = 0.8;

const clearCurrentMedia = () => {
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
};

const scheduleHide = (durationMs: number) => {
  if (hideTimer) {
    clearTimeout(hideTimer);
  }

  hideTimer = setTimeout(() => {
    clearCurrentMedia();
  }, durationMs);
};

const showImage = (url: string, durationMs: number) => {
  if (!root) {
    return;
  }

  clearCurrentMedia();

  const image = document.createElement("img");
  image.className = "media";
  image.src = url;
  image.alt = "MemeDrip media";
  image.loading = "eager";
  image.onerror = () => clearCurrentMedia();

  root.appendChild(image);
  scheduleHide(durationMs || 7000);
};

const showVideo = (url: string, durationMs: number) => {
  if (!root) {
    return;
  }

  clearCurrentMedia();

  const video = document.createElement("video");
  video.className = "media";
  video.src = url;
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  video.volume = currentVolume;
  video.onerror = () => clearCurrentMedia();

  video.onloadedmetadata = () => {
    const computedDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : durationMs;
    scheduleHide(Math.max(1500, computedDuration || 15000));
  };

  root.appendChild(video);
  void video.play().catch(() => {
    scheduleHide(Math.max(1500, durationMs || 15000));
  });
};

window.electronAPI.onDrop((payload) => {
  if (!payload?.url) {
    return;
  }

  if (payload.kind === "video") {
    showVideo(payload.url, payload.durationMs);
    return;
  }

  showImage(payload.url, payload.durationMs || 7000);
});

window.electronAPI.onVolume((volume) => {
  currentVolume = Math.max(0, Math.min(1, volume));
  const video = document.querySelector<HTMLVideoElement>("video.media");

  if (video) {
    video.volume = currentVolume;
  }
});
