import { supabase } from "@/integrations/supabase/client";

const RENDER_BUCKET = "renders";
const SIGNED_TTL = 60 * 60 * 6;
/** Re-use a resolved URL for most of its lifetime so refetches don't churn <video src>. */
const CACHE_MS = 1000 * 60 * 60 * 4;

type CacheEntry = { url: string | null; at: number };
const urlCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | null>>();

export function forgetRenderUrl(path: string | null | undefined) {
  if (path) urlCache.delete(path);
}

/**
 * Resolve a stored render output path into a playable signed URL.
 * Returns null when the row has no path or the file no longer exists in storage,
 * so a database record alone is never treated as a successful render.
 *
 * Results are memoized per path: repeated list refetches return the *same*
 * URL string, which keeps React from tearing down and re-buffering the player.
 */
export async function resolveRenderUrl(
  path: string | null | undefined,
  expiresIn = SIGNED_TTL,
): Promise<string | null> {
  if (!path) return null;
  // Absolute URLs (legacy rows) are already playable.
  if (/^https?:\/\//i.test(path)) return path;

  const cached = urlCache.get(path);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.url;

  const pending = inflight.get(path);
  if (pending) return pending;

  const task = (async () => {
    const { data, error } = await supabase.storage
      .from(RENDER_BUCKET)
      .createSignedUrl(path, expiresIn);
    if (error || !data?.signedUrl) return null;

    // Confirm the object actually exists (a signed URL is minted even for missing files).
    try {
      const head = await fetch(data.signedUrl, { method: "HEAD" });
      if (!head.ok) return null;
    } catch {
      return null;
    }
    return data.signedUrl;
  })()
    .then((url) => {
      urlCache.set(path, { url, at: Date.now() });
      return url;
    })
    .finally(() => {
      inflight.delete(path);
    });

  inflight.set(path, task);
  return task;
}

export function renderFilename(path: string | null | undefined, label: string) {
  const ext = path?.split(".").pop()?.toLowerCase();
  const safe = ext && ext.length <= 4 ? ext : "mp4";
  return `${label}.${safe}`;
}

export async function downloadRender(url: string, filename: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  } catch (err) {
    console.warn("Direct blob download failed, falling back to direct URL navigation:", err);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}
