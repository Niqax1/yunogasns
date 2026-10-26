/**
 * yunogasns の API（/api/*）と画像の配信（/media/*）、古い投稿を消す定期処理。
 * 画面（HTML/CSS/JS）は public/ の静的アセットとして配信されるので、ここでは扱わない。
 */

import { getMe, removeAvatar, setAvatar, updateMe } from "./account";
import { deleteEveryPost, deleteSelectedPosts, deleteUser, issueUser, listUsers } from "./admin";
import { getCurrentUser, login, logout } from "./auth";
import { RETENTION_MS } from "./config";
import { HttpError, assertSameOrigin, json } from "./http";
import { serveMedia } from "./media";
import { createNotice, deleteNotice, listNotices, markNoticesRead } from "./notices";
import {
  createComment,
  createPost,
  deletePost,
  getPost,
  listComments,
  listLikers,
  listPosts,
  listQuotes,
  postNotFound,
  setLike,
} from "./posts";

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      // D1の無料枠（1日あたりの読み書き行数）を使い切ると、UTC 0時までクエリがエラーになる
      if (message.includes("free tier daily")) {
        return json({ error: "今日の無料枠の上限に達しました。日本時間の朝9時を過ぎるとまた使えます。" }, 503);
      }
      console.error(JSON.stringify({ message: "unhandled error", error: message, method: request.method, url: request.url }));
      return json({ error: "サーバーでエラーが発生しました。" }, 500);
    }
  },

  async scheduled(controller, env) {
    const now = controller.scheduledTime;
    const cutoff = now - RETENTION_MS;
    // コメントといいねは投稿より後に作られるので、期限切れの投稿に付いたものを投稿と一緒に消す。
    // 写真は KV の期限で自動的に消える。
    const [likes, comments, posts, sessions] = await env.DB.batch([
      env.DB.prepare("DELETE FROM likes WHERE post_id < ?1").bind(cutoff),
      env.DB.prepare("DELETE FROM comments WHERE post_id < ?1").bind(cutoff),
      env.DB.prepare("DELETE FROM posts WHERE id < ?1").bind(cutoff),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    ]);
    console.log(
      JSON.stringify({
        message: "cleanup",
        cutoff,
        deletedPosts: posts?.meta.changes,
        deletedComments: comments?.meta.changes,
        deletedLikes: likes?.meta.changes,
        deletedSessions: sessions?.meta.changes,
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const now = Date.now();
  const cutoff = now - RETENTION_MS;
  assertSameOrigin(request, url);

  if (pathname === "/api/login" && method === "POST") return login(env, request, now);
  if (pathname === "/api/logout" && method === "POST") return logout(env, request);

  // ここから先は、ログインしている人だけが使える
  const me = await getCurrentUser(env, request, now);
  if (!me) throw new HttpError(401, "ログインしてください。");

  const media = /^\/media\/([pa]\/[0-9a-f-]{36})$/.exec(pathname);
  if (media?.[1] && method === "GET") return serveMedia(env, media[1]);

  if (pathname === "/api/me") {
    if (method === "GET") return getMe(env, me);
    if (method === "PATCH") return updateMe(env, request, me);
  }
  if (pathname === "/api/notices" && method === "GET") return listNotices(env, me);
  if (pathname === "/api/notices/read" && method === "POST") return markNoticesRead(env, me);
  if (pathname === "/api/me/avatar") {
    if (method === "PUT") return setAvatar(env, ctx, request, me);
    if (method === "DELETE") return removeAvatar(env, ctx, me);
  }

  if (pathname === "/api/posts") {
    if (method === "GET") return listPosts(env, url, me, cutoff);
    if (method === "POST") return createPost(env, request, me, now, cutoff);
  }

  const post = /^\/api\/posts\/(\d{1,15})(?:\/(comments|quotes|like|likes))?$/.exec(pathname);
  if (post) {
    const postId = Number(post[1]);
    // id は作成時刻なので、期限切れかどうかはDBを見なくても分かる
    if (postId < cutoff) throw postNotFound();
    const sub = post[2];
    if (sub === undefined && method === "GET") return getPost(env, me, postId, cutoff);
    if (sub === undefined && method === "DELETE") return deletePost(env, ctx, me, postId);
    if (sub === "comments" && method === "GET") return listComments(env, url, postId);
    if (sub === "comments" && method === "POST") return createComment(env, request, me, postId, now, cutoff);
    if (sub === "quotes" && method === "GET") return listQuotes(env, url, me, postId, cutoff);
    if (sub === "like" && method === "POST") return setLike(env, request, me, postId, now, cutoff);
    if (sub === "likes" && method === "GET") return listLikers(env, postId);
  }

  if (pathname.startsWith("/api/admin/")) {
    if (!me.isAdmin) throw new HttpError(403, "管理者だけが使える機能です。");
    if (pathname === "/api/admin/users" && method === "GET") return listUsers(env);
    if (pathname === "/api/admin/users" && method === "POST") return issueUser(env, request, now);
    const user = /^\/api\/admin\/users\/([A-Za-z0-9_]{1,20})$/.exec(pathname);
    if (user?.[1] && method === "DELETE") return deleteUser(env, ctx, me, user[1]);
    if (pathname === "/api/admin/posts/delete" && method === "POST") return deleteSelectedPosts(env, ctx, request);
    if (pathname === "/api/admin/posts/delete-all" && method === "POST") return deleteEveryPost(env, ctx, request);
    if (pathname === "/api/admin/notices" && method === "POST") return createNotice(env, request, me, now);
    const notice = /^\/api\/admin\/notices\/(\d{1,15})$/.exec(pathname);
    if (notice?.[1] && method === "DELETE") return deleteNotice(env, Number(notice[1]));
  }

  throw new HttpError(404, "見つかりません。");
}
