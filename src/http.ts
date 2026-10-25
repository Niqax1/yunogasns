/** リクエストの読み取り・入力チェック・レスポンス作成など、API 全体で使う部品 */

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** limit+1 件取得した結果から、1ページ分と「続きがあるか」を取り出す */
export function pageOf<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export function readIdParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, `${key} の指定が正しくありません。`);
  return Number(raw);
}

/**
 * ログインに Cookie を使っているので、他のサイトから利用者のブラウザ経由で勝手に操作させられないよう、
 * 書き込み系のリクエストは同じサイトから送られたものだけを受け付ける。
 */
export function assertSameOrigin(request: Request, url: URL): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) throw new HttpError(403, "このリクエストは受け付けられません。");
}

// 制御文字と、表示順を入れ替えて見た目を偽装できる双方向制御文字（改行とタブは別に扱う）
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g;

/**
 * 入力された文字列を整える。本文（multiline）は空行を2行までにし、名前は1行にまとめる。
 * allowEmpty のときは空でもよい（写真だけの投稿など）。
 */
export function cleanText(
  value: unknown,
  label: string,
  maxLength: number,
  { multiline, allowEmpty = false }: { multiline: boolean; allowEmpty?: boolean },
): string {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw new HttpError(400, `${label}を入力してください。`);
  let text = value.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(UNSAFE_CHARS, "");
  text = multiline ? text.replace(/[^\S\n]+\n/g, "\n").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  text = text.trim();
  const length = [...text].length;
  if (length === 0 && !allowEmpty) throw new HttpError(400, `${label}を入力してください。`);
  if (length > maxLength) throw new HttpError(400, `${label}は${maxLength}文字以内にしてください。`);
  return text;
}

export async function readJson(request: Request, maxBytes = 8 * 1024): Promise<Record<string, unknown>> {
  // JSON以外を受け付けないことで、他サイトのフォームから送信させる攻撃も防ぐ
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "JSON形式で送信してください。");
  }
  const bytes = await readBody(request, maxBytes);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "送信内容を読み取れませんでした。");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HttpError(400, "送信内容を読み取れませんでした。");
  }
  return data as Record<string, unknown>;
}

/** 写真つきの投稿（multipart/form-data）を読む。先に上限までのバイト数だけ読み込んでから解析する */
export async function readForm(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "送信の形式が正しくありません。");
  }
  const bytes = await readBody(request, maxBytes);
  try {
    return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new HttpError(400, "送信内容を読み取れませんでした。");
  }
}

/** 本文を上限つきで読む。大きすぎるリクエストでメモリを使い切らないよう、途中で打ち切る */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new HttpError(413, "送信内容が大きすぎます。");
  if (Number(request.headers.get("content-length")) > maxBytes) throw tooLarge();
  if (!request.body) return new Uint8Array();

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
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function checkRateLimit(limiter: RateLimit, key: string, message: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, message);
}

/**
 * レート制限に使うIPアドレスのキー。
 * IPv6 は1回線に /64 単位で割り当てられ、その範囲内ならアドレスを自由に変えられるので /64 単位で数える。
 */
export function clientIpKey(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...zeros, ...right].slice(0, 4).join(":") + "::/64";
}
