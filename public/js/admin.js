// 管理画面（管理者だけが開ける）：アカウントの発行・削除と、投稿の削除

import { api } from "./api.js";
import { renderNotice } from "./notices.js";
import { session } from "./state.js";
import { $, MAX_BODY_LENGTH, authorLabel, avatar, dateTimeFormat, h, spinner, timeEl, toast, userRow } from "./ui.js";

// 選んで削除するときに、1回のリクエストで送る投稿の数（サーバー側の上限と同じ）
const DELETE_CHUNK = 100;

// src/config.ts の MAX_NOTICE_TITLE_LENGTH と同じ値にしておく
const MAX_NOTICE_TITLE_LENGTH = 50;

const TABS = ["accounts", "posts", "notices"];

const admin = {
  tab: "accounts",
  posts: { loaded: false, loading: false, oldestId: null, hasMore: false },
};

let callbacks = { onPostsDeleted: () => {} };

export function initAdmin(options) {
  callbacks = options;
  for (const tab of TABS) $(`#admin-tab-${tab}`).addEventListener("click", () => selectTab(tab));
  $("#notice-form").addEventListener("submit", sendNotice);
  $("#admin-notice-list").addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-delete-notice]") : null;
    if (button) deleteNotice(Number(button.dataset.deleteNotice));
  });
  $("#issue-form").addEventListener("submit", issueAccount);
  $("#account-list").addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-delete-user]") : null;
    if (button) deleteAccount(button.dataset.deleteUser);
  });
  $("#admin-post-list").addEventListener("change", updateSelection);
  $("#admin-posts-status").addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-more]")) loadPosts();
  });
  $("#select-all-posts").addEventListener("change", (event) => {
    for (const box of postCheckboxes()) box.checked = event.currentTarget.checked;
    updateSelection();
  });
  $("#delete-selected").addEventListener("click", deleteSelected);
  $("#delete-all").addEventListener("click", deleteAll);

  const dialog = $("#issued-dialog");
  $("#issued-copy").addEventListener("click", copyIssued);
  $("#issued-close").addEventListener("click", () => dialog.close());
  // Esc キーなどで誤って閉じてしまわないよう、「閉じる」ボタンでだけ閉じる
  dialog.addEventListener("cancel", (event) => event.preventDefault());
}

export function showAdmin() {
  selectTab(admin.tab);
  loadAccounts();
}

function selectTab(tab) {
  admin.tab = tab;
  for (const name of TABS) {
    $(`#admin-tab-${name}`).setAttribute("aria-selected", String(name === tab));
    $(`#admin-${name}`).hidden = name !== tab;
  }
  if (tab === "posts") loadPosts({ reset: true });
  if (tab === "notices") loadNotices();
}

// ---- アカウント ----

async function loadAccounts() {
  const status = $("#accounts-status");
  status.replaceChildren(spinner());
  try {
    const { users } = await api("/api/admin/users");
    $("#account-list").replaceChildren(...users.map(renderAccount));
    status.replaceChildren();
  } catch (error) {
    status.replaceChildren(h("p", {}, error.message));
  }
}

function renderAccount(user) {
  const isMe = user.id === session.me?.id;
  return userRow(
    user,
    h(
      "div",
      { class: "user-row-meta" },
      user.isAdmin ? h("span", { class: "badge" }, "管理者") : null,
      h("span", { class: "hint" }, `${dateTimeFormat.format(user.createdAt)} 発行`),
    ),
    isMe
      ? null
      : h("button", { type: "button", class: "button button--danger button--small", dataset: { deleteUser: user.id } }, "削除"),
  );
}

async function issueAccount(event) {
  event.preventDefault();
  const input = $("#issue-id");
  const id = input.value.trim();
  if (!/^[A-Za-z0-9_]{1,20}$/.test(id)) return toast("IDは英数字と _ で、20文字までにしてください。");
  const button = $("#issue-submit");
  button.disabled = true;
  try {
    const { user, password } = await api("/api/admin/users", { method: "POST", body: { id } });
    input.value = "";
    showIssued(user.id, password);
    loadAccounts();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

/** 発行したIDとパスワードを表示する（パスワードはこのときしか分からない） */
function showIssued(id, password) {
  $("#issued-id").textContent = id;
  $("#issued-password").textContent = password;
  $("#issued-copy").textContent = "IDとパスワードをコピー";
  $("#issued-dialog").showModal();
}

async function copyIssued() {
  const text = `ID: ${$("#issued-id").textContent}\nパスワード: ${$("#issued-password").textContent}`;
  const button = $("#issued-copy");
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "コピーしました";
  } catch {
    button.textContent = "コピーできませんでした。手で書き写してください";
  }
}

async function deleteAccount(id) {
  if (!confirm(`@${id} を削除しますか？\nこの人の投稿・コメント・いいねもすべて消え、元に戻せません。`)) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(`@${id} を削除しました`);
    loadAccounts();
    callbacks.onPostsDeleted();
  } catch (error) {
    toast(error.message);
  }
}

// ---- 投稿 ----

async function loadPosts({ reset = false } = {}) {
  const state = admin.posts;
  if (state.loading) return;
  if (reset) {
    Object.assign(state, { loaded: false, oldestId: null, hasMore: false });
    $("#admin-post-list").replaceChildren();
    $("#select-all-posts").checked = false;
    updateSelection();
  }
  state.loading = true;
  const status = $("#admin-posts-status");
  status.replaceChildren(spinner());
  try {
    const query = state.oldestId === null ? "" : `?before=${state.oldestId}`;
    const data = await api(`/api/posts${query}`);
    $("#admin-post-list").append(...data.posts.map(renderAdminPost));
    if (data.posts.length > 0) state.oldestId = data.posts.at(-1).id;
    state.hasMore = data.hasMore;
    state.loaded = true;
    renderPostsStatus();
  } catch (error) {
    status.replaceChildren(h("p", {}, error.message));
  } finally {
    state.loading = false;
  }
}

