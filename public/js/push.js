// この端末で通知（Web Push）を受け取るための設定。
// iPhone では、Safari の「ホーム画面に追加」で追加したアプリから開いたときだけ使える（iOS 16.4 以降）。

import { api } from "./api.js";

export function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function isSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * この端末の状態。
 * unconfigured: サーバー側で通知の準備ができていない / ios-home-screen: iPhone でホーム画面から開いていない
 * unsupported: このブラウザでは使えない / denied: 通知がブロックされている / off: 未登録 / on: 受け取っている
 */
export async function pushState(vapidPublicKey) {
  if (!vapidPublicKey) return "unconfigured";
  if (!isSupported()) return isIos() && !isStandalone() ? "ios-home-screen" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const subscription = await currentSubscription();
  return subscription && sameKey(subscription, vapidPublicKey) ? "on" : "off";
}

/** 通知を許可してもらい、この端末をいまのアカウントの通知の受け取り先に登録する */
export async function enablePush(vapidPublicKey) {
  // iPhone では、ボタンを押した処理の中で最初に許可を求めないと、許可の画面が出ない
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied" ? "通知がブロックされました。端末の設定で、このアプリの通知を許可してください。" : "通知が許可されませんでした。");
  }
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  // サーバーの鍵が変わっていたら、登録し直す
  if (subscription && !sameKey(subscription, vapidPublicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(vapidPublicKey),
  });
  await api("/api/push/subscriptions", { method: "POST", body: subscription.toJSON() });
}

/** この端末で通知を受け取るのをやめる */
export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/api/push/subscriptions", { method: "DELETE", body: { endpoint: subscription.endpoint } });
  await subscription.unsubscribe();
}

/** ログインしたとき・開いたとき：通知を許可済みの端末なら、いまのアカウントの受け取り先として登録しておく */
export async function syncPushSubscription() {
  if (!isSupported() || Notification.permission !== "granted") return;
  const subscription = await currentSubscription();
  if (subscription) await api("/api/push/subscriptions", { method: "POST", body: subscription.toJSON() }).catch(() => {});
}

/** ログアウトする前：この端末に、ログアウトしたアカウントの通知が届かないようにする（端末の許可はそのまま） */
export async function forgetPushSubscription() {
  if (!isSupported()) return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await api("/api/push/subscriptions", { method: "DELETE", body: { endpoint: subscription.endpoint } }).catch(() => {});
}

function sameKey(subscription, vapidPublicKey) {
  const key = subscription.options?.applicationServerKey;
  return !key || toBase64Url(new Uint8Array(key)) === vapidPublicKey;
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
