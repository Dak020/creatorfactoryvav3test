let sharedAudioCtx: AudioContext | null = null;

export function getOrUnlockAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === "suspended") {
    void sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

if (typeof window !== "undefined") {
  const unlock = () => {
    getOrUnlockAudioContext();
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

export interface SequenceSegment {
  clipId?: string;
  url: string;
  sourceIn: number;
  sourceOut: number;
  speed: number;
  outputDuration: number;
}

export interface SequenceRenderOptions {
  segments: SequenceSegment[];
  width: number;
  height: number;
  text: string;
  placement: "top" | "middle" | "bottom";
  withAudio?: boolean;
  soundtrackUrl?: string | null;
  soundtrackVolume?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface SequenceRenderResult {
  blob: Blob;
  extension: "mp4" | "webm";
  mimeType: string;
  thumbnail?: Blob;
}

function pickSupportedMimeType(): string {
  const candidates = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    "video/mp4",
    'video/webm; codecs="vp9, opus"',
    'video/webm; codecs="vp8, opus"',
    "video/webm",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "video/webm";
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let curr = "";
  for (const w of words) {
    const test = curr ? `${curr} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth) {
      curr = test;
    } else {
      if (curr) lines.push(curr);
      curr = w;
    }
  }
  if (curr) lines.push(curr);
  return lines;
}

function layoutHookOverlay(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
  placement: "top" | "middle" | "bottom",
) {
  const maxTextWidth = width * 0.82;
  let fontSize = Math.round(width * 0.06);
  ctx.font = `800 ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;

  let lines = wrapLines(ctx, text, maxTextWidth);
  while (lines.length > 3 && fontSize > 24) {
    fontSize -= 2;
    ctx.font = `800 ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
    lines = wrapLines(ctx, text, maxTextWidth);
  }

  const lineHeight = Math.round(fontSize * 1.25);
  const padX = Math.round(fontSize * 0.55);
  const padY = Math.round(fontSize * 0.35);

  const measured = lines.map((l) => ctx.measureText(l).width);
  const boxWidth = Math.min(width * 0.9, Math.max(...measured) + padX * 2);
  const boxHeight = lines.length * lineHeight + padY * 2;

  let top = height * 0.12;
  if (placement === "middle") {
    top = (height - boxHeight) / 2;
  } else if (placement === "bottom") {
    top = height * 0.72;
  }

  const left = (width - boxWidth) / 2;
  return { left, top, boxWidth, boxHeight, lines, fontSize, lineHeight, padX, padY };
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: ReturnType<typeof layoutHookOverlay>,
  font: string,
) {
  const radius = 12;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(overlay.left, overlay.top, overlay.boxWidth, overlay.boxHeight, radius);
  ctx.fill();

  ctx.fillStyle = "#000000";
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const centerX = overlay.left + overlay.boxWidth / 2;
  overlay.lines.forEach((line, idx) => {
    const y =
      overlay.top + overlay.padY + idx * overlay.lineHeight + overlay.lineHeight / 2;
    ctx.fillText(line, centerX, y);
  });
  ctx.restore();
}

export function releaseVideoDecoder(video: HTMLVideoElement) {
  try {
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch {
    /* ignore cleanup fallback */
  }
}

async function seekVideo(video: HTMLVideoElement, targetTime: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Render cancelled");
  const clamped = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : targetTime, targetTime));
  if (Math.abs(video.currentTime - clamped) < 0.05) return;

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Render cancelled"));
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 1200);

    try {
      video.currentTime = clamped;
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetW: number,
  targetH: number,
) {
  const vw = video.videoWidth || targetW;
  const vh = video.videoHeight || targetH;
  const scale = Math.max(targetW / vw, targetH / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (targetW - dw) / 2;
  const dy = (targetH - dh) / 2;
  ctx.drawImage(video, dx, dy, dw, dh);
}

interface PreparedSegment {
  video: HTMLVideoElement;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  outputDuration: number;
  ready: boolean;
}

export async function renderSequence(
  opts: SequenceRenderOptions,
): Promise<SequenceRenderResult> {
  const { segments, width, height, text, placement, signal } = opts;
  const withAudio = opts.withAudio ?? false;
  const soundtrackUrl = opts.soundtrackUrl ?? null;

  if (segments.length === 0) {
    throw new Error("No sequence segments provided for rendering.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not acquire 2D rendering context.");

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  const overlay = layoutHookOverlay(ctx, text, width, height, placement);
  const drawFont = `800 ${overlay.fontSize}px Inter, system-ui, -apple-system, sans-serif`;

  const prepared: PreparedSegment[] = [];
  for (const seg of opts.segments) {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.preload = "auto";
    v.playsInline = true;
    v.muted = !withAudio;
    v.src = seg.url;

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Render cancelled"));
        return;
      }
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to load video segment: ${seg.url}`));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Render cancelled"));
      };
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        v.removeEventListener("loadeddata", onLoaded);
        v.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      v.addEventListener("loadeddata", onLoaded, { once: true });
      v.addEventListener("error", onError, { once: true });
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out loading video clip metadata."));
      }, 30_000);

      try {
        v.load();
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    prepared.push({
      video: v,
      sourceStart: seg.sourceIn,
      sourceEnd: seg.sourceOut,
      speed: seg.speed,
      outputDuration: seg.outputDuration,
      ready: true,
    });
  }

  const drawCurrentFrame = (target: PreparedSegment) => {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    try {
      drawCover(ctx, target.video, width, height);
    } catch {
      /* ignore canvas draw frame fallback */
    }

    drawOverlay(ctx, overlay, drawFont);
  };

  drawCurrentFrame(prepared[0]!);

  const thumbnail: Blob | undefined = await new Promise((res) => {
    canvas.toBlob((b) => res(b ?? undefined), "image/jpeg", 0.85);
  });

  const fps = 30;
  const canvasStream = canvas.captureStream(fps);

  let audioCtx: AudioContext | null = null;
  let soundtrackElement: HTMLAudioElement | null = null;
  const audioTracks: MediaStreamTrack[] = [];

  const cleanupAudio = () => {
    try {
      soundtrackElement?.pause();
      if (soundtrackElement) {
        soundtrackElement.removeAttribute("src");
        soundtrackElement.load();
      }
    } catch {
      /* ignore */
    }
    // Retain shared AudioContext across renders so it stays unlocked without requiring a new user gesture.
  };

  try {
    audioCtx = (withAudio || soundtrackUrl) ? getOrUnlockAudioContext() : null;
    if (audioCtx) {
      const dest = audioCtx.createMediaStreamDestination();

      // Silent keepalive: feeds continuous inaudible samples so Chromium's
      // audio clock never starves during segment transitions, preventing empty recordings.
      try {
        const keepaliveOsc = audioCtx.createOscillator();
        const keepaliveGain = audioCtx.createGain();
        keepaliveGain.gain.value = 0.00001;
        keepaliveOsc.connect(keepaliveGain);
        keepaliveGain.connect(dest);
        keepaliveOsc.start();
      } catch {
        /* ignore keepalive fallback */
      }

      let hasSource = false;

      if (withAudio) {
        prepared.forEach((p) => {
          try {
            const source = audioCtx!.createMediaElementSource(p.video);
            source.connect(dest);
            hasSource = true;
          } catch (e) {
            console.warn("Could not route segment audio:", e);
          }
        });
      }

      if (soundtrackUrl) {
        try {
          const audio = new Audio();
          audio.crossOrigin = "anonymous";
          audio.preload = "auto";
          audio.src = soundtrackUrl;
          audio.volume = Math.max(0, Math.min(1, opts.soundtrackVolume ?? 1));
          soundtrackElement = audio;

          await new Promise<void>((resolve, reject) => {
            const ok = () => {
              cleanup();
              resolve();
            };
            const fail = () => {
              cleanup();
              reject(new Error("Failed to load soundtrack."));
            };
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error("Timed out loading soundtrack."));
            }, 20_000);
            const cleanup = () => {
              clearTimeout(timeout);
              audio.removeEventListener("canplaythrough", ok);
              audio.removeEventListener("error", fail);
            };
            audio.addEventListener("canplaythrough", ok, { once: true });
            audio.addEventListener("error", fail, { once: true });
            try {
              audio.load();
            } catch {
              /* ignore */
            }
          });

          audio.currentTime = 0;
          const trackSource = audioCtx.createMediaElementSource(audio);
          trackSource.connect(dest);
          hasSource = true;
        } catch (soundtrackErr) {
          console.warn("Could not bind soundtrack track; proceeding without it:", soundtrackErr);
        }
      }

      if (hasSource) {
        dest.stream.getAudioTracks().forEach((t) => audioTracks.push(t));
      }
    }
  } catch (err) {
    console.warn("Audio pipeline init failed; rendering video-only sequence:", err);
  }

  // Renders started without a tap leave the AudioContext suspended. A recorder
  // with a silent, clock-less audio track never emits any data, so fall back to a video-only recording.
  if (audioCtx && audioTracks.length > 0 && audioCtx.state !== "running") {
    try {
      await Promise.race([audioCtx.resume(), new Promise((r) => setTimeout(r, 6000))]);
    } catch {
      /* ignore */
    }
    if ((audioCtx.state as string) !== "running") {
      console.warn("AudioContext could not start; rendering without sound.");
      audioTracks.length = 0;
    }
  }
  if (audioTracks.length === 0) {
    prepared.forEach((p) => {
      p.video.muted = true;
    });
  }

  const videoOnlyMime = (m: string) => {
    if (!m.includes(",")) return m;
    const v = m.replace(/,\s*(opus|mp4a[^"]*)/, "");
    return MediaRecorder.isTypeSupported(v) ? v : m.split(";")[0]!;
  };

  let mimeType = pickSupportedMimeType();
  if (audioTracks.length === 0) mimeType = videoOnlyMime(mimeType);
  let extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const chunks: Blob[] = [];
  const makeRecorder = (tracks: MediaStreamTrack[], mt: string) => {
    const r = new MediaRecorder(new MediaStream(tracks), { mimeType: mt, videoBitsPerSecond: 6_000_000 });
    r.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    return r;
  };

  let recorder: MediaRecorder;
  try {
    recorder = makeRecorder([...canvasStream.getVideoTracks(), ...audioTracks], mimeType);
  } catch {
    mimeType = videoOnlyMime(mimeType);
    extension = mimeType.includes("mp4") ? "mp4" : "webm";
    recorder = makeRecorder(canvasStream.getVideoTracks(), mimeType);
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.outputDuration, 0);

  return new Promise<SequenceRenderResult>((resolve, reject) => {
    let animId: number | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let segIdx = 0;
    let totalPlayedDuration = 0;
    let active = prepared[0]!;

    const stop = (err?: Error) => {
      if (stopped) return;
      stopped = true;

      if (animId !== null) cancelAnimationFrame(animId);
      if (fallbackInterval !== null) clearInterval(fallbackInterval);

      prepared.forEach((p) => {
        try {
          p.video.pause();
        } catch {
          /* ignore */
        }
        releaseVideoDecoder(p.video);
      });

      cleanupAudio();

      if (err) {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          /* ignore */
        }
        reject(err);
        return;
      }

      recorder.onstop = () => {
        const outBlob = new Blob(chunks, { type: mimeType });
        if (outBlob.size === 0) {
          reject(new Error("Render output was zero bytes."));
          return;
        }
        resolve({
          blob: outBlob,
          extension: extension as "mp4" | "webm",
          mimeType,
          thumbnail,
        });
      };

      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
        } else {
          recorder.onstop?.(new Event("stop"));
        }
      } catch (e) {
        reject(e as Error);
      }
    };

    const preseek = (idx: number) => {
      if (idx < prepared.length) {
        const next = prepared[idx]!;
        void seekVideo(next.video, next.sourceStart, signal);
      }
    };

    recorder.start(100);

    if (signal?.aborted) {
      stop(new Error("Render cancelled"));
      return;
    }
    signal?.addEventListener("abort", () => stop(new Error("Render cancelled")), { once: true });

    void (async () => {
      try {
        await seekVideo(active.video, active.sourceStart, signal);
        active.video.playbackRate = active.speed;
        await active.video.play();
        preseek(1);
      } catch (e) {
        try {
          active.video.muted = true;
          await active.video.play();
        } catch (inner) {
          stop(inner as Error);
          return;
        }
      }

      if (soundtrackElement) {
        try {
          soundtrackElement.currentTime = 0;
          await soundtrackElement.play();
        } catch {
          /* ignore soundtrack play error fallback */
        }
      }

      renderLoop();
    })();

    let switchingSeg = false;

    const renderLoop = () => {
      if (stopped) return;

      if (!switchingSeg) {
        drawCurrentFrame(active);
      }

      const currentVideoTime = active.video.currentTime;
      const segPlayed = Math.max(0, (currentVideoTime - active.sourceStart) / active.speed);
      const overallPlayed = totalPlayedDuration + segPlayed;

      if (opts.onProgress) {
        const pct = Math.min(100, Math.round((overallPlayed / totalDuration) * 100));
        opts.onProgress(pct);
      }

      if (audioCtx && audioCtx.state === "suspended") {
        void audioCtx.resume();
      }

      if (soundtrackElement && soundtrackElement.paused && !stopped) {
        void soundtrackElement.play().catch(() => {});
      }

      const segFinished =
        currentVideoTime >= active.sourceEnd - 0.04 ||
        segPlayed >= active.outputDuration - 0.04 ||
        active.video.ended;

      const hitDuration = overallPlayed >= totalDuration - 0.04;

      if (hitDuration) {
        stop();
        return;
      }

      if (segFinished && !switchingSeg) {
        switchingSeg = true;
        totalPlayedDuration += active.outputDuration;
        segIdx++;

        if (segIdx >= prepared.length) {
          stop();
          return;
        }

        try {
          active.video.pause();
        } catch {
          /* ignore */
        }

        const next = prepared[segIdx]!;
        active = next;

        void (async () => {
          try {
            await seekVideo(next.video, next.sourceStart, signal);
            next.video.playbackRate = next.speed;
            await next.video.play();
          } catch {
            try {
              next.video.muted = true;
              await next.video.play();
            } catch (e) {
              stop(e as Error);
              return;
            }
          }
          preseek(segIdx + 1);
          switchingSeg = false;
        })();
      }

      animId = requestAnimationFrame(renderLoop);
    };

    // Background tab clock fallback
    const intervalMs = Math.round(1000 / fps);
    fallbackInterval = setInterval(async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") return;

      drawCurrentFrame(active);

      const currentVideoTime = active.video.currentTime;
      const segPlayed = Math.max(0, (currentVideoTime - active.sourceStart) / active.speed);
      const overallPlayed = totalPlayedDuration + segPlayed;

      if (opts.onProgress) {
        const pct = Math.min(100, Math.round((overallPlayed / totalDuration) * 100));
        opts.onProgress(pct);
      }

      const segFinished =
        currentVideoTime >= active.sourceEnd ||
        segPlayed >= active.outputDuration ||
        active.video.ended;

      const hitDuration =
        overallPlayed >= totalDuration ||
        currentVideoTime >= active.sourceEnd ||
        segPlayed >= active.outputDuration;

      if (hitDuration) {
        stop();
        return;
      }

      if (segFinished) {
        switchingSeg = true;
        try {
          active.video.pause();
        } catch {
          /* ignore */
        }

        totalPlayedDuration += active.outputDuration;
        segIdx++;

        if (segIdx >= prepared.length) {
          stop();
          return;
        }

        const next = prepared[segIdx]!;
        active = next;

        try {
          await seekVideo(next.video, next.sourceStart, signal);
        } catch {
          /* ignore seek error fallback */
        }

        next.video.playbackRate = next.speed;
        try {
          await next.video.play();
        } catch {
          try {
            next.video.muted = true;
            await next.video.play();
          } catch (e) {
            stop(e as Error);
            return;
          }
        }

        preseek(segIdx + 1);
        switchingSeg = false;
      }
    }, intervalMs);
  });
}
