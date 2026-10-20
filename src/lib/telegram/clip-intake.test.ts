import { describe, expect, it } from "vitest";
import { HOOK_PLACEMENTS, MEDIA_CATEGORIES } from "@/lib/constants";
import {
  callbackFitsTelegram,
  MAX_TELEGRAM_VIDEO_BYTES,
  clipProjectCallback,
  clipTagCallback,
  compactTelegramId,
  expandTelegramId,
  isDnaRole,
  isHookPlacement,
  isMediaCategory,
  isSupportedTelegramVideo,
} from "./clip-intake";

const assetId = "9afa8047-20f6-4ba1-a943-24540d899d3b";
const projectId = "cb2ba85d-0ac2-4198-92b1-f580ae94c52c";

describe("Telegram clip intake choices", () => {
  it("uses the same categories and placements as the Media Library", () => {
    expect(MEDIA_CATEGORIES).toEqual([
      "Product",
      "UGC",
      "Lifestyle",
      "Close-up",
      "Unboxing",
      "Reaction",
      "Other",
    ]);
    expect(HOOK_PLACEMENTS.map((placement) => placement.value)).toEqual(["top", "middle", "bottom"]);
    expect(isMediaCategory("Close-up")).toBe(true);
    expect(isHookPlacement("middle")).toBe(true);
    expect(isDnaRole("start")).toBe(true);
    expect(isDnaRole("admin")).toBe(false);
  });

  it("keeps project and tagging buttons within Telegram's 64-byte callback limit", () => {
    const callbacks = [
      clipProjectCallback(assetId, projectId),
      clipTagCallback("cdna", assetId, "middle"),
      clipTagCallback("ccat", assetId, "Close-up"),
      clipTagCallback("cplc", assetId, "bottom"),
    ];
    expect(callbacks.every(callbackFitsTelegram)).toBe(true);
  });

  it("caps Telegram video uploads at 20 MiB", () => {
    expect(MAX_TELEGRAM_VIDEO_BYTES).toBe(20 * 1024 * 1024);
  });

  it("accepts the same MP4/MOV formats as the web media library", () => {
    expect(isSupportedTelegramVideo("clip.mp4", "application/octet-stream")).toBe(true);
    expect(isSupportedTelegramVideo("clip.mov")).toBe(true);
    expect(isSupportedTelegramVideo("clip.webm", "video/webm")).toBe(false);
  });

  it("round-trips compact UUIDs while preserving legacy full UUID callbacks", () => {
    expect(compactTelegramId(assetId)).toHaveLength(22);
    expect(expandTelegramId(compactTelegramId(assetId))).toBe(assetId);
    expect(expandTelegramId(projectId)).toBe(projectId);
  });
});