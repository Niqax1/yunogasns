// yunogasns の画面側の処理。ビルドなしでそのまま動く素のJavaScript（ESモジュール）で書いている。
// 投稿内容は必ずテキストとしてDOMに入れ、innerHTML は使わない（スクリプトを埋め込まれないように）。

// ---- 設定 ----

// src/index.ts と同じ値にしておく
const MAX_NAME_LENGTH = 20;
const MAX_BODY_LENGTH = 280;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 新着を確認する間隔。画面を開いている人1人につき、1時間で120リクエストを使う
// （Workers の無料枠は1日10万リクエスト。README の「どれくらい使えるか」を参照）
const POLL_INTERVAL_MS = 30_000;

const NAME_KEY = "yunogasns:name";
const THEME_KEY = "yunogasns:theme";
const LIKES_KEY = "yunogasns:likes";
const APP_TITLE = document.title;

// ---- 画面の要素 ----

const $ = (selector) => document.querySelector(selector);

const ui = {
  themeColor: $('meta[name="theme-color"]'),
  backButton: $("#back-button"),
  brand: $("#brand"),
  viewTitle: $("#view-title"),
  themeButton: $("#theme-button"),
  timelineView: $("#timeline-view"),
  newPostsPill: $("#new-posts-pill"),
  newPostsLabel: $("#new-posts-label"),
  postList: $("#post-list"),
  timelineStatus: $("#timeline-status"),
  detailView: $("#detail-view"),
  detailPost: $("#detail-post"),
  detailBody: $("#detail-body"),
  tabComments: $("#tab-comments"),
  tabQuotes: $("#tab-quotes"),
  detailCommentCount: $("#detail-comment-count"),
  detailQuoteCount: $("#detail-quote-count"),
  commentsPanel: $("#comments-panel"),
  commentList: $("#comment-list"),
  commentsEmpty: $("#comments-empty"),
  moreCommentsWrap: $("#more-comments-wrap"),
  moreComments: $("#more-comments"),
  commentForm: $("#comment-form"),
  commentName: $("#comment-name"),
  commentBody: $("#comment-body"),
  commentSubmit: $("#comment-submit"),
  commentCounter: $("#comment-counter"),
  quotesPanel: $("#quotes-panel"),
  quoteList: $("#quote-list"),
  quotesStatus: $("#quotes-status"),
  composeButton: $("#compose-button"),
  composeDialog: $("#compose-dialog"),
  composeForm: $("#compose-form"),
  composeTitle: $("#compose-title"),
  composeClose: $("#compose-close"),
  composeSubmit: $("#compose-submit"),
  composeError: $("#compose-error"),
  composeName: $("#compose-name"),
  composeBody: $("#compose-body"),
  composeCounter: $("#compose-counter"),
  composeQuote: $("#compose-quote"),
  toast: $("#toast"),
};

// ---- 状態 ----

/** 取得済みの投稿（id → 投稿）。引用ボタンなどから投稿の中身を引くのに使う */
const posts = new Map();

/** このブラウザでいいねした投稿の id。ログインがないので、二重に押せないようにブラウザに保存する */
const likedIds = loadLikedIds();
const likesSending = new Set();

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
  commentIds: new Set(),
  lastCommentId: 0,
  hasMoreComments: false,
  quotes: null,
};

let currentView = null;
let lastPollAt = 0;
let composeQuote = null;
let composeSending = false;
let commentSending = false;

// ---- サーバーとの通信 ----

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "通信できませんでした。電波の状態を確認してください。");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // Workers の1日のリクエスト上限を超えたときは、JSONではない 429 が返る
    const fallback =
      response.status === 429
        ? "アクセスが集中しているか、今日の無料枠の上限に達しています。しばらくしてからお試しください。"
        : `エラーが発生しました（${response.status}）。`;
    throw new ApiError(response.status, data?.error ?? fallback);
  }
  return data;
}

function remember(post) {
  const known = posts.get(post.id);
  if (known) return Object.assign(known, post);
  posts.set(post.id, post);
  return post;
}

// ---- 名前とテーマ（ブラウザの localStorage に保存する） ----

function loadName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // 保存できない環境（プライベートモードなど）でも投稿はできる
  }
}

function loadLikedIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(LIKES_KEY) ?? "[]");
    // id は作成時刻なので、7日を過ぎて消えた投稿のものはここで捨てる
    const cutoff = Date.now() - RETENTION_MS;
    return new Set(Array.isArray(ids) ? ids.filter((id) => Number.isSafeInteger(id) && id >= cutoff) : []);
  } catch {
    return new Set();
  }
}

