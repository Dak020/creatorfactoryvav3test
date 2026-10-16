export interface BrowserRenderOptions {
  sourceUrl: string;
  startSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
  text: string;
  placement?: HookPlacement | undefined;
  fontSize?: number | undefined;
  textColor?: string | undefined;
  backgroundColor?: string | undefined;
  withAudio?: boolean | undefined;
  soundtrackUrl?: string | null | undefined;
  soundtrackVolume?: number | undefined;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal | undefined;
}

export type HookPlacement = "top" | "middle" | "bottom";

export interface BrowserRenderResult {
  blob: Blob;
  extension: string;
  mimeType: string;
  thumbnail?: Blob | undefined;
}

export class RenderCancelledError extends Error {
  constructor() {
    super("Render was cancelled");
    this.name = "RenderCancelledError";
  }
}

export type SeekMode = "random" | "beginning" | "manual";
export interface SeekOptions {
  seekMode?: "start" | "uniform" | "random" | "smart" | undefined;
  totalDuration?: number | undefined;
  stepSeconds?: number | undefined;
  mode?: "random" | "beginning" | "manual" | undefined;
  manualSeconds?: number | undefined;
}

export function planStartOffsets(
  clipDuration: number,
  targetDuration: number,
  variantCount: number,
  options?: SeekOptions,
): number[] {
  const maxStart = Math.max(0, clipDuration - targetDuration);
  if (maxStart === 0 || variantCount <= 1) {
    return Array.from({ length: variantCount }, () => 0);
  }

  const mode = options?.seekMode ?? "uniform";
  const step = options?.stepSeconds ?? 1.5;

  if (mode === "start") {
    return Array.from({ length: variantCount }, () => 0);
  }

  if (mode === "smart") {
    const offsets: number[] = [];
    for (let i = 0; i < variantCount; i++) {
      const candidate = (i * step) % (maxStart + 0.001);
      offsets.push(Math.min(candidate, maxStart));
    }
    return offsets;
  }

  if (mode === "random") {
    return Array.from({ length: variantCount }, () => {
      const rand = Math.random() * maxStart;
      return Math.round(rand * 10) / 10;
    });
  }

  const interval = maxStart / (variantCount - 1);
  return Array.from({ length: variantCount }, (_, i) => {
    return Math.round(i * interval * 10) / 10;
  });
}

