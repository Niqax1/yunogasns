/** 投稿・コメント・引用・いいね */

import type { CurrentUser } from "./auth";
import {
  COMMENTS_PAGE_SIZE,
  LIKERS_LIMIT,
  MAX_BODY_LENGTH,
  MAX_IMAGES_PER_POST,
  NEW_POSTS_LIMIT,
  PAGE_SIZE,
} from "./config";
import { HttpError, checkRateLimit, cleanText, json, pageOf, readForm, readIdParam, readJson } from "./http";
import {
  MAX_IMAGE_BYTES,
  POST_IMAGE_TTL_SECONDS,
  type StoredImage,
  assertImage,
  deleteImages,
  mediaUrl,
  parseStoredImages,
  storeImage,
} from "./media";

// 写真4枚と本文が収まる大きさ
const MAX_POST_REQUEST_BYTES = MAX_IMAGES_PER_POST * MAX_IMAGE_BYTES + 64 * 1024;

// 1回のリクエストで消す写真の上限（KV など内部サービスへのアクセスは1回のリクエストで1,000回まで）。
// 消しきれなかった写真も、期限が来れば自動で消える。
const MAX_IMAGE_DELETES = 200;

const TOO_MANY_WRITES = "短い時間に送信しすぎです。1分ほど待ってからもう一度お試しください。";

// 投稿の取得に共通する部分。?1 は「これより古いものは期限切れ」とする時刻、?2 は見ている人のID。
// 名前とアイコンはアカウントから取る（ログイン導入前の投稿はアカウントがないので、投稿時の名前 p.name を使う）。
// 引用元も同じテーブルから結合して取り、期限切れ・削除済みなら q_* が NULL になる。
const SELECT_POSTS = `
  SELECT p.id, p.body, p.images, p.quote_id, p.comment_count, p.quote_count, p.like_count,
         p.user_id, COALESCE(u.name, p.name) AS name, u.avatar_key,
         l.post_id IS NOT NULL AS liked,
         q.id AS q_id, q.body AS q_body, q.images AS q_images,
         q.user_id AS q_user_id, COALESCE(qu.name, q.name) AS q_name, qu.avatar_key AS q_avatar_key
  FROM posts p
  LEFT JOIN users u ON u.id = p.user_id
  LEFT JOIN likes l ON l.post_id = p.id AND l.user_id = ?2
  LEFT JOIN posts q ON q.id = p.quote_id AND q.id >= ?1
  LEFT JOIN users qu ON qu.id = q.user_id`;

const SELECT_COMMENTS = `
  SELECT c.id, c.post_id, c.body, c.user_id, COALESCE(u.name, c.name) AS name, u.avatar_key
  FROM comments c
  LEFT JOIN users u ON u.id = c.user_id
  WHERE c.post_id = ?1 AND c.id > ?2
  ORDER BY c.id
  LIMIT ?3`;

// id は「作成時刻（ミリ秒）と、既存の最大id+1 の大きいほう」にする（migrations/0001_init.sql 参照）
const NEXT_POST_ID = "MAX(?1, COALESCE((SELECT MAX(id) FROM posts), 0) + 1)";
const NEXT_COMMENT_ID = "MAX(?1, COALESCE((SELECT MAX(id) FROM comments), 0) + 1)";

// 消す投稿の id の一覧は、JSON 配列1つで渡す（D1 は1つのクエリに渡せる値が100個まで）
const IDS_IN_JSON = "(SELECT value FROM json_each(?1))";

type PostRow = {
  id: number;
  body: string;
  images: string | null;
  quote_id: number | null;
  comment_count: number;
  quote_count: number;
  like_count: number;
  user_id: string | null;
  name: string;
  avatar_key: string | null;
  liked: number;
  q_id: number | null;
  q_body: string | null;
  q_images: string | null;
  q_user_id: string | null;
  q_name: string | null;
  q_avatar_key: string | null;
};

