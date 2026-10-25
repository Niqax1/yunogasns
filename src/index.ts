/**
 * yunogasns の API（/api/*）と、古い投稿を消す定期処理。
 * 画面（HTML/CSS/JS）は public/ の静的アセットとして配信されるので、ここでは扱わない。
 */

// 保存期間。これを過ぎた投稿は表示せず、定期処理で削除する。
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// public/app.js にも同じ値があるので、変えるときは両方そろえる
const MAX_NAME_LENGTH = 20;
const MAX_BODY_LENGTH = 280;

const PAGE_SIZE = 30; // タイムライン・引用一覧で一度に返す件数
const NEW_POSTS_LIMIT = 50; // 新着チェックで一度に返す件数
const COMMENTS_PAGE_SIZE = 100;
const MAX_REQUEST_BYTES = 8 * 1024;

// 投稿の取得に共通する部分。?1 には「これより古いものは期限切れ」とする時刻を渡す。
// 引用元は同じテーブルから結合して取り、期限切れ・削除済みなら q_* が NULL になる。
const SELECT_POSTS = `
  SELECT p.id, p.name, p.body, p.quote_id, p.comment_count, p.quote_count,
         q.id AS q_id, q.name AS q_name, q.body AS q_body
  FROM posts p
  LEFT JOIN posts q ON q.id = p.quote_id AND q.id >= ?1`;

const SELECT_COMMENTS = `
  SELECT id, post_id, name, body FROM comments
  WHERE post_id = ?1 AND id > ?2
  ORDER BY id
  LIMIT ?3`;

// id は「作成時刻（ミリ秒）と、既存の最大id+1 の大きいほう」にする（migrations/0001_init.sql 参照）
const NEXT_POST_ID = "MAX(?1, COALESCE((SELECT MAX(id) FROM posts), 0) + 1)";
const NEXT_COMMENT_ID = "MAX(?1, COALESCE((SELECT MAX(id) FROM comments), 0) + 1)";

type PostRow = {
  id: number;
  name: string;
  body: string;
  quote_id: number | null;
  comment_count: number;
  quote_count: number;
  q_id: number | null;
  q_name: string | null;
  q_body: string | null;
};

type InsertedPostRow = Omit<PostRow, "q_id" | "q_name" | "q_body">;

type QuotedRow = { id: number; name: string; body: string };

