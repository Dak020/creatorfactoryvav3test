import { HOOK_PLACEMENTS, MEDIA_CATEGORIES } from "@/lib/constants";

export const TELEGRAM_DNA_ROLES = ["start", "middle", "end", "none"] as const;
export const MAX_TELEGRAM_VIDEO_BYTES = 20 * 1024 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function compactTelegramId(id: string): string {
  if (!UUID_PATTERN.test(id)) return id;
  const hex = id.replace(/-/g, "");
  const bytes = Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
  return toBase64Url(bytes);
}

export function expandTelegramId(value: string): string {
  if (UUID_PATTERN.test(value)) return value;
  const bytes = fromBase64Url(value);
  if (!bytes || bytes.length !== 16) return value;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function clipProjectCallback(assetId: string, projectId: string): string {
  return `cproj:${compactTelegramId(assetId)}:${compactTelegramId(projectId)}`;
}

export function clipTagCallback(step: "cdna" | "ccat" | "cplc", assetId: string, value: string): string {
  return `${step}:${compactTelegramId(assetId)}:${value}`;
}

export function buildUnassignedClipKeyboard(
  projectId: string,
  clips: Array<{ id: string; filename: string }>,
) {
  const buttons = clips.slice(0, 6).map((clip) => ({
    text: `📎 ${clip.filename.slice(0, 30)}`,
    callback_data: clipProjectCallback(clip.id, projectId),
  }));
  if (buttons.length === 0) return undefined;
  return { inline_keyboard: buttons.map((button) => [button]) };
}

export function isDnaRole(value: string): boolean {
  return (TELEGRAM_DNA_ROLES as readonly string[]).includes(value);
}

export function isMediaCategory(value: string): boolean {
  return (MEDIA_CATEGORIES as readonly string[]).includes(value);
}

export function isHookPlacement(value: string): boolean {
  return HOOK_PLACEMENTS.some((placement) => placement.value === value);
}

export function isSupportedTelegramVideo(filename: string, mimeType = ""): boolean {
  const extension = /\.(mp4|m4v|mov|qt)$/i.test(filename);
  const type = mimeType.toLowerCase();
  return extension || ["video/mp4", "video/quicktime", "video/x-m4v", "video/m4v"].includes(type);
}

export function callbackFitsTelegram(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= 64;
}