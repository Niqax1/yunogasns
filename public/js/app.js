// yunogasns の画面の中心：ログイン・タイムライン・投稿の詳細・投稿画面・画面の切り替え・新着の確認。
// アカウント設定は settings.js、管理画面は admin.js にある。ビルドなしでそのまま動く素の JavaScript で書いている。

import { initAdmin, showAdmin } from "./admin.js";
import { api, setUnauthorizedHandler } from "./api.js";
import { compressImage } from "./images.js";
import { setUnreadNotices, showNotices } from "./notices.js";
import { initProfile, refreshProfileStatus, showProfile } from "./profile.js";
import { forgetPushSubscription, registerServiceWorker, syncPushSubscription } from "./push.js";
import { navigate, onRoute } from "./router.js";
import { canDelete, posts, remember, session } from "./state.js";
import { initSettings, showSettings } from "./settings.js";
import {
  $,
  MAX_BODY_LENGTH,
  MAX_IMAGES_PER_POST,
  authorLabel,
  autoGrow,
  avatar,
  countLabel,
  dateTimeFormat,
  h,
  icon,
  imageGrid,
  linkify,
  profileLink,
  refreshTimes,
  spinner,
  textLength,
  timeEl,
  timeLeft,
  toast,
  userRow,
} from "./ui.js";

// 新着を確認する間隔。画面を開いている人1人につき、1時間で120リクエストを使う
// （Workers の無料枠は1日10万リクエスト。README の「どれくらい使えるか」を参照）
const POLL_INTERVAL_MS = 30_000;

const THEME_KEY = "yunogasns:theme";
const APP_TITLE = document.title;

// ---- 画面の要素 ----

const ui = {
  themeColor: $('meta[name="theme-color"]'),
  backButton: $("#back-button"),
  brand: $("#brand"),
  viewTitle: $("#view-title"),
  themeButton: $("#theme-button"),
  accountButton: $("#account-button"),
  noticeButton: $("#notice-button"),
  views: {
    boot: $("#boot-view"),
    login: $("#login-view"),
    timeline: $("#timeline-view"),
    detail: $("#detail-view"),
    settings: $("#settings-view"),
    admin: $("#admin-view"),
    notices: $("#notices-view"),
    profile: $("#profile-view"),
  },
  loginForm: $("#login-form"),
  loginId: $("#login-id"),
  loginPassword: $("#login-password"),
  loginError: $("#login-error"),
  loginSubmit: $("#login-submit"),
  newPostsPill: $("#new-posts-pill"),
  newPostsLabel: $("#new-posts-label"),
  postList: $("#post-list"),
  timelineStatus: $("#timeline-status"),
  detailPost: $("#detail-post"),
  detailBody: $("#detail-body"),
  tabs: { comments: $("#tab-comments"), quotes: $("#tab-quotes"), likes: $("#tab-likes") },
  panels: { comments: $("#comments-panel"), quotes: $("#quotes-panel"), likes: $("#likes-panel") },
  detailCommentCount: $("#detail-comment-count"),
  detailQuoteCount: $("#detail-quote-count"),
  detailLikeCount: $("#detail-like-count"),
  commentList: $("#comment-list"),
  commentsEmpty: $("#comments-empty"),
  moreCommentsWrap: $("#more-comments-wrap"),
  moreComments: $("#more-comments"),
  commentForm: $("#comment-form"),
  commentBody: $("#comment-body"),
  commentSubmit: $("#comment-submit"),
  commentCounter: $("#comment-counter"),
  quoteList: $("#quote-list"),
  quotesStatus: $("#quotes-status"),
  likerList: $("#liker-list"),
  likesStatus: $("#likes-status"),
  composeButton: $("#compose-button"),
  composeDialog: $("#compose-dialog"),
  composeForm: $("#compose-form"),
  composeTitle: $("#compose-title"),
  composeClose: $("#compose-close"),
  composeSubmit: $("#compose-submit"),
  composeError: $("#compose-error"),
  composeAuthor: $("#compose-author"),
  composeBody: $("#compose-body"),
  composeImages: $("#compose-images"),
  composeFile: $("#compose-file"),
  composePhotoButton: $("#compose-photo-button"),
  composePhotoHint: $("#compose-photo-hint"),
  composeCounter: $("#compose-counter"),
  composeQuote: $("#compose-quote"),
  lightbox: $("#lightbox"),
  lightboxImage: $("#lightbox-image"),
};

// ---- 状態 ----

const timeline = {
  loaded: false,
  loading: false,
  error: null,
  hasMore: false,
  // 新着確認に使う「サーバーから受け取った一番新しいid」。
  // 自分の投稿で進めてしまうと、その直前に他の人がした投稿を取りこぼすので、新着確認でだけ進める。
  newestId: 0,
  oldestId: null,
  shownIds: new Set(),
  pending: [], // 届いたがまだ表示していない新着
  needsReload: false, // 新着が多すぎて取り切れなかったので、先頭から読み直す必要がある
  scrollY: 0,
};

const detail = {
  id: null,
  post: null,
  token: 0, // 別の投稿を開いたら、前の投稿へのリクエスト結果を捨てるための番号
  tab: "comments",
  commentIds: new Set(),
  lastCommentId: 0,
  hasMoreComments: false,
  quotes: null,
  likersLoaded: false,
};

const compose = {
  quote: null,
  images: [], // { blob, width, height, url }
  processing: 0, // 縮小中の写真の枚数
  sending: false,
};

const likesSending = new Set();
let currentView = null;
let lastPollAt = 0;
let noticesCheckedAt = 0;
let commentSending = false;

// ---- ログイン ----

async function boot() {
  // ログイン導入前に使っていた保存データは不要になったので消す
  try {
    localStorage.removeItem("yunogasns:name");
    localStorage.removeItem("yunogasns:likes");
  } catch {
    // 保存領域が使えない環境では何もしない
  }
  try {
    const { user, unreadNotices } = await api("/api/me");
    noticesCheckedAt = Date.now();
    setUnreadNotices(unreadNotices);
    startSession(user);
  } catch (error) {
    if (error.status !== 401) toast(error.message);
    showLogin();
  }
}