type QuotedRow = { id: number; body: string; images: string | null; user_id: string | null; name: string; avatar_key: string | null };

type CommentRow = {
  id: number;
  post_id: number;
  body: string;
  user_id: string | null;
  name: string;
  avatar_key: string | null;
};

/** タイムライン。?before=<id> でそれより古いページ、?after=<id> で新着を返す（どちらも新しい順） */
export async function listPosts(env: Env, url: URL, me: CurrentUser, cutoff: number): Promise<Response> {
  const after = readIdParam(url, "after");
  if (after !== null) {
    // 「期限内」と「after より新しい」を1つの下限にまとめる。
    // 下限の条件が2つあると主キーの範囲読みに片方しか使われず、新着が0件でも期限内の全投稿を読んでしまう。
    const lowerBound = Math.max(after, cutoff - 1);
    // 新着が多すぎて取り切れないときは hasMore=true になり、画面側は先頭から読み直す
    const { results } = await env.DB.prepare(`${SELECT_POSTS} WHERE p.id > ?3 ORDER BY p.id DESC LIMIT ?4`)
      .bind(cutoff, me.id, lowerBound, NEW_POSTS_LIMIT + 1)
      .all<PostRow>();
    const page = pageOf(results, NEW_POSTS_LIMIT);
    return json({ posts: page.items.map(toPost), hasMore: page.hasMore });
  }

  const before = readIdParam(url, "before") ?? Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(`${SELECT_POSTS} WHERE p.id >= ?1 AND p.id < ?3 ORDER BY p.id DESC LIMIT ?4`)
    .bind(cutoff, me.id, before, PAGE_SIZE + 1)
    .all<PostRow>();
  const page = pageOf(results, PAGE_SIZE);
  return json({ posts: page.items.map(toPost), hasMore: page.hasMore });
}

/** 投稿1件と、そのコメントの最初のページ（古い順） */
export async function getPost(env: Env, me: CurrentUser, postId: number, cutoff: number): Promise<Response> {
  const [post, comments] = await Promise.all([
    env.DB.prepare(`${SELECT_POSTS} WHERE p.id = ?3`).bind(cutoff, me.id, postId).first<PostRow>(),
    env.DB.prepare(SELECT_COMMENTS).bind(postId, 0, COMMENTS_PAGE_SIZE + 1).all<CommentRow>(),
  ]);
  if (!post) throw postNotFound();
  const page = pageOf(comments.results, COMMENTS_PAGE_SIZE);
  return json({ post: toPost(post), comments: page.items.map(toComment), hasMoreComments: page.hasMore });
}

/** コメントの続き（?after=<コメントid> より新しいもの、古い順） */
export async function listComments(env: Env, url: URL, postId: number): Promise<Response> {
  const after = readIdParam(url, "after") ?? 0;
  const { results } = await env.DB.prepare(SELECT_COMMENTS).bind(postId, after, COMMENTS_PAGE_SIZE + 1).all<CommentRow>();
  const page = pageOf(results, COMMENTS_PAGE_SIZE);
  return json({ comments: page.items.map(toComment), hasMore: page.hasMore });
}

/** この投稿を引用した投稿（新しい順） */
export async function listQuotes(env: Env, url: URL, me: CurrentUser, postId: number, cutoff: number): Promise<Response> {
  const before = readIdParam(url, "before") ?? Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(
    `${SELECT_POSTS} WHERE p.quote_id = ?3 AND p.id >= ?1 AND p.id < ?4 ORDER BY p.id DESC LIMIT ?5`,
  )
    .bind(cutoff, me.id, postId, before, PAGE_SIZE + 1)
    .all<PostRow>();
  const page = pageOf(results, PAGE_SIZE);
  return json({ posts: page.items.map(toPost), hasMore: page.hasMore });
}