function fontFor(size: number) {
  return `900 ${size}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
}

interface WrappedLine {
  text: string;
  x: number;
  y: number;
}

interface OverlayLayout {
  lines: WrappedLine[];
  fontSize: number;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
): string[] {
  ctx.font = fontFor(fontSize);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (ctx.measureText(word).width > maxWidth) {
        let piece = "";
        for (const char of word) {
          if (ctx.measureText(piece + char).width <= maxWidth) {
            piece += char;
          } else {
            if (piece) lines.push(piece);
            piece = char;
          }
        }
        current = piece;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function layoutOverlay(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  canvasWidth: number,
  canvasHeight: number,
  placement: HookPlacement = "top",
): OverlayLayout {
  const maxWidth = Math.round(canvasWidth * 0.84);
  const len = rawText.length;
  let baseSize = 64;
  if (len <= 25) baseSize = 76;
  else if (len <= 45) baseSize = 68;
  else if (len <= 80) baseSize = 58;
  else baseSize = 50;

  const scale = canvasWidth / 1080;
  let fontSize = Math.round(baseSize * scale);

  let lines: string[] = [];
  while (fontSize > Math.round(36 * scale)) {
    lines = wrapText(ctx, rawText, maxWidth, fontSize);
    if (lines.length <= 4) break;
    fontSize -= 4;
  }

  ctx.font = fontFor(fontSize);
  const lineHeight = fontSize * 1.22;
  const totalTextHeight = lines.length * lineHeight;

  let startY: number;
  if (placement === "top") {
    startY = Math.round(canvasHeight * 0.16);
  } else if (placement === "middle") {
    startY = Math.round((canvasHeight - totalTextHeight) / 2);
  } else {
    startY = Math.round(canvasHeight * 0.76 - totalTextHeight);
  }

  const wrapped: WrappedLine[] = lines.map((text, idx) => ({
    text,
    x: Math.round(canvasWidth / 2),
    y: Math.round(startY + idx * lineHeight),
  }));

  return { lines: wrapped, fontSize };
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  lines: WrappedLine[],
  fontSize: number,
  canvasWidth: number,
  canvasHeight: number,
  styleKey?: string,
) {
  if (!lines.length) return;
  const key = (styleKey ?? "").toLowerCase();
  const lineHeight = fontSize * 1.22;
  const paddingX = Math.round(fontSize * 0.45);
  const paddingY = Math.round(fontSize * 0.22);
  const radius = Math.round(fontSize * 0.24);

  if (key.includes("pill") || key.includes("badge") || key.includes("box")) {
    ctx.save();
    ctx.fillStyle = key.includes("white")
      ? "rgba(255,255,255,0.92)"
      : key.includes("yellow")
        ? "rgba(250,204,21,0.95)"
        : "rgba(10,10,12,0.85)";

    for (const line of lines) {
      const w = ctx.measureText(line.text).width;
      const x = line.x - w / 2 - paddingX;
      const y = line.y - paddingY;
      const boxW = w + paddingX * 2;
      const boxH = lineHeight + paddingY * 0.6;
      ctx.beginPath();
      ctx.roundRect(x, y, boxW, boxH, radius);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (key.includes("gradient") || key.includes("tint") || key.includes("vignette")) {
    ctx.save();
    const firstY = lines[0].y - fontSize;
    const lastY = lines[lines.length - 1].y + lineHeight;
    const grad = ctx.createLinearGradient(0, firstY - 80, 0, lastY + 80);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(0.3, "rgba(0,0,0,0.7)");
    grad.addColorStop(0.7, "rgba(0,0,0,0.7)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, firstY - 80, canvasWidth, lastY - firstY + 160);
    ctx.restore();
    return;
  }
}

function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  layout: OverlayLayout,
  textColor: string = "#ffffff",
) {
  const { lines, fontSize } = layout;
  if (!lines.length) return;

  ctx.save();
  ctx.font = fontFor(fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const strokeWidth = Math.max(3, Math.round(fontSize * 0.1));
  const isLightText = textColor.toLowerCase() === "#ffffff" || textColor.toLowerCase() === "white";

  for (const line of lines) {
    if (isLightText) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
      ctx.shadowBlur = Math.round(fontSize * 0.28);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Math.round(fontSize * 0.05);

      ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeText(line.text, line.x, line.y);
    }

    ctx.fillStyle = textColor;
    ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
}

function pickSupportedMimeType(): { mimeType: string; extension: string } {
  if (typeof MediaRecorder === "undefined") {
    return { mimeType: "video/webm", extension: "webm" };
  }
  const candidates = [
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
    { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
  ];

  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "video/webm", extension: "webm" };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetW: number,
  targetH: number,
) {
  const vw = video.videoWidth || targetW;
  const vh = video.videoHeight || targetH;
  const targetRatio = targetW / targetH;
  const videoRatio = vw / vh;

  let sx = 0;
  let sy = 0;
  let sWidth = vw;
  let sHeight = vh;

  if (videoRatio > targetRatio) {
    sWidth = vh * targetRatio;
    sx = (vw - sWidth) / 2;
  } else {
    sHeight = vw / targetRatio;
    sy = (vh - sHeight) / 2;
  }

  ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, targetW, targetH);
}

function seekTo(video: HTMLVideoElement, targetTime: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const onSeeked = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve();
    };

    const onError = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error("Video seek failed"));
    };

    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve();
    }, 2500);

    try {
      video.currentTime = targetTime;
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

function loadVideoElement(
  sourceUrl: string,
  withAudio: boolean,
  signal?: AbortSignal,
): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new RenderCancelledError());
    }

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.playsInline = true;
    video.preload = "auto";
    video.muted = !withAudio;
    video.volume = withAudio ? 1.0 : 0;

    const onAbort = () => {
      cleanup();
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
      reject(new RenderCancelledError());
    };

    const onLoaded = () => {
      cleanup();
      resolve(video);
    };

    const onError = () => {
      cleanup();
      reject(new Error("Failed to load source video for rendering"));
    };

    const cleanup = () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };

    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Loading source video timed out after 15 seconds"));
    }, 15000);

    video.src = sourceUrl;
    video.load();
  });
}

function loadAudioElement(sourceUrl: string, signal?: AbortSignal): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RenderCancelledError());

    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";

    const onAbort = () => {
      cleanup();
      audio.pause();
      audio.removeAttribute("src");
      reject(new RenderCancelledError());
    };

    const onLoaded = () => {
      cleanup();
      resolve(audio);
    };

    const onError = () => {
      cleanup();
      reject(new Error("Failed to load soundtrack audio"));
    };

    const cleanup = () => {
      audio.removeEventListener("canplaythrough", onLoaded);
      audio.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };

    audio.addEventListener("canplaythrough", onLoaded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Soundtrack audio timed out loading after 12s"));
    }, 12000);

    audio.src = sourceUrl;
    audio.load();
  });
}

export async function renderVariant(options: BrowserRenderOptions): Promise<BrowserRenderResult> {
  const {
    sourceUrl,
    startSeconds,
    durationSeconds,
    width,
    height,
    text,
    placement = "top",
    textColor = "#ffffff",
    backgroundColor,
    withAudio = true,
    soundtrackUrl,
    soundtrackVolume = 0.8,
    onProgress,
    signal,
  } = options;

  if (signal?.aborted) {
    throw new RenderCancelledError();
  }

  // 1. Prepare video element
  const video = await loadVideoElement(sourceUrl, withAudio, signal);

  // 1b. Prepare optional external soundtrack
  let soundtrackAudio: HTMLAudioElement | null = null;
  if (soundtrackUrl) {
    try {
      soundtrackAudio = await loadAudioElement(soundtrackUrl, signal);
    } catch (e) {
      console.warn("Could not load external soundtrack, continuing with video audio:", e);
    }
  }

  // 2. Prepare offscreen canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("Could not get 2D rendering context");
  }

  // 3. Precalculate text overlay layout
  const layout = layoutOverlay(ctx, text, width, height, placement);

  // 4. Seek to requested start offset
  const safeStart = Math.max(0, Math.min(startSeconds, Math.max(0, (video.duration || 10) - 1)));
  await seekTo(video, safeStart);

  // Capture thumbnail at frame 0
  drawCover(ctx, video, width, height);
  drawBackground(ctx, layout.lines, layout.fontSize, width, height, backgroundColor);
  drawTextOverlay(ctx, layout, textColor);

  let thumbnail: Blob | undefined;
  try {
    thumbnail = await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((b) => resolve(b || undefined), "image/jpeg", 0.85);
    });
  } catch {
    /* ignore thumbnail failure */
  }

  // 5. Setup capture stream & MediaRecorder with optional audio
  const canvasStream = canvas.captureStream(30);
  const combinedStream = new MediaStream();

  canvasStream.getVideoTracks().forEach((track) => combinedStream.addTrack(track));

  let audioCtx: AudioContext | null = null;
  let videoSourceNode: MediaElementAudioSourceNode | null = null;
  let soundtrackSourceNode: MediaElementAudioSourceNode | null = null;

  const cleanupAudio = () => {
    try {
      if (videoSourceNode) {
        videoSourceNode.disconnect();
        videoSourceNode = null;
      }
      if (soundtrackSourceNode) {
        soundtrackSourceNode.disconnect();
        soundtrackSourceNode = null;
      }
      if (audioCtx && audioCtx.state !== "closed") {
        void audioCtx.close();
        audioCtx = null;
      }
    } catch {
      /* ignore */
    }
  };

  if (withAudio || soundtrackAudio) {
    try {
      const AudioContextClass =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
        const dest = audioCtx.createMediaStreamDestination();

        // Mix video's original audio if present
        if (withAudio) {
          try {
            const videoSource = audioCtx.createMediaElementSource(video);
            videoSourceNode = videoSource;
            const originalGain = audioCtx.createGain();
            // Duck original audio slightly if custom soundtrack is active
            originalGain.gain.value = soundtrackAudio ? 0.35 : 1.0;
            videoSource.connect(originalGain);
            originalGain.connect(dest);
          } catch (e) {
            console.warn("Could not capture original video audio track (CORS or silent clip):", e);
          }
        }

        // Mix soundtrack if present
        if (soundtrackAudio) {
          try {
            const trackSource = audioCtx.createMediaElementSource(soundtrackAudio);
            soundtrackSourceNode = trackSource;
            const trackGain = audioCtx.createGain();
            trackGain.gain.value = Math.max(0, Math.min(1, soundtrackVolume));
            trackSource.connect(trackGain);
            trackGain.connect(dest);
          } catch (e) {
            console.warn("Could not connect soundtrack source to audio destination:", e);
          }
        }

        dest.stream.getAudioTracks().forEach((track) => combinedStream.addTrack(track));
      }
    } catch (e) {
      console.warn("Web Audio mixing failed, falling back to silent/canvas video:", e);
    }
  }

  const { mimeType, extension } = pickSupportedMimeType();
  const chunks: BlobPart[] = [];

  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: 4_500_000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  return new Promise<BrowserRenderResult>((resolve, reject) => {
    let animId: number | null = null;
    let settled = false;

    const stop = (err?: Error) => {
      if (settled) return;
      if (animId !== null) {
        cancelAnimationFrame(animId);
        animId = null;
      }

      if (soundtrackAudio) {
        try {
          soundtrackAudio.pause();
          soundtrackAudio.currentTime = 0;
        } catch {
          /* ignore */
        }
      }

      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          video.pause();
        } catch {
          /* ignore */
        }
        cleanupAudio();
        if (err) reject(err);
        else if (chunks.length === 0) reject(new Error("Recorder produced no data"));
        else resolve({ blob: new Blob(chunks, { type: mimeType }), extension, mimeType, thumbnail });
      };

      if (recorder.state !== "inactive") {
        recorder.onstop = () => setTimeout(finish, 0);
        setTimeout(finish, 8000);
        try {
          recorder.requestData?.();
        } catch {
          /* ignore */
        }
        try {
          recorder.stop();
        } catch {
          finish();
        }
      } else {
        finish();
      }
    };

    recorder.onerror = () => stop(new Error("MediaRecorder reported an error."));

    if (signal) {
      if (signal.aborted) {
        stop(new RenderCancelledError());
        return;
      }
      signal.addEventListener("abort", () => stop(new RenderCancelledError()), { once: true });
    }

    // 6. Play and record frame by frame
    recorder.start(250);

    // Resume AudioContext if suspended by browser autoplay policy
    if (audioCtx && audioCtx.state === "suspended") {
      void audioCtx.resume();
    }

    if (soundtrackAudio) {
      soundtrackAudio.currentTime = 0;
      soundtrackAudio.play().catch(() => {});
    }

    video.play().catch((err) => {
      stop(new Error(`Failed to play video: ${err?.message || "playback prevented"}`));
    });

    const targetEnd = safeStart + durationSeconds;

    const renderLoop = () => {
      if (settled) return;

      const current = video.currentTime;
      const elapsed = Math.max(0, current - safeStart);
      const progress = Math.min(100, Math.round((elapsed / durationSeconds) * 100));
      onProgress?.(progress);

      drawCover(ctx, video, width, height);
      drawBackground(ctx, layout.lines, layout.fontSize, width, height, backgroundColor);
      drawTextOverlay(ctx, layout, textColor);

      if (current >= targetEnd || video.ended) {
        stop();
        return;
      }

      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
  });
}