function startSession(user) {
  session.me = user;
  renderAccountButton();
  route();
  // 通知を許可済みの端末なら、このアカウントの通知の受け取り先として登録しておく
  registerServiceWorker();
  syncPushSubscription();
}

/** 未読のお知らせを確認し直す（ベルの数字とタイムラインの案内を更新する） */
async function refreshNotices() {
  noticesCheckedAt = Date.now();
  try {
    const { unreadNotices } = await api("/api/me");
    setUnreadNotices(unreadNotices);
  } catch {
    // 確認に失敗しても、次の機会にまた確認する
  }
}

function showLogin(message = "") {
  session.me = null;
  resetContent();
  setView("login");
  ui.loginError.textContent = message;
  ui.loginError.hidden = !message;
  ui.loginId.focus();
}

async function submitLogin(event) {
  event.preventDefault();
  const id = ui.loginId.value.trim();
  const password = ui.loginPassword.value.trim();
  if (!id || !password) {
    ui.loginError.textContent = "IDとパスワードを入力してください。";
    ui.loginError.hidden = false;
    return;
  }
  ui.loginSubmit.disabled = true;
  try {
    const { user } = await api("/api/login", { method: "POST", body: { id, password } });
    ui.loginPassword.value = "";
    ui.loginError.hidden = true;
    startSession(user);
    refreshNotices();
  } catch (error) {
    ui.loginError.textContent = error.message;
    ui.loginError.hidden = false;
  } finally {
    ui.loginSubmit.disabled = false;
  }
}

async function logout() {
  if (!confirm("ログアウトしますか？")) return;
  try {
    await forgetPushSubscription();
    await api("/api/logout", { method: "POST" });
  } catch {
    // 通信に失敗しても、この端末ではログアウトした状態にする
  }
  history.replaceState(null, "", "/");
  showLogin();
}

function renderAccountButton() {
  ui.accountButton.href = `/u/${session.me.id}`;
  ui.accountButton.replaceChildren(avatar(session.me, "header"));
}

/** 表示中の内容を捨てる（ログアウトしたときや、別の人がログインしたとき） */
function resetContent() {
  posts.clear();
  resetTimeline();
  setUnreadNotices(null);
  detail.token++;
  Object.assign(detail, { id: null, post: null });
  if (ui.composeDialog.open) ui.composeDialog.close();
  clearComposeImages();
  ui.composeBody.value = "";
}

function resetTimeline() {
  Object.assign(timeline, {
    loaded: false,
    error: null,
    hasMore: false,
    newestId: 0,
    oldestId: null,
    pending: [],
    needsReload: false,
    scrollY: 0,
  });
  timeline.shownIds.clear();
  ui.postList.replaceChildren();
  ui.timelineStatus.replaceChildren();
  updateNewPostsPill();
}

// ---- テーマ ----

function storedTheme() {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  ui.themeButton.setAttribute("aria-label", dark ? "ライトモードにする" : "ダークモードにする");
  ui.themeButton.replaceChildren(icon(dark ? "sun" : "moon"));
  // ブラウザのアドレスバーなどの色も背景色に合わせる
  ui.themeColor.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // 保存できなくても、このページを開いているあいだは切り替わる
  }
  applyTheme(next);
}

// ---- 投稿の表示 ----

function renderPost(post, { withQuote = true } = {}) {
  return h(
    "article",
    { class: "post", dataset: { id: post.id } },
    profileLink(post.author, "avatar-link", avatar(post.author)),
    h(
      "div",
      { class: "post-main" },
      h(
        "div",
        { class: "post-head" },
        profileLink(post.author, "profile-link", ...authorLabel(post.author)),
        h("a", { class: "post-time", href: `/p/${post.id}`, dataset: { link: "" } }, timeEl(post.createdAt)),
        canDelete(post) ? deleteButton() : null,
      ),
      post.body ? foldedBody(post.body) : null,
      post.images.length > 0 ? imageGrid(post.images) : null,
      withQuote && post.quoteId !== null ? renderQuoteCard(post.quote) : null,
      h(
        "div",
        { class: "post-actions" },
        h(
          "button",
          { type: "button", class: "action", dataset: { action: "comment" } },
          icon("comment"),
          h("span", { class: "visually-hidden" }, "コメント"),
          h("span", { class: "comment-count" }, countLabel(post.commentCount)),
        ),
        h(
          "button",
          { type: "button", class: "action", dataset: { action: "quote" } },
          icon("quote"),
          h("span", { class: "visually-hidden" }, "引用"),
          h("span", { class: "quote-count" }, countLabel(post.quoteCount)),
        ),
        likeButton(post),
      ),
    ),
  );
}

// 長い本文だけ6行（style.css の .post-body.is-folded）で折りたたむ。
// 100文字未満かつ6行以下の短い本文は、折りたたまずにそのまま全文を出す。
const FOLD_MIN_LENGTH = 100;
const FOLD_MIN_LINES = 6;

// 折りたたんだ本文が実際にはみ出しているときだけ「続きを読む」を出す。
// 表示されたときや、画面の幅が変わって行数が変わったときにも判定し直す。
const foldObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const more = target.nextElementSibling;
    if (more?.classList.contains("read-more")) more.hidden = target.scrollHeight <= target.clientHeight + 1;
  }
});

/** タイムラインの本文。長いものは折りたたみ、「続きを読む」でその場で全文を出す */
function foldedBody(text) {
  const body = h("div", { class: "post-body" }, linkify(text));
  if ([...text].length < FOLD_MIN_LENGTH && text.split("\n").length <= FOLD_MIN_LINES) return body;
  body.classList.add("is-folded");
  foldObserver.observe(body);
  return [body, h("button", { type: "button", class: "read-more", dataset: { action: "read-more" }, hidden: true }, "続きを読む")];
}