/** この投稿にいいねした人（新しい順） */
export async function listLikers(env: Env, postId: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar_key FROM likes l JOIN users u ON u.id = l.user_id
     WHERE l.post_id = ?1 ORDER BY l.created_at DESC LIMIT ?2`,
  )
    .bind(postId, LIKERS_LIMIT)
    .all<{ id: string; name: string; avatar_key: string | null }>();
  return json({ users: results.map((user) => toAuthor(user.id, user.name, user.avatar_key)) });
}

/** 投稿する。写真つきでも送れるよう multipart/form-data で受け取る */
export async function createPost(env: Env, request: Request, me: CurrentUser, now: number, cutoff: number): Promise<Response> {
  await checkRateLimit(env.WRITE_LIMITER, me.id, TOO_MANY_WRITES);
  const form = await readForm(request, MAX_POST_REQUEST_BYTES);
  const files = form.getAll("images").filter((value): value is File => typeof value !== "string");
  if (files.length > MAX_IMAGES_PER_POST) throw new HttpError(400, `写真は${MAX_IMAGES_PER_POST}枚までです。`);
  const sizes = parseImageSizes(form.get("imageSizes"), files.length);
  const body = cleanText(form.get("body"), "本文", MAX_BODY_LENGTH, { multiline: true, allowEmpty: files.length > 0 });
  const quoteId = parseOptionalId(form.get("quoteId"));

  let quoted: QuotedRow | null = null;
  if (quoteId !== null) {
    quoted = await env.DB.prepare(
      `SELECT q.id, q.body, q.images, q.user_id, COALESCE(u.name, q.name) AS name, u.avatar_key
       FROM posts q LEFT JOIN users u ON u.id = q.user_id WHERE q.id = ?1 AND q.id >= ?2`,
    )
      .bind(quoteId, cutoff)
      .first<QuotedRow>();
    if (!quoted) throw new HttpError(404, "引用元の投稿が見つかりません。削除された可能性があります。");
  }

  // 写真を先に保存する（このあと投稿の保存に失敗しても、写真は期限が来れば自動で消える）
  const contents = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
  if (contents.some((bytes) => bytes.byteLength > MAX_IMAGE_BYTES)) throw new HttpError(413, "写真が大きすぎます。");
  contents.forEach(assertImage);
  const keys = await Promise.all(contents.map((bytes) => storeImage(env, "p", bytes, POST_IMAGE_TTL_SECONDS)));
  const images: StoredImage[] = keys.map((k, i) => ({ k, w: sizes[i]?.[0] ?? 0, h: sizes[i]?.[1] ?? 0 }));
  const imagesJson = images.length > 0 ? JSON.stringify(images) : null;

  const insert = env.DB.prepare(
    `INSERT INTO posts (id, user_id, name, body, quote_id, images) VALUES (${NEXT_POST_ID}, ?2, ?3, ?4, ?5, ?6)
     RETURNING id`,
  ).bind(now, me.id, me.name, body, quoteId, imagesJson);

  let inserted: { id: number } | null | undefined;
  if (quoteId === null) {
    inserted = await insert.first<{ id: number }>();
  } else {
    // 投稿の追加と引用元の引用数の更新は、1つのトランザクションで行う
    const [result] = await env.DB.batch<{ id: number }>([
      insert,
      env.DB.prepare("UPDATE posts SET quote_count = quote_count + 1 WHERE id = ?1").bind(quoteId),
    ]);
    inserted = result?.results[0];
  }
  if (!inserted) throw new Error("INSERT INTO posts returned no row");

  const post = toPost({
    id: inserted.id,
    body,
    images: imagesJson,
    quote_id: quoteId,
    comment_count: 0,
    quote_count: 0,
    like_count: 0,
    user_id: me.id,
    name: me.name,
    avatar_key: me.avatarKey,
    liked: 0,
    q_id: quoted?.id ?? null,
    q_body: quoted?.body ?? null,
    q_images: quoted?.images ?? null,
    q_user_id: quoted?.user_id ?? null,
    q_name: quoted?.name ?? null,
    q_avatar_key: quoted?.avatar_key ?? null,
  });
  return json({ post }, 201);
}

/** 自分の投稿を削除する（管理者はだれの投稿でも削除できる） */
export async function deletePost(env: Env, ctx: ExecutionContext, me: CurrentUser, postId: number): Promise<Response> {
  const post = await env.DB.prepare("SELECT user_id FROM posts WHERE id = ?1").bind(postId).first<{ user_id: string | null }>();
  if (!post) throw postNotFound();
  if (!me.isAdmin && post.user_id !== me.id) throw new HttpError(403, "自分の投稿だけ削除できます。");
  return json({ deleted: await deletePosts(env, ctx, [postId]) });
}

/** 投稿をまとめて削除する。付いていたコメント・いいね・写真も消し、引用元の引用数を減らす */
export async function deletePosts(env: Env, ctx: ExecutionContext, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const idList = JSON.stringify(ids);
  const { results } = await env.DB.prepare(`SELECT images FROM posts WHERE id IN ${IDS_IN_JSON} AND images IS NOT NULL`)
    .bind(idList)
    .all<{ images: string }>();
  const [, , , deleted] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE posts SET quote_count = MAX(0, quote_count - (
         SELECT COUNT(*) FROM posts d WHERE d.quote_id = posts.id AND d.id IN ${IDS_IN_JSON}))
       WHERE id IN (SELECT quote_id FROM posts WHERE id IN ${IDS_IN_JSON})`,
    ).bind(idList),
    env.DB.prepare(`DELETE FROM likes WHERE post_id IN ${IDS_IN_JSON}`).bind(idList),
    env.DB.prepare(`DELETE FROM comments WHERE post_id IN ${IDS_IN_JSON}`).bind(idList),
    env.DB.prepare(`DELETE FROM posts WHERE id IN ${IDS_IN_JSON}`).bind(idList),
  ]);
  deleteImagesLater(env, ctx, results.map((row) => row.images));
  return deleted?.meta.changes ?? 0;
}