function renderPostsStatus() {
  const status = $("#admin-posts-status");
  if (postCheckboxes().length === 0) {
    status.replaceChildren(h("p", {}, "投稿はありません"));
  } else if (admin.posts.hasMore) {
    status.replaceChildren(h("button", { type: "button", class: "button button--ghost", dataset: { more: "" } }, "もっと見る"));
  } else {
    status.replaceChildren();
  }
}

function renderAdminPost(post) {
  const summary = post.body || (post.images.length > 0 ? "（写真のみ）" : "");
  return h(
    "li",
    { class: "admin-post", dataset: { id: post.id } },
    h(
      "label",
      { class: "admin-post-check" },
      h("input", { type: "checkbox", value: post.id, "aria-label": "この投稿を選択" }),
    ),
    avatar(post.author, "small"),
    h(
      "div",
      { class: "admin-post-main" },
      h("div", { class: "post-head" }, ...authorLabel(post.author), h("span", { class: "post-time" }, timeEl(post.createdAt))),
      h("div", { class: "admin-post-body" }, summary),
      post.images.length > 0 ? h("div", { class: "hint" }, `写真 ${post.images.length}枚`) : null,
    ),
  );
}

function postCheckboxes() {
  return [...document.querySelectorAll("#admin-post-list input[type=checkbox]")];
}

function selectedIds() {
  return postCheckboxes()
    .filter((box) => box.checked)
    .map((box) => Number(box.value));
}

function updateSelection() {
  const count = selectedIds().length;
  const button = $("#delete-selected");
  button.disabled = count === 0;
  button.textContent = count > 0 ? `選択した${count}件を削除` : "選択した投稿を削除";
  const boxes = postCheckboxes();
  $("#select-all-posts").checked = boxes.length > 0 && count === boxes.length;
}

async function deleteSelected() {
  const ids = selectedIds();
  if (ids.length === 0) return;
  if (!confirm(`選択した${ids.length}件の投稿を削除しますか？\nコメントやいいねも一緒に消え、元に戻せません。`)) return;
  const button = $("#delete-selected");
  button.disabled = true;
  let deleted = 0;
  try {
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const chunk = ids.slice(i, i + DELETE_CHUNK);
      await api("/api/admin/posts/delete", { method: "POST", body: { ids: chunk } });
      for (const id of chunk) document.querySelector(`#admin-post-list .admin-post[data-id="${id}"]`)?.remove();
      deleted += chunk.length;
    }
    toast(`${deleted}件の投稿を削除しました`);
  } catch (error) {
    toast(error.message);
  } finally {
    updateSelection();
    renderPostsStatus();
    if (deleted > 0) callbacks.onPostsDeleted();
  }
}

async function deleteAll() {
  const answer = prompt("全員の投稿・コメント・いいねをすべて削除します。元に戻せません。\n実行するには「削除」と入力してください。");
  if (answer?.trim() !== "削除") return;
  try {
    const { deleted } = await api("/api/admin/posts/delete-all", { method: "POST", body: { confirm: true } });
    toast(`${deleted}件の投稿を削除しました`);
    callbacks.onPostsDeleted();
    loadPosts({ reset: true });
  } catch (error) {
    toast(error.message);
  }
}

// ---- お知らせ ----

async function loadNotices() {
  const status = $("#admin-notices-status");
  status.replaceChildren(spinner());
  try {
    const { notices } = await api("/api/notices");
    $("#admin-notice-list").replaceChildren(
      ...notices.map((notice) =>
        renderNotice(notice, {
          extra: h(
            "button",
            { type: "button", class: "button button--danger button--small", dataset: { deleteNotice: notice.id } },
            "削除",
          ),
        }),
      ),
    );
    status.replaceChildren(notices.length === 0 ? h("p", {}, "まだお知らせを送っていません") : "");
  } catch (error) {
    status.replaceChildren(h("p", {}, error.message));
  }
}

async function sendNotice(event) {
  event.preventDefault();
  const title = $("#notice-title").value.trim();
  const body = $("#notice-body").value.trim();
  if (!title) return toast("タイトルを入力してください。");
  if ([...title].length > MAX_NOTICE_TITLE_LENGTH) return toast(`タイトルは${MAX_NOTICE_TITLE_LENGTH}文字以内にしてください。`);
  if ([...body].length > MAX_BODY_LENGTH) return toast(`本文は${MAX_BODY_LENGTH}文字以内にしてください。`);
  if (!confirm(`「${title}」を全員にお知らせしますか？`)) return;
  const button = $("#notice-submit");
  button.disabled = true;
  try {
    await api("/api/admin/notices", { method: "POST", body: { title, body } });
    $("#notice-title").value = "";
    $("#notice-body").value = "";
    toast("お知らせを送信しました");
    loadNotices();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteNotice(id) {
  if (!confirm("このお知らせを削除しますか？\nみんなのお知らせ一覧からも消えます。")) return;
  try {
    await api(`/api/admin/notices/${id}`, { method: "DELETE" });
    toast("お知らせを削除しました");
    loadNotices();
  } catch (error) {
    toast(error.message);
  }
}