function unfoldBody(button) {
  const body = button.previousElementSibling;
  if (body) {
    body.classList.remove("is-folded");
    foldObserver.unobserve(body);
  }
  button.remove();
}

function deleteButton() {
  return h(
    "button",
    { type: "button", class: "icon-button icon-button--small delete-button", dataset: { action: "delete-post" }, "aria-label": "この投稿を削除" },
    icon("trash"),
  );
}

function likeButton(post, { withLabel = false } = {}) {
  return h(
    "button",
    {
      type: "button",
      class: post.liked ? "action action--like is-liked" : "action action--like",
      dataset: { action: "like" },
      "aria-pressed": String(post.liked),
    },
    icon("heart"),
    withLabel ? "いいね" : h("span", { class: "visually-hidden" }, "いいね"),
    h("span", { class: "like-count" }, countLabel(post.likeCount)),
  );
}

/** 投稿に埋め込む引用元。quote が null なら引用元は削除済み */
function renderQuoteCard(quote, { link = true } = {}) {
  if (!quote) return h("div", { class: "quote-card quote-card--deleted" }, "この投稿は削除されました");
  const thumbnail = quote.images[0];
  return h(
    "div",
    {
      class: "quote-card",
      dataset: link ? { id: quote.id } : null,
      role: link ? "link" : null,
      tabindex: link ? 0 : null,
      "aria-label": link ? `引用元: ${quote.author.name}さんの投稿を開く` : null,
    },
    h(
      "div",
      { class: "quote-main" },
      h(
        "div",
        { class: "post-head" },
        avatar(quote.author, "small"),
        ...authorLabel(quote.author),
        h("span", { class: "post-time" }, timeEl(quote.createdAt)),
      ),
      quote.body ? h("div", { class: "quote-body" }, quote.body) : h("div", { class: "quote-body hint" }, "写真"),
    ),
    thumbnail ? h("img", { class: "quote-thumb", src: thumbnail.url, alt: "", loading: "lazy", decoding: "async" }) : null,
  );
}

function renderDetailPost(post) {
  return h(
    "article",
    { class: "post post--detail", dataset: { id: post.id } },
    h(
      "div",
      { class: "detail-head" },
      profileLink(post.author, "avatar-link", avatar(post.author)),
      profileLink(post.author, "detail-author", ...authorLabel(post.author)),
      canDelete(post) ? deleteButton() : null,
    ),
    post.body ? h("div", { class: "post-body" }, linkify(post.body)) : null,
    post.images.length > 0 ? imageGrid(post.images) : null,
    post.quoteId !== null ? renderQuoteCard(post.quote) : null,
    h(
      "div",
      { class: "detail-meta" },
      h("time", { datetime: new Date(post.createdAt).toISOString() }, dateTimeFormat.format(post.createdAt)),
      " · ",
      h("span", { dataset: { expiresFrom: post.createdAt } }, timeLeft(post.createdAt)),
    ),
    h(
      "div",
      { class: "post-actions" },
      h("button", { type: "button", class: "action", dataset: { action: "comment" } }, icon("comment"), "コメント"),
      h("button", { type: "button", class: "action", dataset: { action: "quote" } }, icon("quote"), "引用する"),
      likeButton(post, { withLabel: true }),
    ),
  );
}

function renderComment(comment) {
  return h(
    "li",
    { class: "comment", dataset: { id: comment.id } },
    profileLink(comment.author, "avatar-link", avatar(comment.author)),
    h(
      "div",
      { class: "comment-main" },
      h(
        "div",
        { class: "post-head" },
        profileLink(comment.author, "profile-link", ...authorLabel(comment.author)),
        h("span", { class: "post-time" }, timeEl(comment.createdAt)),
      ),
      h("div", { class: "post-body" }, linkify(comment.body)),
    ),
  );
}

/** id の順序を保ったまま差し込む（newestFirst: 新しい順に並んだリスト） */
function insertById(list, el, id, newestFirst) {
  const next = [...list.children].find((child) => {
    const childId = Number(child.dataset.id);
    return newestFirst ? childId < id : childId > id;
  });
  list.insertBefore(el, next ?? null);
}

const COUNT_SELECTORS = { commentCount: ".comment-count", quoteCount: ".quote-count", likeCount: ".like-count" };

/** 件数が変わったとき、保存している投稿データと、表示中のカードをそろえる */
function setCounts(id, counts) {
  const post = posts.get(id);
  if (post) Object.assign(post, counts);
  for (const card of document.querySelectorAll(`.post[data-id="${id}"]`)) {
    for (const [key, selector] of Object.entries(COUNT_SELECTORS)) {
      const el = card.querySelector(selector);
      if (el && counts[key] !== undefined) el.textContent = countLabel(counts[key]);
    }
  }
  if (detail.id === id) renderDetailCounts();
}

// ---- タイムライン ----

async function loadTimeline() {
  timeline.loading = true;
  renderTimelineStatus();
  try {
    const data = await api("/api/posts");
    timeline.shownIds.clear();
    ui.postList.replaceChildren(
      ...data.posts.map((post) => {
        timeline.shownIds.add(post.id);
        return renderPost(remember(post));
      }),
    );
    Object.assign(timeline, {
      loaded: true,
      error: null,
      hasMore: data.hasMore,
      newestId: data.posts[0]?.id ?? 0,
      oldestId: data.posts.at(-1)?.id ?? null,
      pending: [],
      needsReload: false,
    });
    lastPollAt = Date.now();
  } catch (error) {
    timeline.error = error.message;
    if (timeline.loaded) toast(error.message);
  } finally {
    timeline.loading = false;
    renderTimelineStatus();
    updateNewPostsPill();
    watchTimelineEnd();
  }
}

