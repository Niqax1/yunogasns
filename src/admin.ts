/** 管理者用：アカウントの発行・削除と、投稿の一括削除 */

import { type CurrentUser, generatePassword, hashPassword } from "./auth";
import { USER_ID_PATTERN } from "./config";
import { HttpError, json, readJson } from "./http";
import { deleteImages, mediaUrl } from "./media";
import { deleteAllPosts, deleteImagesLater, deletePosts } from "./posts";

// 選んで削除するときに、1回で消せる投稿の数
const MAX_BULK_DELETE = 100;

type AdminUserRow = { id: string; name: string; is_admin: number; avatar_key: string | null; created_at: number };

// アカウントを消すときの処理。?1 はそのアカウントのID
const DELETE_USER_STATEMENTS = [
  // この人が付けたいいね・コメント・引用の分だけ、ほかの人の投稿の件数を減らす
  "UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id IN (SELECT post_id FROM likes WHERE user_id = ?1)",
  `UPDATE posts SET comment_count = MAX(0, comment_count - (
     SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.user_id = ?1))
   WHERE id IN (SELECT post_id FROM comments WHERE user_id = ?1)`,
  `UPDATE posts SET quote_count = MAX(0, quote_count - (
     SELECT COUNT(*) FROM posts q WHERE q.quote_id = posts.id AND q.user_id = ?1))
   WHERE id IN (SELECT quote_id FROM posts WHERE user_id = ?1 AND quote_id IS NOT NULL)`,
  // この人の投稿に付いていたいいね・コメントと、この人のいいね・コメント・投稿・ログイン中の端末・アカウントを消す
  "DELETE FROM likes WHERE user_id = ?1 OR post_id IN (SELECT id FROM posts WHERE user_id = ?1)",
  "DELETE FROM comments WHERE user_id = ?1 OR post_id IN (SELECT id FROM posts WHERE user_id = ?1)",
  "DELETE FROM posts WHERE user_id = ?1",
  "DELETE FROM sessions WHERE user_id = ?1",
  "DELETE FROM users WHERE id = ?1",
];

export async function listUsers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id, name, is_admin, avatar_key, created_at FROM users ORDER BY created_at")
    .all<AdminUserRow>();
  return json({ users: results.map(toAdminUser) });
}

/** アカウントを発行する。パスワードは自動で作り、この応答でだけ返す（保存するのはハッシュだけ） */
export async function issueUser(env: Env, request: Request, now: number): Promise<Response> {
  const input = await readJson(request);
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!USER_ID_PATTERN.test(id)) throw new HttpError(400, "IDは英数字と _ で、20文字までにしてください。");

  const password = generatePassword();
  // 表示名は最初はIDと同じにしておき、本人があとで変えられる
  const user = await env.DB.prepare(
    `INSERT INTO users (id, name, password_hash, is_admin, created_at) VALUES (?1, ?1, ?2, 0, ?3)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, is_admin, avatar_key, created_at`,
  )
    .bind(id, await hashPassword(password), now)
    .first<AdminUserRow>();
  if (!user) throw new HttpError(409, `ID「${id}」はすでに使われています（大文字・小文字の違いは区別しません）。`);
  return json({ user: toAdminUser(user), password }, 201);
}

/** アカウントを削除する。その人の投稿・コメント・いいね・アイコンもすべて消える */
export async function deleteUser(env: Env, ctx: ExecutionContext, me: CurrentUser, id: string): Promise<Response> {
  const user = await env.DB.prepare("SELECT id, avatar_key FROM users WHERE id = ?1")
    .bind(id)
    .first<{ id: string; avatar_key: string | null }>();
  if (!user) throw new HttpError(404, "そのアカウントは見つかりません。");
  if (user.id === me.id) throw new HttpError(400, "自分のアカウントは削除できません。");

  const { results } = await env.DB.prepare("SELECT images FROM posts WHERE user_id = ?1 AND images IS NOT NULL")
    .bind(user.id)
    .all<{ images: string }>();
  await env.DB.batch(DELETE_USER_STATEMENTS.map((sql) => env.DB.prepare(sql).bind(user.id)));
  deleteImagesLater(env, ctx, results.map((row) => row.images));
  if (user.avatar_key) ctx.waitUntil(deleteImages(env, [user.avatar_key]));
  return json({ deleted: true });
}

/** 選んだ投稿をまとめて削除する（{"ids": [投稿id, ...]}） */
export async function deleteSelectedPosts(env: Env, ctx: ExecutionContext, request: Request): Promise<Response> {
  const input = await readJson(request);
  const ids: unknown = input.ids;
  const isPostId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DELETE || !ids.every(isPostId)) {
    throw new HttpError(400, `削除する投稿を1〜${MAX_BULK_DELETE}件選んでください。`);
  }
  return json({ deleted: await deletePosts(env, ctx, ids) });
}

/** すべての投稿を削除する（{"confirm": true} が必要） */
export async function deleteEveryPost(env: Env, ctx: ExecutionContext, request: Request): Promise<Response> {
  const input = await readJson(request);
  if (input.confirm !== true) throw new HttpError(400, "確認のため confirm を指定してください。");
  return json({ deleted: await deleteAllPosts(env, ctx) });
}

function toAdminUser(row: AdminUserRow) {
  return {
    id: row.id,
    name: row.name,
    isAdmin: row.is_admin === 1,
    avatarUrl: row.avatar_key ? mediaUrl(row.avatar_key) : null,
    createdAt: row.created_at,
  };
}
