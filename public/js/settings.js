// アカウント設定（アイコン・アカウント名・ログアウト）

import { api } from "./api.js";
import { compressImage } from "./images.js";
import { session } from "./state.js";
import { $, MAX_NAME_LENGTH, avatar, toast } from "./ui.js";

let callbacks = { onUserChange: () => {}, onLogout: () => {} };

export function initSettings(options) {
  callbacks = options;
  $("#avatar-input").addEventListener("change", uploadAvatar);
  $("#avatar-remove").addEventListener("click", removeAvatar);
  $("#name-form").addEventListener("submit", saveName);
  $("#logout-button").addEventListener("click", () => callbacks.onLogout());
}

export function showSettings() {
  const me = session.me;
  renderAvatar();
  $("#name-input").value = me.name;
  $("#settings-id").textContent = me.id;
  $("#settings-admin").hidden = !me.isAdmin;
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