async function loadOlderPosts() {
  if (timeline.loading || !timeline.hasMore || timeline.oldestId === null) return;
  timeline.loading = true;
  renderTimelineStatus();
  try {
    const data = await api(`/api/posts?before=${timeline.oldestId}`);
    for (const post of data.posts) addTimelinePost(post);
    if (data.posts.length > 0) timeline.oldestId = data.posts.at(-1).id;
    timeline.hasMore = data.hasMore;
  } catch (error) {
    toast(error.message);
  } finally {
    timeline.loading = false;
    renderTimelineStatus();
    watchTimelineEnd();
  }
}

function addTimelinePost(post, { highlight = false } = {}) {
  remember(post);
  if (timeline.shownIds.has(post.id)) return;
  timeline.shownIds.add(post.id);
  const card = renderPost(post);
  if (highlight) card.classList.add("post--new");
  insertById(ui.postList, card, post.id, true);
  timeline.oldestId ??= post.id;
}

function renderTimelineStatus() {
  const status = ui.timelineStatus;
  if (timeline.loading) {
    status.replaceChildren(spinner());
  } else if (!timeline.loaded) {
    status.replaceChildren(
      h("p", {}, timeline.error ?? ""),
      h("button", { type: "button", class: "button button--ghost", dataset: { action: "reload" } }, "再読み込み"),
    );
  } else if (ui.postList.children.length === 0) {
    status.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", {}, "まだ投稿がありません"),
        "最初の投稿をしてみましょう。",
        h("button", { type: "button", class: "button button--primary", dataset: { action: "compose" } }, "投稿する"),
      ),
    );
  } else if (timeline.hasMore) {
    status.replaceChildren(
      h("button", { type: "button", class: "button button--ghost", dataset: { action: "more-posts" } }, "もっと見る"),
    );
  } else {
    status.replaceChildren(h("p", {}, "これより前の投稿はありません。投稿は7日で自動的に消えます。"));
  }
}

// 一番下までスクロールしたら続きを読み込む
const timelineEndObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadOlderPosts();
  },
  { rootMargin: "600px 0px" },
);

/** 読み込み後も一番下が見えたままなら続けて読み込めるよう、監視をやり直す */
function watchTimelineEnd() {
  timelineEndObserver.unobserve(ui.timelineStatus);
  timelineEndObserver.observe(ui.timelineStatus);
}

async function pollTimeline() {
  if (!timeline.loaded || timeline.loading || timeline.needsReload) return;
  const data = await api(`/api/posts?after=${timeline.newestId}`);
  if (data.hasMore) {
    timeline.needsReload = true;
  } else if (data.posts.length > 0) {
    timeline.newestId = data.posts[0].id;
    const waiting = new Set(timeline.pending.map((post) => post.id));
    const fresh = data.posts.filter((post) => !timeline.shownIds.has(post.id) && !waiting.has(post.id));
    timeline.pending.push(...fresh);
  }
  if (canShowNewPostsNow()) await showNewPosts();
  else updateNewPostsPill();
}

/** 一番上を見ているときは、新着をすぐに差し込んでも読んでいる位置がずれない */
function canShowNewPostsNow() {
  return currentView === "timeline" && window.scrollY < 1 && !ui.composeDialog.open;
}

async function showNewPosts() {
  if (timeline.loading) return;
  if (timeline.needsReload) {
    await loadTimeline();
    return;
  }
  for (const post of timeline.pending) addTimelinePost(post, { highlight: true });
  timeline.pending = [];
  updateNewPostsPill();
  renderTimelineStatus();
}

function updateNewPostsPill() {
  const count = timeline.pending.length;
  ui.newPostsPill.hidden = !timeline.needsReload && count === 0;
  ui.newPostsLabel.textContent = timeline.needsReload ? "新しい投稿があります" : `新しい投稿 ${count}件`;
}

// ---- 投稿の詳細 ----

async function openDetail(id, { focusComment = false } = {}) {
  const token = ++detail.token;
  Object.assign(detail, {
    id,
    post: null,
    commentIds: new Set(),
    lastCommentId: 0,
    hasMoreComments: false,
    quotes: null,
    likersLoaded: false,
  });
  ui.commentList.replaceChildren();
  ui.quoteList.replaceChildren();
  ui.quotesStatus.replaceChildren();
  ui.likerList.replaceChildren();
  ui.likesStatus.replaceChildren();
  ui.detailBody.hidden = true;
  selectTab("comments");
  // タイムラインで見ていた投稿なら、読み込みを待たずに先に表示しておく
  const known = posts.get(id);
  ui.detailPost.replaceChildren(known ? renderDetailPost(known) : "", h("div", { class: "list-status" }, spinner()));
  window.scrollTo(0, 0);

  try {
    const data = await api(`/api/posts/${id}`);
    if (token !== detail.token) return;
    const post = remember(data.post);
    detail.post = post;
    ui.detailPost.replaceChildren(renderDetailPost(post));
    for (const comment of data.comments) addComment(comment);
    detail.lastCommentId = data.comments.at(-1)?.id ?? 0;
    detail.hasMoreComments = data.hasMoreComments;
    ui.detailBody.hidden = false;
    setCounts(post.id, { commentCount: post.commentCount, quoteCount: post.quoteCount, likeCount: post.likeCount });
    renderCommentsState();
    document.title = `${post.author.name}さんの投稿 - ${APP_TITLE}`;
    if (focusComment) focusCommentForm();
  } catch (error) {
    if (token !== detail.token) return;
    ui.detailPost.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", {}, error.status === 404 ? "投稿が見つかりません" : "読み込めませんでした"),
        error.message,
        h("a", { href: "/", class: "button button--ghost", dataset: { link: "" } }, "タイムラインへ"),
      ),
    );
  }
}

function renderDetailCounts() {
  ui.detailCommentCount.textContent = String(detail.post?.commentCount ?? 0);
  ui.detailQuoteCount.textContent = String(detail.post?.quoteCount ?? 0);
  ui.detailLikeCount.textContent = String(detail.post?.likeCount ?? 0);
}

