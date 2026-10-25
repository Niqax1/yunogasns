/** パスワード・ログイン中の端末（セッション）・Cookie の扱い */

import { USER_ID_PATTERN } from "./config";
import { HttpError, checkRateLimit, clientIpKey, json, readJson } from "./http";
import { mediaUrl } from "./media";

export type CurrentUser = { id: string; name: string; isAdmin: boolean; avatarKey: string | null };

export type UserRow = { id: string; name: string; is_admin: number; avatar_key: string | null };

// パスワードのハッシュは PBKDF2-SHA256。無料プランの CPU 時間（1リクエスト10ミリ秒）に収まる回数にしている。
// パスワードは自動発行のランダムな文字列（約50ビット）なので、この回数でも総当たりは現実的でない。
// scripts/account.mjs も同じ方式でハッシュを作るので、変えるときは両方そろえる。
const PBKDF2_ITERATIONS = 30_000;

// 見間違えやすい 0/o/1/l を除いた32文字。32 は 256 の約数なので、乱数の余りで選んでも偏らない
const PASSWORD_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
const PASSWORD_LENGTH = 10;

const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
const SESSION_COOKIE = "__Host-session";

// 存在しないIDでログインしようとしたときにも、同じ時間をかけて照合するためのハッシュ
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

export function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH));
  return Array.from(bytes, (byte) => PASSWORD_CHARS.charAt(byte % PASSWORD_CHARS.length)).join("");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(hash))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const actual = await pbkdf2(password, fromBase64(salt), Number(iterations));
  const expected = fromBase64(hash);
  return actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export function toCurrentUser(row: UserRow): CurrentUser {
  return { id: row.id, name: row.name, isAdmin: row.is_admin === 1, avatarKey: row.avatar_key };
}

/** 画面に返すアカウント情報 */
export function publicUser(user: CurrentUser) {
  return { id: user.id, name: user.name, isAdmin: user.isAdmin, avatarUrl: user.avatarKey ? mediaUrl(user.avatarKey) : null };
}

/** Cookie のトークンから、ログイン中のアカウントを調べる。ログインしていなければ null */
export async function getCurrentUser(env: Env, request: Request, now: number): Promise<CurrentUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.is_admin, u.avatar_key FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
  )
    .bind(await sha256(token), now)
    .first<UserRow>();
  return row ? toCurrentUser(row) : null;
}

export async function login(env: Env, request: Request, now: number): Promise<Response> {
  await checkRateLimit(env.LOGIN_LIMITER, clientIpKey(request), "ログインの試行が多すぎます。1分ほど待ってからお試しください。");
  const input = await readJson(request);
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const password = typeof input.password === "string" ? input.password.trim() : "";

  // ID は大文字・小文字を区別せずに探す（users.id は COLLATE NOCASE）
  const row = USER_ID_PATTERN.test(id)
    ? await env.DB.prepare("SELECT id, name, is_admin, avatar_key, password_hash FROM users WHERE id = ?1")
        .bind(id)
        .first<UserRow & { password_hash: string }>()
    : null;
  // IDが存在しない場合も同じだけ時間をかけ、応答時間からIDの有無を推測されないようにする
  const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !valid) throw new HttpError(401, "IDかパスワードが違います。");

  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256(token), row.id, now + SESSION_TTL_SECONDS * 1000)
    .run();
  return json({ user: publicUser(toCurrentUser(row)) }, 200, {
    "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
  });
}

export async function logout(env: Env, request: Request): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256(token)).run();
  return json({ ok: true }, 200, {
    "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  });
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

async function sha256(text: string): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