function saveLikedIds() {
  try {
    localStorage.setItem(LIKES_KEY, JSON.stringify([...likedIds]));
  } catch {
    // 保存できなくても、このページを開いているあいだは覚えている
  }
}

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

// ---- 表示用の部品 ----

const SVG_NS = "http://www.w3.org/2000/svg";

/** 要素を作る。文字列の子要素はテキストとして入るので、投稿内容をそのまま渡しても安全 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return el;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function spinner() {
  return h("div", { class: "spinner", role: "img", "aria-label": "読み込み中" });
}

const segmenter = "Segmenter" in Intl ? new Intl.Segmenter("ja", { granularity: "grapheme" }) : null;

/** 名前の1文字目を、名前ごとに決まった色の丸に入れたアイコン */
function avatar(name, small = false) {
  const first = segmenter ? segmenter.segment(name)[Symbol.iterator]().next().value?.segment : Array.from(name)[0];
  const el = h("span", { class: small ? "avatar avatar--small" : "avatar", "aria-hidden": "true" }, first ?? "?");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  el.style.setProperty("--hue", String(hash % 360));
  return el;
}

// 本文中のURLをリンクにする。URLの直後に日本語が続いても切れるよう、半角のURL文字だけを対象にする
const URL_PATTERN = /https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/g;

function linkify(text) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!isValidUrl(url)) continue;
    fragment.append(text.slice(last, match.index));
    fragment.append(h("a", { href: url, target: "_blank", rel: "noopener noreferrer nofollow" }, url));
    last = match.index + url.length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