function selectTab(tab) {
  detail.tab = tab;
  for (const [name, button] of Object.entries(ui.tabs)) button.setAttribute("aria-selected", String(name === tab));
  for (const [name, panel] of Object.entries(ui.panels)) panel.hidden = name !== tab;
  if (!detail.post) return;
  if (tab === "quotes" && detail.quotes === null) loadQuotes();
  if (tab === "likes" && !detail.likersLoaded) loadLikers();
}

function focusCommentForm() {
  selectTab("comments");
  ui.commentBody.focus({ preventScroll: true });
  ui.commentForm.scrollIntoView({ block: "center", behavior: "smooth" });
}

function addComment(comment, { highlight = false } = {}) {
  if (detail.commentIds.has(comment.id)) return false;
  detail.commentIds.add(comment.id);
  const el = renderComment(comment);
  if (highlight) el.classList.add("is-new");
  insertById(ui.commentList, el, comment.id, false);
  return true;
}

function renderCommentsState() {
  ui.commentsEmpty.hidden = detail.commentIds.size > 0;
  ui.moreCommentsWrap.hidden = !detail.hasMoreComments;
}

/** コメントの続き（「さらに読み込む」と新着確認で共通） */
async function fetchNewerComments({ highlight }) {
  const { id, token } = detail;
  const data = await api(`/api/posts/${id}/comments?after=${detail.lastCommentId}`);
  if (token !== detail.token) return;
  for (const comment of data.comments) addComment(comment, { highlight });
  if (data.comments.length > 0) detail.lastCommentId = data.comments.at(-1).id;
  detail.hasMoreComments = data.hasMore;
  // 全部読み込めたら、表示しているコメントの数がそのままコメント数になる
  const shown = detail.commentIds.size;
  const count = detail.hasMoreComments ? Math.max(detail.post.commentCount, shown) : shown;
  setCounts(id, { commentCount: count });
  renderCommentsState();
}

async function loadMoreComments() {
  ui.moreComments.disabled = true;
  try {
    await fetchNewerComments({ highlight: false });
  } catch (error) {
    toast(error.message);
  } finally {
    ui.moreComments.disabled = false;
  }
}

async function pollComments() {
  // 読み込んでいないコメントが残っているあいだは「さらに読み込む」で取得する
  if (!detail.post || detail.hasMoreComments) return;
  await fetchNewerComments({ highlight: true });
}

async function loadQuotes() {
  const { id, token } = detail;
  detail.quotes ??= { loading: false, error: null, ids: new Set(), oldestId: null, hasMore: false };
  const quotes = detail.quotes;
  if (quotes.loading) return;
  quotes.loading = true;
  renderQuotesStatus();
  try {
    const query = quotes.oldestId === null ? "" : `?before=${quotes.oldestId}`;
    const data = await api(`/api/posts/${id}/quotes${query}`);
    if (token !== detail.token) return;
    for (const post of data.posts) addQuotePost(post);
    if (data.posts.length > 0) quotes.oldestId = data.posts.at(-1).id;
    quotes.hasMore = data.hasMore;
    quotes.error = null;
  } catch (error) {
    quotes.error = error.message;
  } finally {
    quotes.loading = false;
    if (token === detail.token) renderQuotesStatus();
  }
}

function addQuotePost(post) {
  remember(post);
  const quotes = detail.quotes;
  if (!quotes || quotes.ids.has(post.id)) return;
  quotes.ids.add(post.id);
  insertById(ui.quoteList, renderPost(post, { withQuote: false }), post.id, true);
}

function renderQuotesStatus() {
  const quotes = detail.quotes;
  const status = ui.quotesStatus;
  if (!quotes) {
    status.replaceChildren();
  } else if (quotes.loading) {
    status.replaceChildren(spinner());
  } else if (quotes.error) {
    status.replaceChildren(
      h("p", {}, quotes.error),
      h("button", { type: "button", class: "button button--ghost", dataset: { action: "more-quotes" } }, "再読み込み"),
    );
  } else if (quotes.ids.size === 0) {
    status.replaceChildren(h("p", {}, "まだ引用はありません"));
  } else if (quotes.hasMore) {
    status.replaceChildren(
      h("button", { type: "button", class: "button button--ghost", dataset: { action: "more-quotes" } }, "もっと見る"),
    );
  } else {
    status.replaceChildren();
  }
}

/** この投稿にいいねした人の一覧 */
async function loadLikers() {
  const { id, token } = detail;
  detail.likersLoaded = true;
  ui.likesStatus.replaceChildren(spinner());
  try {
    const { users } = await api(`/api/posts/${id}/likes`);
    if (token !== detail.token) return;
    ui.likerList.replaceChildren(...users.map((user) => userRow(user)));
    ui.likesStatus.replaceChildren(users.length === 0 ? h("p", {}, "まだいいねはありません") : "");
  } catch (error) {
    if (token !== detail.token) return;
    detail.likersLoaded = false;
    ui.likesStatus.replaceChildren(h("p", {}, error.message));
  }
}

// ---- いいね ----

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

async function toggleLike(id) {
  const post = posts.get(id);
  if (!post || likesSending.has(id)) return;
  const liked = !post.liked;
  const before = { liked: post.liked, likeCount: post.likeCount };
  likesSending.add(id);
  // 押した瞬間に表示を切り替え、送信に失敗したら元に戻す
  showLike(id, liked, Math.max(0, post.likeCount + (liked ? 1 : -1)), liked);
  try {
    const result = await api(`/api/posts/${id}/like`, { method: "POST", body: { liked } });
    showLike(id, result.liked, result.likeCount, false);
    // 「いいねした人」の一覧を開いていれば読み直す
    if (detail.id === id) {
      detail.likersLoaded = false;
      if (detail.tab === "likes") loadLikers();
    }
  } catch (error) {
    showLike(id, before.liked, before.likeCount, false);
    toast(error.message);
  } finally {
    likesSending.delete(id);
  }
}