/** すべての投稿・コメント・いいねを削除する */
export async function deleteAllPosts(env: Env, ctx: ExecutionContext): Promise<number> {
  const { results } = await env.DB.prepare("SELECT images FROM posts WHERE images IS NOT NULL").all<{ images: string }>();
  const [, , deleted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM likes"),
    env.DB.prepare("DELETE FROM comments"),
    env.DB.prepare("DELETE FROM posts"),
  ]);
  deleteImagesLater(env, ctx, results.map((row) => row.images));
  return deleted?.meta.changes ?? 0;
}

/** posts.images の JSON から写真のキーを取り出し、応答を返したあとで消す */
export function deleteImagesLater(env: Env, ctx: ExecutionContext, imagesJson: (string | null)[]): void {
  const keys = imagesJson.flatMap((json) => parseStoredImages(json).map((image) => image.k));
  if (keys.length > 0) ctx.waitUntil(deleteImages(env, keys.slice(0, MAX_IMAGE_DELETES)));
}

export async function createComment(
  env: Env,
  request: Request,
  me: CurrentUser,
  postId: number,
  now: number,
  cutoff: number,
): Promise<Response> {
  await checkRateLimit(env.WRITE_LIMITER, me.id, TOO_MANY_WRITES);
  const input = await readJson(request);
  const body = cleanText(input.body, "コメント", MAX_BODY_LENGTH, { multiline: true });

  // 投稿が期限内に存在するときだけ、コメントの追加とコメント数の更新を1つのトランザクションで行う
  const [result] = await env.DB.batch<{ id: number }>([
    env.DB.prepare(
      `INSERT INTO comments (id, post_id, user_id, name, body)
       SELECT ${NEXT_COMMENT_ID}, ?2, ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND id >= ?6)
       RETURNING id`,
    ).bind(now, postId, me.id, me.name, body, cutoff),
    env.DB.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?1 AND id >= ?2").bind(postId, cutoff),
  ]);
  const inserted = result?.results[0];
  if (!inserted) throw postNotFound();
  const comment = toComment({ id: inserted.id, post_id: postId, body, user_id: me.id, name: me.name, avatar_key: me.avatarKey });
  return json({ comment }, 201);
}