type CommentRow = { id: number; post_id: number; name: string; body: string };

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleApi(request, env);
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
    const cutoff = controller.scheduledTime - RETENTION_MS;
    // コメントは投稿より後に作られるので、期限切れの投稿に付いたものを投稿と一緒に消す
    const [comments, posts] = await env.DB.batch([
      env.DB.prepare("DELETE FROM comments WHERE post_id < ?1").bind(cutoff),
      env.DB.prepare("DELETE FROM posts WHERE id < ?1").bind(cutoff),
    ]);
    console.log(
      JSON.stringify({
        message: "cleanup",
        cutoff,
        deletedPosts: posts?.meta.changes,
        deletedComments: comments?.meta.changes,
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const now = Date.now();
  const cutoff = now - RETENTION_MS;

  if (url.pathname === "/api/posts") {
    if (request.method === "GET") return listPosts(env, url, cutoff);
    if (request.method === "POST") return createPost(env, request, now, cutoff);
  }

  const match = /^\/api\/posts\/(\d{1,15})(?:\/(comments|quotes))?$/.exec(url.pathname);
  if (match) {
    const postId = Number(match[1]);
    // id は作成時刻なので、期限切れかどうかはDBを見なくても分かる
    if (postId < cutoff) throw postNotFound();
    const sub = match[2];
    if (sub === undefined && request.method === "GET") return getPost(env, postId, cutoff);
    if (sub === "comments" && request.method === "GET") return listComments(env, url, postId);
    if (sub === "comments" && request.method === "POST") return createComment(env, request, postId, now, cutoff);
    if (sub === "quotes" && request.method === "GET") return listQuotes(env, url, postId, cutoff);
  }

  throw new HttpError(404, "見つかりません。");
}

/** タイムライン。?before=<id> でそれより古いページ、?after=<id> で新着を返す（どちらも新しい順） */
async function listPosts(env: Env, url: URL, cutoff: number): Promise<Response> {
  const after = readIdParam(url, "after");
  if (after !== null) {
    // 「期限内」と「after より新しい」を1つの下限にまとめる。
    // 下限の条件が2つあると主キーの範囲読みに片方しか使われず、新着が0件でも期限内の全投稿を読んでしまう。
    const lowerBound = Math.max(after, cutoff - 1);
    // 新着が多すぎて取り切れないときは hasMore=true になり、画面側は先頭から読み直す
    const { results } = await env.DB.prepare(`${SELECT_POSTS} WHERE p.id > ?2 ORDER BY p.id DESC LIMIT ?3`)
      .bind(cutoff, lowerBound, NEW_POSTS_LIMIT + 1)
      .all<PostRow>();
    const page = pageOf(results, NEW_POSTS_LIMIT);
    return json({ posts: page.items.map(toPost), hasMore: page.hasMore });
  }

  const before = readIdParam(url, "before") ?? Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(`${SELECT_POSTS} WHERE p.id >= ?1 AND p.id < ?2 ORDER BY p.id DESC LIMIT ?3`)
    .bind(cutoff, before, PAGE_SIZE + 1)
    .all<PostRow>();
  const page = pageOf(results, PAGE_SIZE);
  return json({ posts: page.items.map(toPost), hasMore: page.hasMore });
}

/** 投稿1件と、そのコメントの最初のページ（古い順） */
async function getPost(env: Env, postId: number, cutoff: number): Promise<Response> {
  const [post, comments] = await Promise.all([
    env.DB.prepare(`${SELECT_POSTS} WHERE p.id = ?2`).bind(cutoff, postId).first<PostRow>(),
    env.DB.prepare(SELECT_COMMENTS).bind(postId, 0, COMMENTS_PAGE_SIZE + 1).all<CommentRow>(),
  ]);
  if (!post) throw postNotFound();
  const page = pageOf(comments.results, COMMENTS_PAGE_SIZE);
  return json({ post: toPost(post), comments: page.items.map(toComment), hasMoreComments: page.hasMore });
}

/** コメントの続き（?after=<コメントid> より新しいもの、古い順） */
async function listComments(env: Env, url: URL, postId: number): Promise<Response> {
  const after = readIdParam(url, "after") ?? 0;
  const { results } = await env.DB.prepare(SELECT_COMMENTS)
    .bind(postId, after, COMMENTS_PAGE_SIZE + 1)
    .all<CommentRow>();
  const page = pageOf(results, COMMENTS_PAGE_SIZE);
  return json({ comments: page.items.map(toComment), hasMore: page.hasMore });
}

/** この投稿を引用した投稿（新しい順） */
async function listQuotes(env: Env, url: URL, postId: number, cutoff: number): Promise<Response> {
  const before = readIdParam(url, "before") ?? Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(
    `${SELECT_POSTS} WHERE p.quote_id = ?2 AND p.id >= ?1 AND p.id < ?3 ORDER BY p.id DESC LIMIT ?4`,
  )
    .bind(cutoff, postId, before, PAGE_SIZE + 1)
    .all<PostRow>();
  const page = pageOf(results, PAGE_SIZE);
  return json({ posts: page.items.map(toPost), hasMore: page.hasMore });
}

async function createPost(env: Env, request: Request, now: number, cutoff: number): Promise<Response> {
  await checkRateLimit(env, request);
  const input = await readJson(request);
  const name = cleanText(input.name, "名前", MAX_NAME_LENGTH, false);
  const body = cleanText(input.body, "本文", MAX_BODY_LENGTH, true);
  const quoteId = parseQuoteId(input.quoteId);

  const insert = env.DB.prepare(
    `INSERT INTO posts (id, name, body, quote_id) VALUES (${NEXT_POST_ID}, ?2, ?3, ?4)
     RETURNING id, name, body, quote_id, comment_count, quote_count`,
  ).bind(now, name, body, quoteId);

  let quoted: QuotedRow | null = null;
  let inserted: InsertedPostRow | null | undefined;
  if (quoteId === null) {
    inserted = await insert.first<InsertedPostRow>();
  } else {
    quoted = await env.DB.prepare("SELECT id, name, body FROM posts WHERE id = ?1 AND id >= ?2")
      .bind(quoteId, cutoff)
      .first<QuotedRow>();
    if (!quoted) throw new HttpError(404, "引用元の投稿が見つかりません。削除された可能性があります。");
    // 投稿の追加と引用元の引用数の更新は、1つのトランザクションで行う
    const [result] = await env.DB.batch<InsertedPostRow>([
      insert,
      env.DB.prepare("UPDATE posts SET quote_count = quote_count + 1 WHERE id = ?1").bind(quoteId),
    ]);
    inserted = result?.results[0];
  }
  if (!inserted) throw new Error("INSERT INTO posts returned no row");

  const post = toPost({ ...inserted, q_id: quoted?.id ?? null, q_name: quoted?.name ?? null, q_body: quoted?.body ?? null });
  return json({ post }, 201);
}

async function createComment(env: Env, request: Request, postId: number, now: number, cutoff: number): Promise<Response> {
  await checkRateLimit(env, request);
  const input = await readJson(request);
  const name = cleanText(input.name, "名前", MAX_NAME_LENGTH, false);
  const body = cleanText(input.body, "本文", MAX_BODY_LENGTH, true);

  // 投稿が期限内に存在するときだけ、コメントの追加とコメント数の更新を1つのトランザクションで行う
  const [result] = await env.DB.batch<CommentRow>([
    env.DB.prepare(
      `INSERT INTO comments (id, post_id, name, body)
       SELECT ${NEXT_COMMENT_ID}, ?2, ?3, ?4
       WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND id >= ?5)
       RETURNING id, post_id, name, body`,
    ).bind(now, postId, name, body, cutoff),
    env.DB.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?1 AND id >= ?2").bind(postId, cutoff),
  ]);
  const inserted = result?.results[0];
  if (!inserted) throw postNotFound();
  return json({ comment: toComment(inserted) }, 201);
}

function toPost(row: PostRow) {
  return {
    id: row.id,
    createdAt: row.id,
    name: row.name,
    body: row.body,
    commentCount: row.comment_count,
    quoteCount: row.quote_count,
    // 引用元が消えている場合は quoteId だけが入り、quote は null になる
    quoteId: row.quote_id,
    quote:
      row.q_id !== null && row.q_name !== null && row.q_body !== null
        ? { id: row.q_id, createdAt: row.q_id, name: row.q_name, body: row.q_body }
        : null,
  };
}

function toComment(row: CommentRow) {
  return { id: row.id, postId: row.post_id, createdAt: row.id, name: row.name, body: row.body };
}

/** limit+1 件取得した結果から、1ページ分と「続きがあるか」を取り出す */
function pageOf<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

function postNotFound(): HttpError {
  return new HttpError(404, "この投稿は見つかりません。7日が過ぎて削除された可能性があります。");
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function readIdParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, `${key} の指定が正しくありません。`);
  return Number(raw);
}

function parseQuoteId(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new HttpError(400, "引用元の指定が正しくありません。");
}

// 制御文字と、表示順を入れ替えて見た目を偽装できる双方向制御文字（改行とタブは別に扱う）
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g;

function cleanText(value: unknown, label: string, maxLength: number, multiline: boolean): string {
  if (typeof value !== "string") throw new HttpError(400, `${label}を入力してください。`);
  let text = value.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(UNSAFE_CHARS, "");
  // 本文の空行は2行まで。名前は改行を含めず1行にする。
  text = multiline ? text.replace(/[^\S\n]+\n/g, "\n").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  text = text.trim();
  const length = [...text].length;
  if (length === 0) throw new HttpError(400, `${label}を入力してください。`);
  if (length > maxLength) throw new HttpError(400, `${label}は${maxLength}文字以内にしてください。`);
  return text;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  // JSON以外を受け付けないことで、他サイトのフォームから勝手に投稿させられるのも防ぐ
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "JSON形式で送信してください。");
  }
  const text = await readTextWithLimit(request, MAX_REQUEST_BYTES);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "送信内容を読み取れませんでした。");
  }
  if (!isRecord(data)) throw new HttpError(400, "送信内容を読み取れませんでした。");
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new HttpError(413, "送信内容が大きすぎます。");
  if (Number(request.headers.get("content-length")) > maxBytes) throw tooLarge();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

async function checkRateLimit(env: Env, request: Request): Promise<void> {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const { success } = await env.WRITE_LIMITER.limit({ key: rateLimitKey(ip) });
  if (!success) {
    throw new HttpError(429, "短い時間に送信しすぎです。1分ほど待ってからもう一度お試しください。");
  }
}

// IPv6 は1回線に /64 単位で割り当てられ、その範囲内ならアドレスを自由に変えられるので /64 単位で数える
function rateLimitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...zeros, ...right].slice(0, 4).join(":") + "::/64";
}