function showLike(id, liked, likeCount, animate) {
  const post = posts.get(id);
  if (post) post.liked = liked;
  setCounts(id, { likeCount });
  for (const button of document.querySelectorAll(`.post[data-id="${id}"] [data-action="like"]`)) {
    button.classList.toggle("is-liked", liked);
    button.setAttribute("aria-pressed", String(liked));
    if (animate && !reducedMotion.matches) {
      button.querySelector(".icon")?.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(1)" }],
        { duration: 300, easing: "ease-out" },
      );
    }
  }
}

// ---- 投稿の削除 ----

async function deletePost(id) {
  if (!confirm("この投稿を削除しますか？\nコメントやいいねも一緒に消え、元に戻せません。")) return;
  try {
    await api(`/api/posts/${id}`, { method: "DELETE" });
    removePost(id);
    toast("削除しました");
    if (currentView === "detail" && detail.id === id) goBack();
  } catch (error) {
    toast(error.message);
  }
}

/** 削除した投稿を、表示中のすべての場所から消す */
function removePost(id) {
  const post = posts.get(id);
  if (post?.quoteId != null) {
    const quoted = posts.get(post.quoteId);
    if (quoted) setCounts(quoted.id, { quoteCount: Math.max(0, quoted.quoteCount - 1) });
  }
  posts.delete(id);
  timeline.shownIds.delete(id);
  timeline.pending = timeline.pending.filter((pending) => pending.id !== id);
  for (const card of document.querySelectorAll(`.post[data-id="${id}"]:not(.post--detail)`)) card.remove();
  // この投稿を引用している投稿には「削除されました」と表示する
  for (const quoting of posts.values()) if (quoting.quoteId === id) quoting.quote = null;
  for (const card of document.querySelectorAll(`.quote-card[data-id="${id}"]`)) card.replaceWith(renderQuoteCard(null));
  renderTimelineStatus();
  refreshProfileStatus();
}

// ---- コメントの投稿 ----

function updateCommentForm() {
  const length = textLength(ui.commentBody.value);
  ui.commentCounter.textContent = length > 0 ? `${length} / ${MAX_BODY_LENGTH}` : "";
  ui.commentCounter.classList.toggle("is-over", length > MAX_BODY_LENGTH);
  ui.commentSubmit.disabled = commentSending || length === 0 || length > MAX_BODY_LENGTH;
}

async function submitComment(event) {
  event.preventDefault();
  if (commentSending || !detail.post) return;
  const body = ui.commentBody.value.trim();
  if (!body || [...body].length > MAX_BODY_LENGTH) return;

  const postId = detail.id;
  commentSending = true;
  updateCommentForm();
  try {
    const { comment } = await api(`/api/posts/${postId}/comments`, { method: "POST", body: { body } });
    ui.commentBody.value = "";
    autoGrow(ui.commentBody);
    // 新着確認がすでに表示していた場合は数えない
    const added = detail.id === postId ? addComment(comment, { highlight: true }) : true;
    if (added) setCounts(postId, { commentCount: (posts.get(postId)?.commentCount ?? 0) + 1 });
    if (detail.id === postId) renderCommentsState();
  } catch (error) {
    toast(error.message);
  } finally {
    commentSending = false;
    updateCommentForm();
  }
}

// ---- 投稿画面 ----

function openCompose({ quote = null } = {}) {
  compose.quote = quote;
  ui.composeTitle.textContent = quote ? "引用して投稿" : "新しい投稿";
  ui.composeBody.placeholder = quote ? "コメントを添えて引用" : "いまどうしてる？";
  ui.composeAuthor.replaceChildren(avatar(session.me, "small"), ...authorLabel(session.me));
  ui.composeQuote.replaceChildren(quote ? renderQuoteCard(quote, { link: false }) : "");
  ui.composeQuote.hidden = !quote;
  ui.composeError.hidden = true;
  renderComposeImages();
  updateComposeForm();
  ui.composeDialog.showModal();
  autoGrow(ui.composeBody);
  ui.composeBody.focus();
}

function closeCompose() {
  if (compose.sending) return;
  const hasDraft = ui.composeBody.value.trim() || compose.images.length > 0;
  if (hasDraft && !confirm("書きかけの内容を破棄しますか？")) return;
  ui.composeBody.value = "";
  clearComposeImages();
  ui.composeDialog.close();
}

function updateComposeForm() {
  const length = textLength(ui.composeBody.value);
  const hasContent = length > 0 || compose.images.length > 0;
  ui.composeCounter.textContent = `${length} / ${MAX_BODY_LENGTH}`;
  ui.composeCounter.classList.toggle("is-over", length > MAX_BODY_LENGTH);
  ui.composeSubmit.disabled = compose.sending || compose.processing > 0 || !hasContent || length > MAX_BODY_LENGTH;
  ui.composeSubmit.textContent = compose.sending ? "送信中…" : "投稿する";
  const full = compose.images.length + compose.processing >= MAX_IMAGES_PER_POST;
  ui.composeFile.disabled = full || compose.sending;
  ui.composePhotoButton.classList.toggle("is-disabled", ui.composeFile.disabled);
  ui.composePhotoHint.textContent =
    compose.processing > 0 ? "写真を準備中…" : `写真 ${compose.images.length} / ${MAX_IMAGES_PER_POST}`;
}

function showComposeError(message) {
  ui.composeError.textContent = message;
  ui.composeError.hidden = false;
}

/** 選んだ写真を縮小して、投稿画面に並べる */
async function addComposeImages(files) {
  const room = MAX_IMAGES_PER_POST - compose.images.length - compose.processing;
  if (files.length > room) showComposeError(`写真は${MAX_IMAGES_PER_POST}枚までです。`);
  const selected = files.slice(0, Math.max(0, room));
  compose.processing += selected.length;
  updateComposeForm();
  for (const file of selected) {
    try {
      const { blob, width, height } = await compressImage(file);
      compose.images.push({ blob, width, height, url: URL.createObjectURL(blob) });
    } catch (error) {
      showComposeError(error.message);
    } finally {
      compose.processing--;
      renderComposeImages();
      updateComposeForm();
    }
  }
}

