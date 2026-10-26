// プロフィール：その人の投稿・フォロー中・フォロワーの一覧と、フォロー／投稿の通知の切り替え

import { api } from "./api.js";
import { remember } from "./state.js";
import { $, avatar, h, icon, spinner, toast, userRow } from "./ui.js";

const TABS = ["posts", "following", "followers"];

const profile = {
  id: null,
  data: null,
  token: 0, // 別のプロフィールを開いたら、前のリクエストの結果を捨てるための番号
  tab: "posts",
  postsLoaded: false,
  loading: false,
  oldestId: null,
  hasMore: false,
};

// 投稿カードの描き方はタイムラインと同じ（app.js から受け取る）
let renderPost = () => null;

export function initProfile(options) {
  renderPost = options.renderPost;
  for (const tab of TABS) $(`#profile-tab-${tab}`).addEventListener("click", () => selectTab(tab));
  $("#profile-head").addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-profile-action]") : null;
    if (button?.dataset.profileAction === "follow") toggleFollow();
    if (button?.dataset.profileAction === "notify") toggleNotify();
  });
  $("#profile-status").addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-more]")) loadPosts();
  });
}

export async function showProfile(id) {
  const token = ++profile.token;
  Object.assign(profile, { id, data: null, tab: "posts", postsLoaded: false, loading: false, oldestId: null, hasMore: false });
  $("#profile-head").replaceChildren(h("div", { class: "list-status" }, spinner()));
  $("#profile-tabs").hidden = true;
  $("#profile-posts").replaceChildren();
  $("#profile-users").replaceChildren();
  $("#profile-status").replaceChildren();
  window.scrollTo(0, 0);
  try {
    const data = await api(`/api/users/${encodeURIComponent(id)}`);
    if (token !== profile.token) return;
    profile.data = data;
    renderHead();
    $("#profile-tabs").hidden = false;
    selectTab("posts");
  } catch (error) {
    if (token !== profile.token) return;
    $("#profile-head").replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", {}, error.status === 404 ? "アカウントが見つかりません" : "読み込めませんでした"),
        error.message,
      ),
    );
  }
}

function renderHead() {
  const { user, isMe, following, notify, followsMe, followingCount, followerCount } = profile.data;
  const actions = isMe
    ? [h("a", { href: "/settings", class: "button button--ghost", dataset: { link: "" } }, "設定")]
    : [
        following
          ? h(
              "button",
              {
                type: "button",
                class: notify ? "icon-button notify-toggle is-on" : "icon-button notify-toggle",
                dataset: { profileAction: "notify" },
                "aria-pressed": String(notify),
                "aria-label": "この人の投稿を通知する",
                title: notify ? "この人の投稿を通知する：オン" : "この人の投稿を通知する：オフ",
              },
              icon(notify ? "bell" : "bell-off"),
            )
          : null,
        h(
          "button",
          { type: "button", class: following ? "button button--ghost" : "button button--primary", dataset: { profileAction: "follow" } },
          following ? "フォロー中" : "フォローする",
        ),
      ];
  $("#profile-head").replaceChildren(
    h("div", { class: "profile-top" }, avatar(user, "large"), h("div", { class: "profile-actions" }, ...actions)),
    h("div", { class: "profile-name" }, user.name),
    h("div", { class: "profile-id" }, `@${user.id}`, followsMe ? h("span", { class: "badge" }, "フォローされています") : null),
    !isMe && following
      ? h("p", { class: "hint" }, notify ? "この人が投稿すると通知します（ベルで切り替え）" : "この人の投稿は通知しません（ベルで切り替え）")
      : "",
  );
  $("#profile-following-count").textContent = String(followingCount);
  $("#profile-follower-count").textContent = String(followerCount);
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("#profile-head button")) button.disabled = busy;
}

async function toggleFollow() {
  const { user, following } = profile.data;
  if (following && !confirm(`@${user.id} のフォローを外しますか？`)) return;
  setBusy(true);
  try {
    const path = `/api/users/${encodeURIComponent(user.id)}/follow`;
    const result = await api(path, following ? { method: "DELETE" } : { method: "PUT", body: {} });
    Object.assign(profile.data, result);
    renderHead();
    toast(result.following ? "フォローしました（この人の投稿を通知します）" : "フォローを外しました");
    if (profile.tab === "followers") loadUsers("followers");
  } catch (error) {
    toast(error.message);
    setBusy(false);
  }
}

async function toggleNotify() {
  const { user, notify } = profile.data;
  setBusy(true);
  try {
    const result = await api(`/api/users/${encodeURIComponent(user.id)}/follow`, { method: "PUT", body: { notify: !notify } });
    Object.assign(profile.data, result);
    renderHead();
    toast(result.notify ? "この人の投稿を通知します" : "この人の投稿は通知しません");
  } catch (error) {
    toast(error.message);
    setBusy(false);
  }
}

function selectTab(tab) {
  profile.tab = tab;
  for (const name of TABS) $(`#profile-tab-${name}`).setAttribute("aria-selected", String(name === tab));
  $("#profile-posts").hidden = tab !== "posts";
  $("#profile-users").hidden = tab === "posts";
  if (tab !== "posts") loadUsers(tab);
  else if (profile.postsLoaded) renderPostsStatus();
  else loadPosts();
}

async function loadPosts() {
  const { token } = profile;
  if (profile.loading) return;
  profile.loading = true;
  $("#profile-status").replaceChildren(spinner());
  try {
    const query = profile.oldestId === null ? "" : `?before=${profile.oldestId}`;
    const data = await api(`/api/users/${encodeURIComponent(profile.id)}/posts${query}`);
    if (token !== profile.token) return;
    $("#profile-posts").append(...data.posts.map((post) => renderPost(remember(post))));
    if (data.posts.length > 0) profile.oldestId = data.posts.at(-1).id;
    profile.hasMore = data.hasMore;
    profile.postsLoaded = true;
  } catch (error) {
    if (token === profile.token) toast(error.message);
  } finally {
    if (token === profile.token) {
      profile.loading = false;
      renderPostsStatus();
    }
  }
}

function renderPostsStatus() {
  if (profile.tab !== "posts") return;
  const status = $("#profile-status");
  if ($("#profile-posts").children.length === 0) {
    status.replaceChildren(h("p", {}, "7日以内の投稿はありません"));
  } else if (profile.hasMore) {
    status.replaceChildren(h("button", { type: "button", class: "button button--ghost", dataset: { more: "" } }, "もっと見る"));
  } else {
    status.replaceChildren();
  }
}

async function loadUsers(tab) {
  const { token } = profile;
  const status = $("#profile-status");
  $("#profile-users").replaceChildren();
  status.replaceChildren(spinner());
  try {
    const { users } = await api(`/api/users/${encodeURIComponent(profile.id)}/${tab}`);
    if (token !== profile.token || profile.tab !== tab) return;
    $("#profile-users").replaceChildren(...users.map((user) => userRow(user)));
    const empty = tab === "following" ? "まだだれもフォローしていません" : "まだフォロワーはいません";
    status.replaceChildren(users.length === 0 ? h("p", {}, empty) : "");
  } catch (error) {
    if (token === profile.token) status.replaceChildren(h("p", {}, error.message));
  }
}

/** タイムラインなどで投稿が削除されたときに、プロフィールの一覧からも消えたかどうかに合わせて表示を直す */
export function refreshProfileStatus() {
  if (profile.data) renderPostsStatus();
}
