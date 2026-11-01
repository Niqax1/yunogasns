/** どのできごとで、だれに、どんな通知を送るか。送信は応答を返したあと（ctx.waitUntil）に行う */

import type { CurrentUser } from "./auth";
import { type PushMessage, sendPushToUsers } from "./push";

// 1回のリクエストで通知を送る端末の上限。暗号化に1台あたり約0.5ミリ秒かかるので、
// 無料プランの CPU 時間（1リクエスト10ミリ秒）に収まるようにしている。
const MAX_DEVICES_PER_REQUEST = 15;

export type Notifier = ReturnType<typeof createNotifier>;

export function createNotifier(env: Env, ctx: ExecutionContext, origin: string) {
  let remaining = MAX_DEVICES_PER_REQUEST;

  const send = async (userIds: string[], message: PushMessage) => {
    remaining -= await sendPushToUsers(env, origin, userIds, message, remaining);
  };
  const later = (kind: string, task: () => Promise<void>) => {
    ctx.waitUntil(
      task().catch((error: unknown) =>
        console.error(JSON.stringify({ message: "notification failed", kind, error: error instanceof Error ? error.message : String(error) })),
      ),
    );
  };
  // 通知の設定がオンで、自分以外の投稿者（column はこのファイル内の決まった列名だけ）
  const postAuthor = (column: "notify_comments" | "notify_quotes" | "notify_likes", postId: number, me: CurrentUser) =>
    env.DB.prepare(
      `SELECT u.id, p.body, p.images FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.id = ?1 AND u.${column} = 1 AND u.id != ?2`,
    )
      .bind(postId, me.id)
      .first<{ id: string; body: string; images: string | null }>();
  // コメントを書いた人について、同じく
  const commentAuthor = (column: "notify_quotes" | "notify_likes", commentId: number, me: CurrentUser) =>
    env.DB.prepare(
      `SELECT u.id, c.post_id, c.body FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.id = ?1 AND u.${column} = 1 AND u.id != ?2`,
    )
      .bind(commentId, me.id)
      .first<{ id: string; post_id: number; body: string }>();

  return {
    /** 新しい投稿：フォローしていて通知をオンにしている人と、引用された投稿・コメントを書いた人 */
    newPost(
      me: CurrentUser,
      post: { id: number; body: string; hasImages: boolean; quoteId: number | null; quoteCommentId: number | null },
    ) {
      later("post", async () => {
        const preview = summary(post.body, post.hasImages);
        let quotedAuthor: string | null = null;
        if (post.quoteId !== null) {
          const author = await postAuthor("notify_quotes", post.quoteId, me);
          if (author) {
            quotedAuthor = author.id;
            await send([author.id], { title: `${me.name}さんがあなたの投稿を引用しました`, body: preview, url: `/p/${post.id}` });
          }
        }
        if (post.quoteCommentId !== null) {
          const author = await commentAuthor("notify_quotes", post.quoteCommentId, me);
          if (author) {
            quotedAuthor = author.id;
            await send([author.id], { title: `${me.name}さんがあなたのコメントを引用しました`, body: preview, url: `/p/${post.id}` });
          }
        }
        const { results } = await env.DB.prepare("SELECT follower_id FROM follows WHERE followee_id = ?1 AND notify = 1")
          .bind(me.id)
          .all<{ follower_id: string }>();
        // 引用の通知を受け取った人には、同じ投稿の通知を二重に送らない
        const followers = results.map((row) => row.follower_id).filter((id) => id !== quotedAuthor);
        await send(followers, { title: `${me.name}さんが投稿しました`, body: preview, url: `/p/${post.id}` });
      });
    },

    /** 自分の投稿にコメントがついた（押すと、そのコメントの位置で投稿を開く） */
    comment(me: CurrentUser, postId: number, commentId: number, body: string) {
      later("comment", async () => {
        const author = await postAuthor("notify_comments", postId, me);
        if (author) {
          await send([author.id], { title: `${me.name}さんがコメントしました`, body: summary(body, false), url: commentPath(postId, commentId) });
        }
      });
    },

    /** 自分の投稿にいいねされた（同じ投稿へのいいねの通知は、端末上で1つにまとめる） */
    like(me: CurrentUser, postId: number) {
      later("like", async () => {
        const author = await postAuthor("notify_likes", postId, me);
        if (author) {
          await send([author.id], {
            title: `${me.name}さんがいいねしました`,
            body: summary(author.body, author.images !== null),
            url: `/p/${postId}`,
            tag: `like-${postId}`,
          });
        }
      });
    },

    /** 自分のコメントにいいねされた（投稿へのいいねと同じ設定で、同じコメントへの通知は1つにまとめる） */
    commentLike(me: CurrentUser, commentId: number) {
      later("comment-like", async () => {
        const author = await commentAuthor("notify_likes", commentId, me);
        if (author) {
          await send([author.id], {
            title: `${me.name}さんがあなたのコメントにいいねしました`,
            body: summary(author.body, false),
            url: commentPath(author.post_id, commentId),
            tag: `comment-like-${commentId}`,
          });
        }
      });
    },

    /** フォローされた */
    follow(me: CurrentUser, followeeId: string) {
      later("follow", async () => {
        const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?1 AND notify_follows = 1")
          .bind(followeeId)
          .first<{ id: string }>();
        if (user) await send([user.id], { title: `${me.name}さんにフォローされました`, body: `@${me.id}`, url: `/u/${me.id}` });
      });
    },

    /** 管理者からのお知らせ（送った本人以外の全員） */
    notice(me: CurrentUser, notice: { title: string; body: string }) {
      later("notice", async () => {
        const { results } = await env.DB.prepare("SELECT id FROM users WHERE notify_notices = 1 AND id != ?1")
          .bind(me.id)
          .all<{ id: string }>();
        await send(
          results.map((row) => row.id),
          { title: `お知らせ：${notice.title}`, body: summary(notice.body, false), url: "/notices" },
        );
      });
    },
  };
}

/** コメントの位置で投稿を開くURL（public/js/app.js の revealLinkedComment が読む） */
function commentPath(postId: number, commentId: number): string {
  return `/p/${postId}#c-${commentId}`;
}

/** 通知に出す本文の抜粋 */
function summary(body: string, hasImages: boolean): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return hasImages ? "写真" : "";
  const chars = [...text];
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : text;
}
