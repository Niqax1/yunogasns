// どの画面からも使う、表示まわりの小さな部品。
// 投稿内容は必ずテキストとして DOM に入れ、innerHTML は使わない（スクリプトを埋め込まれないように）。

// src/config.ts と同じ値にしておく
export const MAX_NAME_LENGTH = 20;
export const MAX_BODY_LENGTH = 1000;
export const MAX_IMAGES_PER_POST = 4;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const $ = (selector) => document.querySelector(selector);

const SVG_NS = "http://www.w3.org/2000/svg";

/** 要素を作る。文字列の子要素はテキストとして入るので、投稿内容をそのまま渡しても安全 */
export function h(tag, props = {}, ...children) {
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

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function spinner() {
  return h("div", { class: "spinner", role: "img", "aria-label": "読み込み中" });
}

const segmenter = "Segmenter" in Intl ? new Intl.Segmenter("ja", { granularity: "grapheme" }) : null;

/** アイコン。画像が設定されていればその画像、なければ名前の1文字目を色つきの丸で表示する */
export function avatar(author, size = "") {
  const className = size ? `avatar avatar--${size}` : "avatar";
  if (author.avatarUrl) {
    return h("img", { class: className, src: author.avatarUrl, alt: "", loading: "lazy", decoding: "async" });
  }
  const name = author.name || "?";
  const first = segmenter ? segmenter.segment(name)[Symbol.iterator]().next().value?.segment : Array.from(name)[0];
  const el = h("span", { class: className, "aria-hidden": "true" }, first ?? "?");
  // 同じ人なら同じ色になるよう、ID（ログイン導入前の投稿は名前）から色相を決める
  let hash = 0;
  for (const char of author.id ?? name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  el.style.setProperty("--hue", String(hash % 360));
  return el;
}

/** 表示名と @ID */
export function authorLabel(author) {
  return [
    h("span", { class: "post-name" }, author.name),
    author.id ? h("span", { class: "post-id" }, `@${author.id}`) : null,
  ];
}

/**
 * プロフィールへのリンク（中身は children）。
 * ログイン導入前の投稿はアカウントがないので、リンクにせず同じ見た目の span にする。
 */
export function profileLink(author, className, ...children) {
  if (!author.id) return h("span", { class: className }, ...children);
  return h("a", { class: className, href: `/u/${author.id}`, dataset: { link: "" } }, ...children);
}

/** アカウントの一覧の1行（いいねした人・フォロー・管理画面）。押すとプロフィールを開く */
export function userRow(user, ...extra) {
  return h(
    "li",
    { class: "user-row", dataset: { id: user.id } },
    profileLink(user, "user-row-link", avatar(user), h("div", { class: "user-row-main" }, ...authorLabel(user))),
    ...extra,
  );
}

/** 投稿の写真。押すと拡大表示する（data-action="open-image"） */
export function imageGrid(images) {
  return h(
    "div",
    { class: `image-grid image-grid--${images.length}` },
    images.map((image) =>
      h(
        "button",
        { type: "button", class: "image-cell", dataset: { action: "open-image", src: image.url }, "aria-label": "写真を拡大" },
        h("img", {
          src: image.url,
          alt: "",
          loading: "lazy",
          decoding: "async",
          width: image.width || null,
          height: image.height || null,
        }),
      ),
    ),
  );
}

// 本文中のURLをリンクにする。URLの直後に日本語が続いても切れるよう、半角のURL文字だけを対象にする
const URL_PATTERN = /https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/g;

export function linkify(text) {
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

export const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function timeAgo(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

export function timeLeft(createdAt) {
  const minutes = Math.floor((createdAt + RETENTION_MS - Date.now()) / 60_000);
  if (minutes < 1) return "まもなく消えます";
  if (minutes < 60) return `あと${minutes}分で消えます`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `あと${hours}時間で消えます`;
  const restHours = hours % 24;
  return `あと${Math.floor(hours / 24)}日${restHours ? `${restHours}時間` : ""}で消えます`;
}

export function timeEl(ms) {
  return h(
    "time",
    { datetime: new Date(ms).toISOString(), title: dateTimeFormat.format(ms), dataset: { ts: ms } },
    timeAgo(ms),
  );
}

/** 「〇分前」などの表示を今の時刻に合わせて更新する */
export function refreshTimes() {
  for (const el of document.querySelectorAll("time[data-ts]")) el.textContent = timeAgo(Number(el.dataset.ts));
  for (const el of document.querySelectorAll("[data-expires-from]")) {
    el.textContent = timeLeft(Number(el.dataset.expiresFrom));
  }
}

export const countLabel = (count) => (count > 0 ? String(count) : "");

let toastTimer = 0;

export function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("toast--show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("toast--show"), 3500);
}

export function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function textLength(text) {
  return [...text.trim()].length;
}
