import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { renderVariant, type HookPlacement } from "@/lib/render/browser-render";
import { renderSequence, releaseVideoDecoder, type SequenceSegment } from "@/lib/render/sequence-render";
import { RENDER_BUCKET, OUT_W, OUT_H } from "@/lib/render/pipeline";
import { sendTelegramNotificationFn, sendTelegramPreviewFn } from "@/lib/telegram.functions";

// In-memory cache of downloaded clip blobs so batch renders load instantly from RAM
const clipBlobCache = new Map<string, string>();

async function getCachedClipUrl(storagePath: string): Promise<string> {
  const cached = clipBlobCache.get(storagePath);
  if (cached) return cached;

  const { data: sData, error: sErr } = await supabase.storage.from("media").createSignedUrl(storagePath, 3600);
  if (sErr || !sData?.signedUrl) {
    throw new Error(`Could not sign storage URL for ${storagePath}`);
  }

  try {
    const res = await fetch(sData.signedUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    clipBlobCache.set(storagePath, blobUrl);
    return blobUrl;
  } catch (e) {
    // Fallback directly to signed URL if fetch fails
    return sData.signedUrl;
  }
}

export function RenderWorker() {
  const isProcessingRef = useRef(false);
  const processedJobsRef = useRef<Set<string>>(new Set());
  const notifiedJobsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let isMounted = true;
    let wakeLockSentinel: any = null;

    async function requestWakeLock() {
      try {
        if ("wakeLock" in navigator && (navigator as any).wakeLock) {
          wakeLockSentinel = await (navigator as any).wakeLock.request("screen");
        }
      } catch {
        /* Wake Lock is optional/unsupported on some mobile browsers */
      }
    }

    async function releaseWakeLock() {
      try {
        if (wakeLockSentinel) {
          await wakeLockSentinel.release();
          wakeLockSentinel = null;
        }
      } catch {
        /* ignore */
      }
    }

    async function processJob(jobId: string) {
      if (isProcessingRef.current || processedJobsRef.current.has(jobId)) {
        return;
      }

      isProcessingRef.current = true;
      processedJobsRef.current.add(jobId);

      const toastId = toast.loading("Background render worker starting...");
      await requestWakeLock();

      try {
        // 1. Fetch job details
        const { data: job, error: jobErr } = await supabase
          .from("render_jobs")
          .select("id, user_id, project_id, recipe_id, status")
          .eq("id", jobId)
          .single();

        if (jobErr || !job) {
          throw new Error(jobErr?.message || "Render job not found");
        }

        if (job.status !== "queued") {
          toast.dismiss(toastId);
          return;
        }

        // 2. Mark as processing in database
        // Atomic claim: only the single tab that flips queued->processing renders
        const { data: claimed } = await supabase
          .from("render_jobs")
          .update({
            status: "processing",
            progress: 5,
            started_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("status", "queued")
          .select("id");

        if (!claimed || claimed.length === 0) {
          toast.dismiss(toastId);
          return;
        }

        toast.loading("Rendering video frames in browser...", { id: toastId });

        // 3. Fetch recipe details
        const { data: recipe, error: recipeErr } = await supabase
          .from("video_recipes")
          .select("*")
          .eq("id", job.recipe_id)
          .single();

        if (recipeErr || !recipe) {
          throw new Error(recipeErr?.message || "Video recipe not found");
        }

        const isDna = (recipe.background_color ?? "").includes("dna");
        const targetDuration = recipe.duration && recipe.duration > 0 && recipe.duration <= 30 ? recipe.duration : 8;

        // 3b. Fetch audio/render hints
        const { data: hint } = await supabase
          .from("render_job_hints")
          .select("with_audio, soundtrack_url, audio_label, clip_ids, style")
          .eq("job_id", job.id)
          .maybeSingle();

        const withAudio = hint?.with_audio !== false;
        const soundtrackUrl = hint?.soundtrack_url ?? null;

        // Fetch clip metadata
        let videoUrl = "";
        let segmentsToRender: SequenceSegment[] = [];

        if (isDna) {
          let clipIds: string[] = [];
          if (hint?.clip_ids && Array.isArray(hint.clip_ids) && hint.clip_ids.length > 0) {
            clipIds = hint.clip_ids;
          } else {
            const { data: projClips } = await supabase
              .from("media_clips")
              .select("id, storage_path, duration_seconds")
              .eq("project_id", job.project_id)
              .order("created_at", { ascending: false })
              .limit(10);
            if (projClips && projClips.length > 0) {
              const shuffled = [...projClips].sort(() => 0.5 - Math.random());
              clipIds = shuffled.slice(0, 3).map((c) => c.id);
            }
          }

          if (clipIds.length === 0) {
            throw new Error("No clips available for DNA sequence render.");
          }

          const { data: fetchedClips, error: clipsErr } = await supabase
            .from("media_clips")
            .select("id, storage_path, duration_seconds")
            .in("id", clipIds);

          if (clipsErr || !fetchedClips || fetchedClips.length === 0) {
            throw new Error("Could not load clips for DNA sequence.");
          }

          const clipMap = new Map(fetchedClips.map((c) => [c.id, c]));
          const segDuration = targetDuration / clipIds.length;

          for (const cid of clipIds) {
            const c = clipMap.get(cid);
            if (!c) continue;

            const signed = await getCachedClipUrl(c.storage_path);
            const totalDur = c.duration_seconds || 5;
            const maxStart = Math.max(0, totalDur - segDuration);
            const startSec = Math.round(Math.random() * maxStart * 10) / 10;

            segmentsToRender.push({
              sourceUrl: signed,
              startSeconds: startSec,
              durationSeconds: segDuration,
            });
          }

          if (segmentsToRender.length === 0) {
            throw new Error("Failed to prepare segments for DNA render.");
          }
        } else {
          let clipStoragePath = "";
          if (recipe.clip_id) {
            const { data: clipData } = await supabase
              .from("media_clips")
              .select("storage_path")
              .eq("id", recipe.clip_id)
              .maybeSingle();
            clipStoragePath = clipData?.storage_path ?? "";
          }

          if (!clipStoragePath) {
            const { data: fallbackClip } = await supabase
              .from("media_clips")
              .select("storage_path")
              .eq("project_id", job.project_id)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            clipStoragePath = fallbackClip?.storage_path ?? "";
          }

          if (!clipStoragePath) {
            throw new Error("No video clip found to render.");
          }

          videoUrl = await getCachedClipUrl(clipStoragePath);
        }

        // Render video in-browser
        let blob: Blob;
        let mimeType: string;
        let extension: string;
        let thumbnail: Blob | undefined;

        if (isDna && segmentsToRender.length > 0) {
          const rendered = await renderSequence({
            segments: segmentsToRender,
            width: OUT_W,
            height: OUT_H,
            text: recipe.overlay_text || "",
            placement: (recipe.placement as HookPlacement) || "top",
            fontSize: recipe.font_size || undefined,
            textColor: recipe.text_color || undefined,
            backgroundColor: recipe.background_color || undefined,
            withAudio,
            soundtrackUrl,
            onProgress: (pct) => {
              const p = Math.min(85, Math.round(5 + pct * 0.8));
              supabase.from("render_jobs").update({ progress: p }).eq("id", job.id).then(() => {});
            },
          });
          blob = rendered.blob;
          mimeType = rendered.mimeType;
          extension = rendered.extension;
          thumbnail = rendered.thumbnail;
        } else {
          let startOffset = 0;
          if (recipe.start_seconds !== null && recipe.start_seconds !== undefined) {
            startOffset = recipe.start_seconds;
          }

          const rendered = await renderVariant({
            sourceUrl: videoUrl,
            startSeconds: startOffset,
            durationSeconds: targetDuration,
            width: OUT_W,
            height: OUT_H,
            text: recipe.overlay_text || "",
            placement: (recipe.placement as HookPlacement) || "top",
            fontSize: recipe.font_size || undefined,
            textColor: recipe.text_color || undefined,
            backgroundColor: recipe.background_color || undefined,
            withAudio,
            soundtrackUrl,
            onProgress: (pct) => {
              const p = Math.min(85, Math.round(5 + pct * 0.8));
              supabase.from("render_jobs").update({ progress: p }).eq("id", job.id).then(() => {});
            },
          });
          blob = rendered.blob;
          mimeType = rendered.mimeType;
          extension = rendered.extension;
          thumbnail = rendered.thumbnail;
        }

        toast.loading("Uploading rendered video...", { id: toastId });

        // 4. Upload rendered video to storage (with timeout so it can't hang forever)
        const outPath = `${job.project_id}/${job.id}.${extension}`;
        const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
          Promise.race([
            p,
            new Promise<T>((_, reject) =>
              setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
            ),
          ]);

        await supabase.from("render_jobs").update({ progress: 90 }).eq("id", job.id);

        const { error: uploadErr } = await withTimeout(
          supabase.storage
            .from(RENDER_BUCKET)
            .upload(outPath, blob, { contentType: mimeType, upsert: true }),
          60000,
          "Video upload",
        );

        if (uploadErr) {
          throw new Error(`Upload failed: ${uploadErr.message}`);
        }

        await supabase.from("render_jobs").update({ progress: 95 }).eq("id", job.id);

        let thumbPath: string | null = null;
        if (thumbnail) {
          thumbPath = `${job.project_id}/${job.id}_thumb.jpg`;
          try {
            await withTimeout(
              supabase.storage
                .from(RENDER_BUCKET)
                .upload(thumbPath, thumbnail, { contentType: "image/jpeg", upsert: true }),
              30000,
              "Thumbnail upload",
            );
          } catch (e) {
            console.warn("Thumbnail upload timed out or failed:", e);
            thumbPath = null;
          }
        }

        // 5. Update render job as finished
        await supabase
          .from("render_jobs")
          .update({
            status: "finished",
            progress: 100,
            output_video_path: outPath,
            thumbnail_path: thumbPath,
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.id);

        // 6. Save as an asset in user library
        await supabase.from("assets").insert({
          user_id: job.user_id,
          project_id: job.project_id,
          storage_path: outPath,
          thumbnail_path: thumbPath,
          title: recipe.overlay_text
            ? recipe.overlay_text.slice(0, 40) + "..."
            : "Browser Rendered Video",
          metadata: {
            rendered_in_browser: true,
            duration: targetDuration,
            recipe_id: job.recipe_id,
            recipe_index: recipe.variant_index ?? 0,
            has_audio: withAudio,
            soundtrack: hint?.audio_label ?? "original",
          },
        });

        toast.success("Video render complete!", { id: toastId });

        // Telegram Notification
        if (!notifiedJobsRef.current.has(job.id)) {
          notifiedJobsRef.current.add(job.id);
          sendTelegramNotificationFn({
            jobId: job.id,
            recipeIndex: recipe.variant_index ?? 1,
            overlayText: recipe.overlay_text || undefined,
            style: hint?.style || undefined,
            audioTrack: hint?.audio_label || (withAudio ? "Original" : "Muted"),
          }).catch(console.error);

          if (thumbPath) {
            sendTelegramPreviewFn({
              jobId: job.id,
              thumbnailPath: thumbPath,
              caption: `*Render Ready!*\\n${recipe.overlay_text ? `\\"${recipe.overlay_text}\\"` : "New video generated"}`,
            }).catch(console.error);
          }
        }
      } catch (err: any) {
        console.error("RenderWorker processing error:", err);
        toast.error(`Render failed: ${err.message}`, { id: toastId });

        await supabase
          .from("render_jobs")
          .update({
            status: "failed",
            error_message: err.message,
            finished_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      } finally {
        await releaseWakeLock();
        isProcessingRef.current = false;
      }
    }

    // 1. Initial poll for any queued jobs
    async function checkQueued() {
      if (!isMounted || isProcessingRef.current) return;
      const { data: queued } = await supabase
        .from("render_jobs")
        .select("id")
        .eq("status", "queued")
        .order("created_at", { ascending: true })
        .limit(1);

      if (queued && queued.length > 0) {
        processJob(queued[0].id);
      }
    }

    checkQueued();

    // 2. Realtime listener for incoming queued jobs
    const channel = supabase
      .channel("render_worker_queue")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "render_jobs" },
        (payload) => {
          if (payload.new && (payload.new as any).status === "queued") {
            processJob((payload.new as any).id);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "render_jobs" },
        (payload) => {
          if (payload.new && (payload.new as any).status === "queued") {
            processJob((payload.new as any).id);
          }
        },
      )
      .subscribe();

    // 3. Fallback polling loop every 5s in case realtime events drop
    const interval = setInterval(checkQueued, 5000);

    return () => {
      isMounted = false;
      clearInterval(interval);
      supabase.removeChannel(channel);
      releaseWakeLock();
    };
  }, []);

  return null;
}
