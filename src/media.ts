/** 写真・アイコン画像の保存と配信（Workers KV） */

import { HttpError } from "./http";

// 投稿の写真は、投稿の保存期間（7日）より1日長い期限つきで保存し、期限が来たら KV が自動で消す
export const POST_IMAGE_TTL_SECONDS = 8 * 24 * 60 * 60;

// 画像はブラウザ側で縮小・JPEG に変換してから送るので、通常は数百KB程度
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 512 * 1024;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** 投稿に保存する写真の情報（posts.images の JSON の要素） */
export type StoredImage = { k: string; w: number; h: number };

export function mediaUrl(key: string): string {
  return `/media/${key}`;
}

/** 画像として受け付けられるか。種類は送られてきた Content-Type ではなく、ファイルの先頭のバイト列で判定する */
export function assertImage(bytes: Uint8Array): void {
  if (!sniffImageType(bytes)) throw new HttpError(415, "画像は JPEG・PNG・WebP のいずれかにしてください。");
}

/** 画像を保存してキーを返す */
export async function storeImage(env: Env, prefix: "p" | "a", bytes: Uint8Array, ttlSeconds?: number): Promise<string> {
  const type = sniffImageType(bytes);
  if (!type) throw new HttpError(415, "画像は JPEG・PNG・WebP のいずれかにしてください。");
  const key = `${prefix}/${crypto.randomUUID()}`;
  await env.MEDIA.put(key, bytes, { metadata: { type }, ...(ttlSeconds ? { expirationTtl: ttlSeconds } : {}) });
  return key;
}

/**
 * 画像を消す。KV の削除は無料枠で1日1,000回までなので、失敗しても気にしない
 * （投稿の写真は期限が来れば自動で消える）。
 */
export async function deleteImages(env: Env, keys: string[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => env.MEDIA.delete(key)));
}

export async function serveMedia(env: Env, key: string): Promise<Response> {
  const { value, metadata } = await env.MEDIA.getWithMetadata<{ type?: string }>(key, "stream");
  if (!value) return new Response("見つかりません", { status: 404 });
  const type = IMAGE_TYPES.find((t) => t === metadata?.type) ?? "application/octet-stream";
  return new Response(value, {
    headers: {
      "content-type": type,
      // キーは画像ごとに毎回新しく作るので、同じURLの中身が変わることはない。ログインした人しか見られないので private
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

export function parseStoredImages(json: string | null): StoredImage[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isStoredImage) : [];
  } catch {
    return [];
  }
}

function isStoredImage(value: unknown): value is StoredImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "k" in value &&
    typeof value.k === "string" &&
    "w" in value &&
    typeof value.w === "number" &&
    "h" in value &&
    typeof value.h === "number"
  );
}

function sniffImageType(bytes: Uint8Array): ImageType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
