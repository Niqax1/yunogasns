// サーバー（/api/*）との通信。ログイン情報は Cookie で自動的に送られる

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};

/** ログインが切れていたとき（401）に呼ぶ処理を登録する */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/**
 * body: JSON で送るデータ / form: FormData（写真つきの投稿） / blob: 画像そのもの（アイコン）
 */
export async function api(path, { method = "GET", body, form, blob } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : blob ? { "content-type": blob.type } : undefined,
      body: body !== undefined ? JSON.stringify(body) : (form ?? blob),
    });
  } catch {
    throw new ApiError(0, "通信できませんでした。電波の状態を確認してください。");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") onUnauthorized();
    // Workers の1日のリクエスト上限を超えたときは、JSONではない 429 が返る
    const fallback =
      response.status === 429
        ? "アクセスが集中しているか、今日の無料枠の上限に達しています。しばらくしてからお試しください。"
        : `エラーが発生しました（${response.status}）。`;
    throw new ApiError(response.status, data?.error ?? fallback);
  }
  return data;
}
