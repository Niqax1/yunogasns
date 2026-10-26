/** ログイン中の本人のアカウント（表示名・アイコン・通知の設定・通知を受け取る端末） */

import { type CurrentUser, publicUser } from "./auth";
import { MAX_NAME_LENGTH } from "./config";
import { HttpError, cleanText, json, readBody, readJson } from "./http";
import { MAX_AVATAR_BYTES, deleteImages, storeImage } from "./media";
import { unreadNotices } from "./notices";
import { isPushEndpoint, isValidSubscriptionKeys } from "./push";

// 画面での設定の名前 → users の列
const NOTIFY_SETTINGS = {
  comments: "notify_comments",
  quotes: "notify_quotes",
  likes: "notify_likes",
  follows: "notify_follows",
  notices: "notify_notices",
} as const;
type NotifySetting = keyof typeof NOTIFY_SETTINGS;
const isNotifySetting = (key: string): key is NotifySetting => key in NOTIFY_SETTINGS;

/** ログイン中の本人の情報と、未読のお知らせ */
export async function getMe(env: Env, me: CurrentUser): Promise<Response> {
  return json({ user: publicUser(me), unreadNotices: await unreadNotices(env, me) });
}

/** 表示名を変える。過去の投稿にも新しい名前が表示される */
export async function updateMe(env: Env, request: Request, me: CurrentUser): Promise<Response> {
  const input = await readJson(request);
  const name = cleanText(input.name, "アカウント名", MAX_NAME_LENGTH, { multiline: false });
  await env.DB.prepare("UPDATE users SET name = ?2 WHERE id = ?1").bind(me.id, name).run();
  return json({ user: publicUser({ ...me, name }) });
}

/** アイコン画像を変える。画像はブラウザで正方形に縮小してから送られてくる */
export async function setAvatar(env: Env, ctx: ExecutionContext, request: Request, me: CurrentUser): Promise<Response> {
  const bytes = await readBody(request, MAX_AVATAR_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "画像を選んでください。");
  const key = await storeImage(env, "a", bytes);
  await env.DB.prepare("UPDATE users SET avatar_key = ?2 WHERE id = ?1").bind(me.id, key).run();
  if (me.avatarKey) ctx.waitUntil(deleteImages(env, [me.avatarKey]));
  return json({ user: publicUser({ ...me, avatarKey: key }) });
}

export async function removeAvatar(env: Env, ctx: ExecutionContext, me: CurrentUser): Promise<Response> {
  await env.DB.prepare("UPDATE users SET avatar_key = NULL WHERE id = ?1").bind(me.id).run();
  if (me.avatarKey) ctx.waitUntil(deleteImages(env, [me.avatarKey]));
  return json({ user: publicUser({ ...me, avatarKey: null }) });
}

/**
 * 通知の設定。vapidPublicKey は端末を通知の受け取り先に登録するときに使う鍵で、
 * サーバーに通知を送るための鍵が設定されていなければ null（通知は使えない）。
 */
export async function getNotificationSettings(env: Env, me: CurrentUser): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT notify_comments, notify_quotes, notify_likes, notify_follows, notify_notices FROM users WHERE id = ?1",
  )
    .bind(me.id)
    .first<Record<(typeof NOTIFY_SETTINGS)[NotifySetting], number>>();
  const settings = Object.fromEntries(
    Object.entries(NOTIFY_SETTINGS).map(([key, column]) => [key, row?.[column] === 1]),
  );
  const vapidPublicKey = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? env.VAPID_PUBLIC_KEY : null;
  return json({ settings, vapidPublicKey });
}

/** 通知の設定を変える（{"comments": true, "likes": false, ...} のうち送られてきたものだけ） */
export async function updateNotificationSettings(env: Env, request: Request, me: CurrentUser): Promise<Response> {
  const input = await readJson(request);
  const keys = Object.keys(input);
  if (keys.length === 0 || !keys.every((key) => isNotifySetting(key) && typeof input[key] === "boolean")) {
    throw new HttpError(400, "送信内容が正しくありません。");
  }
  const settings = keys.filter(isNotifySetting);
  // 列名はこのファイルで決めたものだけを使う
  const assignments = settings.map((key, i) => `${NOTIFY_SETTINGS[key]} = ?${i + 2}`).join(", ");
  await env.DB.prepare(`UPDATE users SET ${assignments} WHERE id = ?1`)
    .bind(me.id, ...settings.map((key) => (input[key] ? 1 : 0)))
    .run();
  return getNotificationSettings(env, me);
}

/** この端末を通知の受け取り先に登録する（ブラウザの PushSubscription の内容をそのまま受け取る） */
export async function savePushSubscription(env: Env, request: Request, me: CurrentUser, now: number): Promise<Response> {
  const input = await readJson(request);
  const endpoint = typeof input.endpoint === "string" ? input.endpoint : "";
  const keys = typeof input.keys === "object" && input.keys !== null ? (input.keys as Record<string, unknown>) : {};
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  if (endpoint.length > 2000 || !isPushEndpoint(endpoint) || !isValidSubscriptionKeys(p256dh, auth)) {
    throw new HttpError(400, "通知の登録情報が正しくありません。");
  }
  // 同じ端末で別の人がログインしたら、その人の端末として登録し直す。内容が同じなら書き込まない
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
     WHERE user_id != excluded.user_id OR p256dh != excluded.p256dh OR auth != excluded.auth`,
  )
    .bind(endpoint, me.id, p256dh, auth, now)
    .run();
  return json({ ok: true });
}

/** この端末を通知の受け取り先から外す（通知を止めたときと、ログアウトするとき） */
export async function deletePushSubscription(env: Env, request: Request, me: CurrentUser): Promise<Response> {
  const input = await readJson(request);
  if (typeof input.endpoint !== "string") throw new HttpError(400, "送信内容が正しくありません。");
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2").bind(input.endpoint, me.id).run();
  return json({ ok: true });
}
