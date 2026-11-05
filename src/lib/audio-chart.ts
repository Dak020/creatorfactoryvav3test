export const TRENDING_AUDIO_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function isTrendingAudioFresh(
  lastSyncedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!lastSyncedAt) return false;
  const syncedAt = Date.parse(lastSyncedAt);
  if (!Number.isFinite(syncedAt)) return false;
  const age = now - syncedAt;
  return age >= 0 && age <= TRENDING_AUDIO_MAX_AGE_MS;
}