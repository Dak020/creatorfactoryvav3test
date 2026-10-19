import { HOOK_PLACEMENTS, MEDIA_CATEGORIES } from "@/lib/constants";

export const TELEGRAM_DNA_ROLES = ["start", "middle", "end", "none"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function compactTelegramId(id: string): string {
  if (!UUID_PATTERN.test(id)) return id;
  return Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");
}

export function expandTelegramId(value: string): string {
  if (UUID_PATTERN.test(value)) return value;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 16) return value;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return value;
  }
}

export function clipProjectCallback(assetId: string, projectId: string): string {
  return `cproj:${compactTelegramId(assetId)}:${compactTelegramId(projectId)}`;
}

export function clipTagCallback(step: "cdna" | "ccat" | "cplc", assetId: string, value: string): string {
  return `${step}:${compactTelegramId(assetId)}:${value}`;
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

export function callbackFitsTelegram(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= 64;
}