/** いいね（{"liked": true}）と、その取り消し（{"liked": false}） */
export async function setLike(
  env: Env,
  request: Request,
  me: CurrentUser,
  postId: number,
  now: number,
  cutoff: number,
): Promise<Response> {
  await checkRateLimit(env.LIKE_LIMITER, me.id, TOO_MANY_WRITES);
  const input = await readJson(request);
  if (typeof input.liked !== "boolean") throw new HttpError(400, "送信内容が正しくありません。");

  const change = input.liked
    ? env.DB.prepare(
        `INSERT OR IGNORE INTO likes (post_id, user_id, created_at)
         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND id >= ?4)`,
      ).bind(postId, me.id, now, cutoff)
    : env.DB.prepare("DELETE FROM likes WHERE post_id = ?1 AND user_id = ?2").bind(postId, me.id);
  const [, counted] = await env.DB.batch<{ like_count: number }>([
    change,
    // 件数は likes から数え直す（同じ操作が二重に届いても、数がずれないように）
    env.DB.prepare(
      "UPDATE posts SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = ?1) WHERE id = ?1 AND id >= ?2 RETURNING like_count",
    ).bind(postId, cutoff),
  ]);
  const row = counted?.results[0];
  if (!row) throw postNotFound();
  return json({ likeCount: row.like_count, liked: input.liked });
}

export function postNotFound(): HttpError {
  return new HttpError(404, "この投稿は見つかりません。削除されたか、7日が過ぎて消えた可能性があります。");
}

function toAuthor(id: string | null, name: string, avatarKey: string | null) {
  return { id, name, avatarUrl: avatarKey ? mediaUrl(avatarKey) : null };
}

function toImages(json: string | null) {
  return parseStoredImages(json).map((image) => ({ url: mediaUrl(image.k), width: image.w, height: image.h }));
}

function toPost(row: PostRow) {
  return {
    id: row.id,
    createdAt: row.id,
    author: toAuthor(row.user_id, row.name, row.avatar_key),
    body: row.body,
    images: toImages(row.images),
    commentCount: row.comment_count,
    quoteCount: row.quote_count,
    likeCount: row.like_count,
    liked: row.liked === 1,
    // 引用元が消えている場合は quoteId だけが入り、quote は null になる
    quoteId: row.quote_id,
    quote:
      row.q_id !== null && row.q_name !== null && row.q_body !== null
        ? {
            id: row.q_id,
            createdAt: row.q_id,
            author: toAuthor(row.q_user_id, row.q_name, row.q_avatar_key),
            body: row.q_body,
            images: toImages(row.q_images),
          }
        : null,
  };
}

function toComment(row: CommentRow) {
  return { id: row.id, postId: row.post_id, createdAt: row.id, author: toAuthor(row.user_id, row.name, row.avatar_key), body: row.body };
}

function parseOptionalId(value: File | string | null): number | null {
  if (value === null || value === "") return null;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  throw new HttpError(400, "引用元の指定が正しくありません。");
}

/** 写真の縦横の大きさ（表示の枠を先に確保するために使う）。[[幅, 高さ], ...] の JSON */
function parseImageSizes(value: File | string | null, count: number): [number, number][] {
  if (count === 0) return [];
  let sizes: unknown;
  try {
    sizes = typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    sizes = null;
  }
  const isSize = (size: unknown): size is [number, number] =>
    Array.isArray(size) && size.length === 2 && size.every((n) => Number.isInteger(n) && n > 0 && n <= 20000);
  if (!Array.isArray(sizes) || sizes.length !== count || !sizes.every(isSize)) {
    throw new HttpError(400, "写真の情報が正しくありません。");
  }
  return sizes;
}
