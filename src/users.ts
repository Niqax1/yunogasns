/** プロフィールとフォロー */

import type { CurrentUser } from "./auth";
import { LIKERS_LIMIT, PAGE_SIZE } from "./config";
import { HttpError, checkRateLimit, json, pageOf, readIdParam, readJson } from "./http";
import { mediaUrl } from "./media";
import type { Notifier } from "./notify";
import { type PostRow, SELECT_POSTS, toPost } from "./posts";

type ProfileRow = {
  id: string;
  name: string;
  avatar_key: string | null;
  following_count: number;
  follower_count: number;
  my_notify: number | null;
  follows_me: number;
};

/** プロフィール：フォロー数・フォロワー数と、見ている人との関係 */
export async function getProfile(env: Env, me: CurrentUser, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar_key,
       (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following_count,
       (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS follower_count,
       (SELECT notify FROM follows WHERE follower_id = ?2 AND followee_id = u.id) AS my_notify,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = u.id AND followee_id = ?2) AS follows_me
     FROM users u WHERE u.id = ?1`,
  )
    .bind(id, me.id)
    .first<ProfileRow>();
  if (!row) throw userNotFound();
  return json({
    user: { id: row.id, name: row.name, avatarUrl: row.avatar_key ? mediaUrl(row.avatar_key) : null },
    isMe: row.id === me.id,
    followingCount: row.following_count,
    followerCount: row.follower_count,
    following: row.my_notify !== null,
    notify: row.my_notify === 1,
    followsMe: row.follows_me === 1,
  });
}

/** その人の投稿（新しい順） */
export async function listUserPosts(env: Env, url: URL, me: CurrentUser, id: string, cutoff: number): Promise<Response> {
  const before = readIdParam(url, "before") ?? Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(
    `${SELECT_POSTS} WHERE p.user_id = (SELECT id FROM users WHERE id = ?3) AND p.id >= ?1 AND p.id < ?4
     ORDER BY p.id DESC LIMIT ?5`,
  )
    .bind(cutoff, me.id, id, before, PAGE_SIZE + 1)
    .all<PostRow>();
  const page = pageOf(results, PAGE_SIZE);
  return json({ posts: page.items.map(toPost), hasMore: page.hasMore });
}

/** フォロー中（direction: "following"）またはフォロワー（"followers"）の一覧 */
export async function listFollows(env: Env, id: string, direction: "following" | "followers"): Promise<Response> {
  const [mine, theirs] = direction === "following" ? ["follower_id", "followee_id"] : ["followee_id", "follower_id"];
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar_key FROM follows f JOIN users u ON u.id = f.${theirs}
     WHERE f.${mine} = (SELECT id FROM users WHERE id = ?1) ORDER BY f.created_at DESC LIMIT ?2`,
  )
    .bind(id, LIKERS_LIMIT)
    .all<{ id: string; name: string; avatar_key: string | null }>();
  return json({ users: results.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatar_key ? mediaUrl(u.avatar_key) : null })) });
}

/**
 * フォローする（{"notify": true|false} で、この人の新しい投稿を通知するかも変えられる）。
 * すでにフォローしていれば、通知の設定だけを変える。
 */
export async function follow(env: Env, request: Request, me: CurrentUser, id: string, now: number, notifier: Notifier): Promise<Response> {
  await checkRateLimit(env.LIKE_LIMITER, me.id, "短い時間に操作しすぎです。1分ほど待ってからもう一度お試しください。");
  const input = await readJson(request);
  if (input.notify !== undefined && typeof input.notify !== "boolean") throw new HttpError(400, "送信内容が正しくありません。");
  const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(id).first<{ id: string }>();
  if (!target) throw userNotFound();
  if (target.id === me.id) throw new HttpError(400, "自分はフォローできません。");

  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, notify, created_at) VALUES (?1, ?2, 1, ?3)").bind(
      me.id,
      target.id,
      now,
    ),
  ];
  if (typeof input.notify === "boolean") {
    statements.push(
      env.DB.prepare("UPDATE follows SET notify = ?3 WHERE follower_id = ?1 AND followee_id = ?2").bind(me.id, target.id, input.notify ? 1 : 0),
    );
  }
  const [inserted] = await env.DB.batch(statements);
  if (inserted?.meta.changes === 1) notifier.follow(me, target.id);
  return followState(env, me, target.id);
}

export async function unfollow(env: Env, me: CurrentUser, id: string): Promise<Response> {
  const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(id).first<{ id: string }>();
  if (!target) throw userNotFound();
  await env.DB.prepare("DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2").bind(me.id, target.id).run();
  return followState(env, me, target.id);
}

async function followState(env: Env, me: CurrentUser, targetId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT (SELECT notify FROM follows WHERE follower_id = ?1 AND followee_id = ?2) AS my_notify,
            (SELECT COUNT(*) FROM follows WHERE followee_id = ?2) AS follower_count`,
  )
    .bind(me.id, targetId)
    .first<{ my_notify: number | null; follower_count: number }>();
  return json({ following: row?.my_notify != null, notify: row?.my_notify === 1, followerCount: row?.follower_count ?? 0 });
}

function userNotFound(): HttpError {
  return new HttpError(404, "このアカウントは見つかりません。");
}