// URL.canParse は古いiPhone（iOS 16 以前）にないので使わない
function isValidUrl(text) {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

// 文末の句読点や、対応の取れていない閉じかっこはURLに含めない
function trimUrl(url) {
  const count = (text, char) => text.split(char).length - 1;
  let result = url;
  for (;;) {
    const last = result.at(-1);
    if (".,!?;:'\"".includes(last)) result = result.slice(0, -1);
    else if (last === ")" && count(result, "(") < count(result, ")")) result = result.slice(0, -1);
    else return result;
  }
}

const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function timeAgo(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

function timeLeft(createdAt) {
  const minutes = Math.floor((createdAt + RETENTION_MS - Date.now()) / 60_000);
  if (minutes < 1) return "まもなく消えます";
  if (minutes < 60) return `あと${minutes}分で消えます`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `あと${hours}時間で消えます`;
  const restHours = hours % 24;
  return `あと${Math.floor(hours / 24)}日${restHours ? `${restHours}時間` : ""}で消えます`;
}

function timeEl(ms) {
  return h(
    "time",
    { datetime: new Date(ms).toISOString(), title: dateTimeFormat.format(ms), dataset: { ts: ms } },
    timeAgo(ms),
  );
}

/** 「〇分前」などの表示を今の時刻に合わせて更新する */
function refreshTimes() {
  for (const el of document.querySelectorAll("time[data-ts]")) el.textContent = timeAgo(Number(el.dataset.ts));
  for (const el of document.querySelectorAll("[data-expires-from]")) {
    el.textContent = timeLeft(Number(el.dataset.expiresFrom));
  }
}

const countLabel = (count) => (count > 0 ? String(count) : "");

function renderPost(post, { withQuote = true } = {}) {
  return h(
    "article",
    { class: "post", dataset: { id: post.id } },
    avatar(post.name),
    h(
      "div",
      { class: "post-main" },
      h(
        "div",
        { class: "post-head" },
        h("span", { class: "post-name" }, post.name),
        h("a", { class: "post-time", href: `/p/${post.id}`, dataset: { link: "" } }, timeEl(post.createdAt)),
      ),
      h("div", { class: "post-body" }, linkify(post.body)),
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

function likeButton(post, { withLabel = false } = {}) {
  const liked = likedIds.has(post.id);
  return h(
    "button",
    {
      type: "button",
      class: liked ? "action action--like is-liked" : "action action--like",
      dataset: { action: "like" },
      "aria-pressed": String(liked),
    },
    icon("heart"),
    withLabel ? "いいね" : h("span", { class: "visually-hidden" }, "いいね"),
    h("span", { class: "like-count" }, countLabel(post.likeCount)),
  );
}

/** 投稿に埋め込む引用元。quote が null なら引用元は削除済み */
function renderQuoteCard(quote, { link = true } = {}) {
  if (!quote) return h("div", { class: "quote-card quote-card--deleted" }, "この投稿は削除されました");
  return h(
    "div",
    {
      class: "quote-card",
      dataset: link ? { id: quote.id } : null,
      role: link ? "link" : null,
      tabindex: link ? 0 : null,
      "aria-label": link ? `引用元: ${quote.name}さんの投稿を開く` : null,
    },
    h(
      "div",
      { class: "post-head" },
      avatar(quote.name, true),
      h("span", { class: "post-name" }, quote.name),
      h("span", { class: "post-time" }, timeEl(quote.createdAt)),
    ),
    h("div", { class: "quote-body" }, quote.body),
  );
}

function renderDetailPost(post) {
  return h(
    "article",
    { class: "post post--detail", dataset: { id: post.id } },
    h("div", { class: "detail-head" }, avatar(post.name), h("span", { class: "post-name" }, post.name)),
    h("div", { class: "post-body" }, linkify(post.body)),
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
      h("button", { type: "button", class: "action", dataset: { action: "comment" } }, icon("comment"), "コメントする"),
      h("button", { type: "button", class: "action", dataset: { action: "quote" } }, icon("quote"), "引用する"),
      likeButton(post, { withLabel: true }),
    ),
  );
}

function renderComment(comment) {
  return h(
    "li",
    { class: "comment", dataset: { id: comment.id } },
    avatar(comment.name),
    h(
      "div",
      { class: "comment-main" },
      h(
        "div",
        { class: "post-head" },
        h("span", { class: "post-name" }, comment.name),
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

let toastTimer = 0;

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("toast--show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("toast--show"), 3500);
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function updateCounter(textarea, counter, alwaysShow) {
  const length = [...textarea.value.trim()].length;
  counter.textContent = length > 0 || alwaysShow ? `${length} / ${MAX_BODY_LENGTH}` : "";
  counter.classList.toggle("is-over", length > MAX_BODY_LENGTH);
  return length;
}

function validate(name, body) {
  if (!name) return { field: "name", message: "名前を入力してください。" };
  if ([...name].length > MAX_NAME_LENGTH) return { field: "name", message: `名前は${MAX_NAME_LENGTH}文字以内にしてください。` };
  if (!body) return { field: "body", message: "本文を入力してください。" };
  if ([...body].length > MAX_BODY_LENGTH) return { field: "body", message: `本文は${MAX_BODY_LENGTH}文字以内にしてください。` };
  return null;
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
  Object.assign(detail, { id, post: null, commentIds: new Set(), lastCommentId: 0, hasMoreComments: false, quotes: null });
  ui.commentList.replaceChildren();
  ui.quoteList.replaceChildren();
  ui.quotesStatus.replaceChildren();
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
    setCounts(post.id, { commentCount: post.commentCount, quoteCount: post.quoteCount });
    renderCommentsState();
    document.title = `${post.name}さんの投稿 - ${APP_TITLE}`;
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
}

function selectTab(tab) {
  ui.tabComments.setAttribute("aria-selected", String(tab === "comments"));
  ui.tabQuotes.setAttribute("aria-selected", String(tab === "quotes"));
  ui.commentsPanel.hidden = tab !== "comments";
  ui.quotesPanel.hidden = tab !== "quotes";
  if (tab === "quotes" && detail.quotes === null && detail.post) loadQuotes();
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

// ---- いいね ----

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

async function toggleLike(id) {
  const post = posts.get(id);
  if (!post || likesSending.has(id)) return;
  const liked = !likedIds.has(id);
  const before = post.likeCount;
  likesSending.add(id);
  // 押した瞬間に表示を切り替え、送信に失敗したら元に戻す
  showLike(id, liked, Math.max(0, before + (liked ? 1 : -1)), liked);
  try {
    const { likeCount } = await api(`/api/posts/${id}/like`, { method: "POST", body: { liked } });
    showLike(id, liked, likeCount, false);
  } catch (error) {
    showLike(id, !liked, before, false);
    toast(error.message);
  } finally {
    likesSending.delete(id);
  }
}

function showLike(id, liked, likeCount, animate) {
  if (liked) likedIds.add(id);
  else likedIds.delete(id);
  saveLikedIds();
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

// ---- コメントの投稿 ----

function updateCommentForm() {
  const length = updateCounter(ui.commentBody, ui.commentCounter, false);
  ui.commentSubmit.disabled = commentSending || length === 0 || length > MAX_BODY_LENGTH;
}

async function submitComment(event) {
  event.preventDefault();
  if (commentSending || !detail.post) return;
  const name = ui.commentName.value.trim();
  const body = ui.commentBody.value.trim();
  const problem = validate(name, body);
  if (problem) {
    toast(problem.message);
    (problem.field === "name" ? ui.commentName : ui.commentBody).focus();
    return;
  }

  const postId = detail.id;
  commentSending = true;
  updateCommentForm();
  try {
    const { comment } = await api(`/api/posts/${postId}/comments`, { method: "POST", body: { name, body } });
    saveName(name);
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
  composeQuote = quote;
  ui.composeTitle.textContent = quote ? "引用して投稿" : "新しい投稿";
  ui.composeBody.placeholder = quote ? "コメントを添えて引用" : "いまどうしてる？";
  ui.composeQuote.replaceChildren(quote ? renderQuoteCard(quote, { link: false }) : "");
  ui.composeQuote.hidden = !quote;
  ui.composeName.value = loadName();
  ui.composeError.hidden = true;
  updateComposeForm();
  ui.composeDialog.showModal();
  autoGrow(ui.composeBody);
  // 名前が保存済みなら、すぐ本文を書き始められるようにする
  (ui.composeName.value ? ui.composeBody : ui.composeName).focus();
}

function closeCompose() {
  if (composeSending) return;
  if (ui.composeBody.value.trim() && !confirm("書きかけの内容を破棄しますか？")) return;
  ui.composeBody.value = "";
  ui.composeDialog.close();
}

function updateComposeForm() {
  const length = updateCounter(ui.composeBody, ui.composeCounter, true);
  ui.composeSubmit.disabled = composeSending || length === 0 || length > MAX_BODY_LENGTH;
  ui.composeSubmit.textContent = composeSending ? "送信中…" : "投稿する";
}

function showComposeError(message) {
  ui.composeError.textContent = message;
  ui.composeError.hidden = false;
}

async function submitCompose(event) {
  event.preventDefault();
  if (composeSending) return;
  const name = ui.composeName.value.trim();
  const body = ui.composeBody.value.trim();
  const problem = validate(name, body);
  if (problem) {
    showComposeError(problem.message);
    (problem.field === "name" ? ui.composeName : ui.composeBody).focus();
    return;
  }

  composeSending = true;
  updateComposeForm();
  try {
    const { post } = await api("/api/posts", { method: "POST", body: { name, body, quoteId: composeQuote?.id ?? null } });
    saveName(name);
    ui.composeBody.value = "";
    ui.composeDialog.close();
    handleCreatedPost(post);
    toast("投稿しました");
  } catch (error) {
    showComposeError(error.message);
  } finally {
    composeSending = false;
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

// ---- 画面の切り替え ----

function navigate(path, options = {}) {
  if (path !== location.pathname) history.pushState({ inApp: true }, "", path);
  route(options);
}

function route(options = {}) {
  const match = /^\/p\/(\d{1,15})\/?$/.exec(location.pathname);
  if (match) {
    setView("detail");
    openDetail(Number(match[1]), options);
    return;
  }
  if (location.pathname !== "/") history.replaceState(history.state, "", "/");
  showTimeline();
}

function setView(view) {
  if (currentView === "timeline" && view !== "timeline") timeline.scrollY = window.scrollY;
  currentView = view;
  const isDetail = view === "detail";
  ui.timelineView.hidden = isDetail;
  ui.detailView.hidden = !isDetail;
  ui.backButton.hidden = !isDetail;
  ui.brand.hidden = isDetail;
  ui.viewTitle.hidden = !isDetail;
  ui.composeButton.hidden = isDetail;
  if (!isDetail) document.title = APP_TITLE;
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

async function poll() {
  if (document.hidden) return;
  lastPollAt = Date.now();
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

ui.backButton.addEventListener("click", goBack);
ui.themeButton.addEventListener("click", toggleTheme);
ui.composeButton.addEventListener("click", () => openCompose());
ui.newPostsPill.addEventListener("click", async () => {
  await showNewPosts();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
ui.tabComments.addEventListener("click", () => selectTab("comments"));
ui.tabQuotes.addEventListener("click", () => selectTab("quotes"));
ui.moreComments.addEventListener("click", loadMoreComments);
ui.commentForm.addEventListener("submit", submitComment);
ui.composeForm.addEventListener("submit", submitCompose);
ui.composeClose.addEventListener("click", closeCompose);

ui.composeDialog.addEventListener("cancel", (event) => {
  // Escキーやスマホの「戻る」で閉じるときも、書きかけなら確認する
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

// 名前は入力するたびに保存し、投稿画面とコメント欄で共有する
for (const [input, other, next] of [
  [ui.composeName, ui.commentName, ui.composeBody],
  [ui.commentName, ui.composeName, ui.commentBody],
]) {
  input.addEventListener("input", () => {
    other.value = input.value;
    saveName(input.value.trim());
    ui.composeError.hidden = true;
  });
  input.addEventListener("keydown", (event) => {
    // 日本語入力の確定のEnterでは移動しない
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      next.focus();
    }
  });
}

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

history.scrollRestoration = "manual";
applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
ui.commentName.value = loadName();
updateCommentForm();
route();
setInterval(poll, POLL_INTERVAL_MS);
setInterval(refreshTimes, 60_000);
