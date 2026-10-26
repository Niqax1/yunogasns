// アカウント設定（アイコン・アカウント名・通知・ログアウト）

import { api } from "./api.js";
import { compressImage } from "./images.js";
import { disablePush, enablePush, pushState } from "./push.js";
import { session } from "./state.js";
import { $, MAX_NAME_LENGTH, avatar, h, spinner, toast } from "./ui.js";

const PUSH_MESSAGES = {
  unconfigured: "通知はまだ使えません（管理者がサーバーの設定をする必要があります）。",
  "ios-home-screen":
    "iPhone では、Safari の共有ボタンから「ホーム画面に追加」し、ホーム画面のアイコンから開くと通知を受け取れます。",
  unsupported: "このブラウザでは通知を受け取れません。",
  denied: "通知がブロックされています。端末の設定で、このアプリ（サイト）の通知を許可してください。",
  off: "この端末では、まだ通知を受け取っていません。",
  on: "この端末で通知を受け取っています。",
};

// サーバーの通知用の公開鍵（通知が使えないときは null）
let vapidPublicKey = null;

let callbacks = { onUserChange: () => {}, onLogout: () => {} };

export function initSettings(options) {
  callbacks = options;
  $("#avatar-input").addEventListener("change", uploadAvatar);
  $("#avatar-remove").addEventListener("click", removeAvatar);
  $("#name-form").addEventListener("submit", saveName);
  $("#logout-button").addEventListener("click", () => callbacks.onLogout());
  $("#push-status").addEventListener("click", togglePush);
  $("#notify-settings").addEventListener("change", saveNotifySetting);
}

export function showSettings() {
  const me = session.me;
  renderAvatar();
  $("#name-input").value = me.name;
  $("#settings-id").textContent = me.id;
  $("#settings-admin").hidden = !me.isAdmin;
  loadNotificationSettings();
}

// ---- 通知 ----

async function loadNotificationSettings() {
  $("#push-status").replaceChildren(spinner());
  try {
    const { settings, vapidPublicKey: key } = await api("/api/me/notifications");
    vapidPublicKey = key;
    for (const input of document.querySelectorAll("#notify-settings input[data-setting]")) {
      input.checked = Boolean(settings[input.dataset.setting]);
    }
    await renderPushState();
  } catch (error) {
    $("#push-status").replaceChildren(h("p", { class: "hint" }, error.message));
  }
}

async function renderPushState() {
  const state = await pushState(vapidPublicKey);
  const button =
    state === "off"
      ? h("button", { type: "button", class: "button button--primary", dataset: { push: "enable" } }, "この端末で通知を受け取る")
      : state === "on"
        ? h("button", { type: "button", class: "button button--ghost", dataset: { push: "disable" } }, "この端末の通知を止める")
        : "";
  $("#push-status").replaceChildren(h("p", { class: state === "on" ? "push-on" : "hint" }, PUSH_MESSAGES[state]), button);
}

async function togglePush(event) {
  const button = event.target instanceof Element ? event.target.closest("[data-push]") : null;
  if (!button) return;
  button.disabled = true;
  try {
    // enablePush は最初に通知の許可を求める。iPhone では、ボタンを押した処理の中ですぐ呼ぶ必要がある
    if (button.dataset.push === "enable") {
      await enablePush(vapidPublicKey);
      toast("この端末で通知を受け取るようにしました");
    } else {
      await disablePush();
      toast("この端末の通知を止めました");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    await renderPushState();
  }
}

async function saveNotifySetting(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.dataset.setting) return;
  try {
    await api("/api/me/notifications", { method: "PATCH", body: { [input.dataset.setting]: input.checked } });
  } catch (error) {
    input.checked = !input.checked;
    toast(error.message);
  }
}

function renderAvatar() {
  $("#settings-avatar").replaceChildren(avatar(session.me, "large"));
  $("#avatar-remove").hidden = !session.me.avatarUrl;
}

function setUser(user) {
  session.me = user;
  renderAvatar();
  callbacks.onUserChange();
}

function setBusy(busy) {
  for (const el of document.querySelectorAll("#settings-view button, #settings-view input")) el.disabled = busy;
}

async function uploadAvatar(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  // 同じファイルを選び直しても反応するように、選択を空に戻しておく
  input.value = "";
  if (!file) return;
  setBusy(true);
  try {
    const { blob } = await compressImage(file, { maxSize: 320, square: true });
    const { user } = await api("/api/me/avatar", { method: "PUT", blob });
    setUser(user);
    toast("アイコンを変更しました");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function removeAvatar() {
  if (!confirm("アイコンを削除して、名前の1文字目の表示に戻しますか？")) return;
  setBusy(true);
  try {
    const { user } = await api("/api/me/avatar", { method: "DELETE" });
    setUser(user);
    toast("アイコンを削除しました");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function saveName(event) {
  event.preventDefault();
  const name = $("#name-input").value.trim();
  if (!name) return toast("アカウント名を入力してください。");
  if ([...name].length > MAX_NAME_LENGTH) return toast(`アカウント名は${MAX_NAME_LENGTH}文字以内にしてください。`);
  setBusy(true);
  try {
    const { user } = await api("/api/me", { method: "PATCH", body: { name } });
    setUser(user);
    $("#name-input").value = user.name;
    toast("アカウント名を変更しました");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}
