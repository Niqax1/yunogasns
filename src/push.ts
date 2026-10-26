/**
 * 端末への通知（Web Push）の送信。
 * 通知の中身の暗号化（RFC 8291）と、送り主の証明（VAPID / RFC 8292）を Web Crypto だけで行う。
 */

export type PushMessage = { title: string; body: string; url: string; tag?: string };

type Subscription = { endpoint: string; p256dh: string; auth: string };

// 届かなかったときに、プッシュサービスが通知を預かっておく時間
const TTL_SECONDS = 24 * 60 * 60;
// 暗号化した中身の1レコードの大きさ（通知の中身は小さいので1レコードに収まる）
const RECORD_SIZE = 4096;

// 通知を送ってよいプッシュサービス。登録された送り先以外のURLへ、このサーバーからリクエストを送らせないため
const PUSH_HOST_SUFFIXES = [".googleapis.com", ".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && PUSH_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
}

/** ブラウザから受け取った鍵（p256dh: 65バイトの公開鍵、auth: 16バイト）の形が正しいか */
export function isValidSubscriptionKeys(p256dh: string, auth: string): boolean {
  try {
    const key = fromBase64Url(p256dh);
    return key.length === 65 && key[0] === 4 && fromBase64Url(auth).length === 16;
  } catch {
    return false;
  }
}

/**
 * 指定したアカウントの登録済みの端末に通知を送る。最大 limit 台。送った台数を返す。
 * 送り先がなくなっていた（404/410）端末の登録は消す。
 */
export async function sendPushToUsers(
  env: Env,
  origin: string,
  userIds: string[],
  message: PushMessage,
  limit: number,
): Promise<number> {
  if (userIds.length === 0 || limit <= 0 || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (SELECT value FROM json_each(?1)) LIMIT ?2",
  )
    .bind(JSON.stringify([...new Set(userIds)]), limit)
    .all<Subscription>();
  if (results.length === 0) return 0;

  const payload = new TextEncoder().encode(JSON.stringify(message));
  const authorization = vapidAuthorization(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, origin);
  const statuses = await Promise.all(
    results.map((subscription) =>
      sendPush(subscription, payload, authorization).then(
        (response) => response.status,
        () => 0,
      ),
    ),
  );
  const gone = results.filter((_, i) => statuses[i] === 404 || statuses[i] === 410).map((s) => s.endpoint);
  if (gone.length > 0) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(gone))
      .run();
  }
  const failed = statuses.filter((status) => status < 200 || status >= 300).length - gone.length;
  console.log(JSON.stringify({ message: "push", devices: results.length, failed, gone: gone.length }));
  return results.length;
}

async function sendPush(
  subscription: Subscription,
  payload: Uint8Array,
  authorization: (audience: string) => Promise<string>,
): Promise<Response> {
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await authorization(new URL(subscription.endpoint).origin),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(TTL_SECONDS),
      urgency: "normal",
    },
    body: await encryptPayload(subscription, payload),
  });
}

/**
 * VAPID の Authorization ヘッダーを作る関数を返す。
 * 署名はプッシュサービス（送り先のオリジン）ごとに1回だけ行い、同じ送り先には使い回す。
 * subject には、このアプリのURLを使う（Apple は mailto: か https: のURLを求める）。
 */
export function vapidAuthorization(publicKey: string, privateKey: string, subject: string) {
  const signingKey = importVapidKey(publicKey, privateKey);
  const tokens = new Map<string, Promise<string>>();
  return async (audience: string) => {
    let token = tokens.get(audience);
    if (!token) {
      token = signingKey.then((key) => signJwt(key, { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
      tokens.set(audience, token);
    }
    return `vapid t=${await token}, k=${publicKey}`;
  };
}

/** VAPID の鍵：公開鍵は65バイト（0x04 + x + y）、秘密鍵は32バイトで、どちらも base64url */
async function importVapidKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const point = fromBase64Url(publicKey);
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33, 65)), d: privateKey },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function signJwt(key: CryptoKey, claims: Record<string, string | number>): Promise<string> {
  const part = (value: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  // Web Crypto の ECDSA の署名は r と s を並べた64バイトで、そのまま ES256 の署名として使える
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${toBase64Url(new Uint8Array(signature))}`;
}

/** 通知の中身を、受け取る端末の鍵で暗号化する（RFC 8291、Content-Encoding: aes128gcm） */
export async function encryptPayload(subscription: { p256dh: string; auth: string }, payload: Uint8Array): Promise<Uint8Array> {
  const receiverKey = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);

  // 通知ごとに使い捨ての鍵を作り、端末の公開鍵との間で共有の秘密を作る
  const senderKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  if (!("privateKey" in senderKeys)) throw new Error("ECDH key generation failed");
  const senderPublic = new Uint8Array(await exportRaw(senderKeys.publicKey));
  const receiverPublic = await crypto.subtle.importKey("raw", receiverKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Workers の型定義ではこの項目が "$public" と書かれているが、実行時の名前は Web 標準どおり "public"
  const ecdh = { name: "ECDH", public: receiverPublic };
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, senderKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, sharedSecret, concat(text("WebPush: info\0"), receiverKey, senderPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  // 中身の後ろに「最後のレコード」を表す 0x02 を付けてから暗号化する
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(payload, new Uint8Array([2]))),
  );

  // 先頭に salt（16バイト）・レコードの大きさ（4バイト）・送信側の公開鍵の長さと公開鍵を付ける
  const header = new Uint8Array(16 + 4 + 1 + senderPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  header.set(senderPublic, 21);
  return concat(header, ciphertext);
}

async function exportRaw(key: CryptoKey): Promise<ArrayBuffer> {
  const raw = await crypto.subtle.exportKey("raw", key);
  if (!(raw instanceof ArrayBuffer)) throw new Error("unexpected key format");
  return raw;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
}