function renderComposeImages() {
  ui.composeImages.hidden = compose.images.length === 0;
  ui.composeImages.replaceChildren(
    ...compose.images.map((image, index) =>
      h(
        "div",
        { class: "compose-image" },
        h("img", { src: image.url, alt: "" }),
        h(
          "button",
          { type: "button", class: "compose-image-remove", dataset: { index }, "aria-label": "この写真を外す" },
          icon("close"),
        ),
      ),
    ),
  );
}

function removeComposeImage(index) {
  const [image] = compose.images.splice(index, 1);
  if (image) URL.revokeObjectURL(image.url);
  renderComposeImages();
  updateComposeForm();
}

function clearComposeImages() {
  for (const image of compose.images) URL.revokeObjectURL(image.url);
  compose.images = [];
  renderComposeImages();
}

async function submitCompose(event) {
  event.preventDefault();
  if (compose.sending || compose.processing > 0) return;
  const body = ui.composeBody.value.trim();
  if (!body && compose.images.length === 0) return showComposeError("本文を入力するか、写真を追加してください。");
  if ([...body].length > MAX_BODY_LENGTH) return showComposeError(`本文は${MAX_BODY_LENGTH}文字以内にしてください。`);

  const form = new FormData();
  form.append("body", body);
  if (compose.quote) form.append("quoteId", String(compose.quote.id));
  form.append("imageSizes", JSON.stringify(compose.images.map((image) => [image.width, image.height])));
  for (const image of compose.images) form.append("images", image.blob, "photo.jpg");

  compose.sending = true;
  ui.composeError.hidden = true;
  updateComposeForm();
  try {
    const { post } = await api("/api/posts", { method: "POST", form });
    ui.composeBody.value = "";
    clearComposeImages();
    ui.composeDialog.close();
    handleCreatedPost(post);
    toast("投稿しました");
  } catch (error) {
    showComposeError(error.message);
  } finally {
    compose.sending = false;
    updateComposeForm();
  }
}

function handleCreatedPost(post) {
  remember(post);
  if (timeline.loaded) {
    addTimelinePost(post, { highlight: true });
    renderTimelineStatus();
  }
  if (post.quoteId !== null) {
    const quoted = posts.get(post.quoteId);
    if (quoted) setCounts(quoted.id, { quoteCount: quoted.quoteCount + 1 });
    if (detail.id === post.quoteId && detail.quotes) {
      addQuotePost(post);
      renderQuotesStatus();
    }
  }
  if (currentView === "timeline") window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- 写真の拡大表示 ----

function openLightbox(src) {
  ui.lightboxImage.src = src;
  ui.lightbox.showModal();
}

// ---- 画面の切り替え ----

const VIEW_TITLES = { detail: "投稿", profile: "プロフィール", notices: "お知らせ", settings: "アカウント設定", admin: "管理画面" };

function route(options = {}) {
  if (!session.me) {
    showLogin();
    return;
  }
  const path = location.pathname;
  const post = /^\/p\/(\d{1,15})\/?$/.exec(path);
  if (post) {
    setView("detail");
    openDetail(Number(post[1]), options);
  } else if (/^\/u\/[A-Za-z0-9_]{1,20}$/.test(path)) {
    setView("profile");
    showProfile(path.slice(3));
  } else if (path === "/notices") {
    setView("notices");
    showNotices();
  } else if (path === "/settings") {
    setView("settings");
    showSettings();
  } else if (path === "/admin" && session.me.isAdmin) {
    setView("admin");
    showAdmin();
  } else {
    if (path !== "/") history.replaceState(history.state, "", "/");
    showTimeline();
  }
}

function setView(view) {
  if (currentView === "timeline" && view !== "timeline") timeline.scrollY = window.scrollY;
  currentView = view;
  for (const [name, el] of Object.entries(ui.views)) el.hidden = name !== view;
  const title = VIEW_TITLES[view];
  ui.backButton.hidden = !title;
  ui.brand.hidden = Boolean(title);
  ui.viewTitle.hidden = !title;
  ui.viewTitle.textContent = title ?? "";
  ui.composeButton.hidden = view !== "timeline";
  ui.accountButton.hidden = !session.me || view === "login";
  ui.noticeButton.hidden = ui.accountButton.hidden;
  document.title = title ? `${title} - ${APP_TITLE}` : APP_TITLE;
}

function showTimeline() {
  const alreadyShown = currentView === "timeline";
  setView("timeline");
  if (!timeline.loaded) {
    if (!timeline.loading) loadTimeline();
    return;
  }
  if (alreadyShown) {
    // タイトルを押したときは一番上へ（新着があればそこで表示される）
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    window.scrollTo(0, timeline.scrollY);
    if (Date.now() - lastPollAt > POLL_INTERVAL_MS) poll();
  }
}

function goBack() {
  if (history.state?.inApp) {
    history.back();
  } else {
    // 共有されたリンクから直接開いた場合は、戻る先がないのでタイムラインへ
    history.replaceState(null, "", "/");
    route();
  }
}

// ---- 新着の確認 ----

// お知らせはめったに来ないので、新着の確認よりずっと間隔をあけて確認する
const NOTICE_CHECK_INTERVAL_MS = 10 * 60_000;

async function poll() {
  if (document.hidden || !session.me) return;
  lastPollAt = Date.now();
  if (lastPollAt - noticesCheckedAt > NOTICE_CHECK_INTERVAL_MS) refreshNotices();
  try {
    if (currentView === "timeline") await pollTimeline();
    else if (currentView === "detail") await pollComments();
  } catch {
    // 新着の確認に失敗しても、次の確認でまた試す
  }
}

// ---- 操作の受け付け ----

function runAction(action, el) {
  const card = el.closest(".post[data-id]");
  const post = card ? posts.get(Number(card.dataset.id)) : undefined;
  switch (action) {
    case "comment":
      if (card?.classList.contains("post--detail")) focusCommentForm();
      else if (post) navigate(`/p/${post.id}`, { focusComment: true });
      break;
    case "quote":
      if (post) openCompose({ quote: post });
      break;
    case "like":
      if (post) toggleLike(post.id);
      break;
    case "delete-post":
      if (post) deletePost(post.id);
      break;
    case "open-image":
      openLightbox(el.dataset.src);
      break;
    case "read-more":
      unfoldBody(el);
      break;
    case "compose":
      openCompose();
      break;
    case "more-posts":
      loadOlderPosts();
      break;
    case "reload":
      loadTimeline();
      break;
    case "more-quotes":
      loadQuotes();
      break;
  }
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const link = target.closest("a[data-link]");
  if (link) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.getAttribute("href"));
    return;
  }
  if (target.closest("a")) return; // 本文中のリンクはそのまま開く

  const actionEl = target.closest("[data-action]");
  if (actionEl) {
    runAction(actionEl.dataset.action, actionEl);
    return;
  }

  const quoteCard = target.closest(".quote-card[data-id]");
  if (quoteCard) {
    navigate(`/p/${quoteCard.dataset.id}`);
    return;
  }

  // 投稿カードのどこを押しても詳細を開く（文字を選択しているときは除く）
  const card = target.closest(".post[data-id]");
  if (card && !card.classList.contains("post--detail") && !getSelection()?.toString()) {
    navigate(`/p/${card.dataset.id}`);
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (event.key === "Enter" && target instanceof Element && target.matches(".quote-card[data-id]")) {
    navigate(`/p/${target.dataset.id}`);
    return;
  }
  // PCでは n キーで投稿画面を開ける
  if (
    event.key === "n" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isTyping(target) &&
    !ui.composeDialog.open &&
    currentView === "timeline"
  ) {
    event.preventDefault();
    openCompose();
  }
});

