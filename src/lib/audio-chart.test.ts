import { describe, expect, it } from "vitest";
import { isTrendingAudioFresh, TRENDING_AUDIO_MAX_AGE_MS } from "./audio-chart";

describe("trending audio chart freshness", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");

  it("accepts a chart refreshed within the last six hours", () => {
    expect(
      isTrendingAudioFresh(new Date(now - TRENDING_AUDIO_MAX_AGE_MS).toISOString(), now),
    ).toBe(true);
  });

  it("rejects stale, missing, invalid, and future sync timestamps", () => {
    expect(
      isTrendingAudioFresh(new Date(now - TRENDING_AUDIO_MAX_AGE_MS - 1).toISOString(), now),
    ).toBe(false);
    expect(isTrendingAudioFresh(null, now)).toBe(false);
    expect(isTrendingAudioFresh("not-a-date", now)).toBe(false);
    expect(isTrendingAudioFresh(new Date(now + 1).toISOString(), now)).toBe(false);
  });
});