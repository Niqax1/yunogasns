/** ログイン中の本人のアカウント（表示名・アイコン） */

import { type CurrentUser, publicUser } from "./auth";
import { MAX_NAME_LENGTH } from "./config";
import { HttpError, cleanText, json, readBody, readJson } from "./http";
import { MAX_AVATAR_BYTES, deleteImages, storeImage } from "./media";
import { unreadNotices } from "./notices";

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