ui.loginForm.addEventListener("submit", submitLogin);
ui.loginId.addEventListener("keydown", (event) => {
  // 日本語入力の確定の Enter では移動しない
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    ui.loginPassword.focus();
  }
});
ui.backButton.addEventListener("click", goBack);
ui.themeButton.addEventListener("click", toggleTheme);
ui.composeButton.addEventListener("click", () => openCompose());
ui.newPostsPill.addEventListener("click", async () => {
  await showNewPosts();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
for (const [name, button] of Object.entries(ui.tabs)) button.addEventListener("click", () => selectTab(name));
ui.moreComments.addEventListener("click", loadMoreComments);
ui.commentForm.addEventListener("submit", submitComment);
ui.composeForm.addEventListener("submit", submitCompose);
ui.composeClose.addEventListener("click", closeCompose);
ui.composeFile.addEventListener("change", () => {
  const files = [...(ui.composeFile.files ?? [])];
  // 同じ写真をもう一度選んでも反応するように、選択を空に戻しておく
  ui.composeFile.value = "";
  addComposeImages(files);
});
ui.composeImages.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest(".compose-image-remove") : null;
  if (button) removeComposeImage(Number(button.dataset.index));
});

ui.composeDialog.addEventListener("cancel", (event) => {
  // Esc キーやスマホの「戻る」で閉じるときも、書きかけなら確認する
  event.preventDefault();
  closeCompose();
});

// PCで投稿画面の外側（背景）を押したら閉じる。
// 文字を選択しながら外までドラッグしたときに閉じないよう、押し始めも外側だった場合に限る。
let pressedOnBackdrop = false;
ui.composeDialog.addEventListener("pointerdown", (event) => {
  pressedOnBackdrop = event.target === ui.composeDialog;
});
ui.composeDialog.addEventListener("click", (event) => {
  if (pressedOnBackdrop && event.target === ui.composeDialog) closeCompose();
});

// 拡大表示は、どこを押しても閉じる
ui.lightbox.addEventListener("click", () => ui.lightbox.close());

for (const [textarea, form, update] of [
  [ui.composeBody, ui.composeForm, updateComposeForm],
  [ui.commentBody, ui.commentForm, updateCommentForm],
]) {
  textarea.addEventListener("input", () => {
    autoGrow(textarea);
    update();
    ui.composeError.hidden = true;
  });
  textarea.addEventListener("keydown", (event) => {
    // Ctrl+Enter（Macは⌘+Enter）で送信
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}

window.addEventListener("popstate", () => route());

window.addEventListener(
  "scroll",
  () => {
    if ((timeline.pending.length > 0 || timeline.needsReload) && !timeline.loading && canShowNewPostsNow()) {
      showNewPosts();
    }
  },
  { passive: true },
);

document.addEventListener("visibilitychange", () => {
  // 別のアプリから戻ってきたら、少し時間が空いていればすぐに新着を確認する
  if (!document.hidden && Date.now() - lastPollAt > POLL_INTERVAL_MS / 2) poll();
});

// 自分で切り替えていないあいだは、端末のダークモード設定の変更に合わせる
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
  if (!storedTheme()) applyTheme(event.matches ? "dark" : "light");
});

// ---- 起動 ----

onRoute(route);
setUnauthorizedHandler(() => {
  if (session.me) showLogin("ログインの有効期限が切れたか、アカウントが削除されました。もう一度ログインしてください。");
});
initSettings({
  // アイコンや名前を変えたら、ヘッダーを描き直し、タイムラインは次に開いたときに読み直す
  onUserChange: () => {
    renderAccountButton();
    posts.clear();
    resetTimeline();
  },
  onLogout: logout,
});
// 通知を押してアプリが前に出てきたら、通知の内容の画面へ移る（sw.js から届く）
navigator.serviceWorker?.addEventListener("message", (event) => {
  const path = event.data?.type === "open" ? event.data.path : null;
  if (typeof path === "string" && path.startsWith("/") && session.me) navigate(path);
});
initProfile({ renderPost });
initAdmin({
  onPostsDeleted: () => {
    posts.clear();
    resetTimeline();
  },
});

history.scrollRestoration = "manual";
applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
updateCommentForm();
boot();
setInterval(poll, POLL_INTERVAL_MS);
setInterval(refreshTimes, 60_000);
