// 引っぱって更新：画面の一番上でさらに下に引っぱって離すと、アプリ全体を読み込み直す。
// ホーム画面に追加したアプリには再読み込みボタンがないので、そのときだけ使う（ブラウザではブラウザの再読み込みを使う）。
// 読み込み直すと、最新の投稿や件数に加えて、新しいバージョンの画面にもなる。

import { h, icon, isStandalone } from "./ui.js";

const THRESHOLD = 72; // ここまで引っぱって離すと読み込み直す（丸が動く距離、px）
const MAX_DISTANCE = 120;
const RESISTANCE = 0.5; // 指が動いた距離に対して、丸が動く割合（重さを感じるように）
const DIRECTION_SLOP = 8; // 引っぱりかどうかを判定するまでに、指が動く距離（px）

export function initPullToRefresh() {
  if (!isStandalone()) return;
  // 一番上で引っぱったときに画面全体が伸び縮みしないようにする（style.css）
  document.documentElement.dataset.standalone = "";

  const indicator = h("div", { class: "pull-indicator", "aria-hidden": "true" }, icon("refresh"));
  document.body.append(indicator);

  let start = null; // 引っぱり始めた位置。引っぱれない状況で触り始めたときは null
  let distance = 0;
  let refreshing = false;

  const show = (value, { animate = false } = {}) => {
    distance = value;
    indicator.classList.toggle("is-animating", animate);
    indicator.classList.toggle("is-ready", value >= THRESHOLD);
    indicator.style.opacity = String(Math.min(1, value / THRESHOLD));
    indicator.style.transform = `translateY(${value - 48}px)`;
    indicator.firstElementChild.style.transform = `rotate(${(value / THRESHOLD) * 270}deg)`;
  };
  const cancel = () => {
    start = null;
    if (distance > 0) show(0, { animate: true });
  };

  document.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target;
      const blocked =
        refreshing ||
        event.touches.length !== 1 ||
        window.scrollY > 0 ||
        document.querySelector("dialog[open]") ||
        // 入力欄の中のスクロールや、文字の選択を邪魔しない
        (target instanceof Element && target.closest("textarea, input, select, [contenteditable]"));
      // 引っぱっている途中で2本目の指が触れたときなども、ここで引っぱりをやめて丸をしまう
      if (blocked) cancel();
      else start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (!start) return;
      if (window.scrollY > 0) {
        cancel();
        return;
      }
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      if (distance === 0) {
        // 指が少し動いてから向きを判定する。上向き・横向きなら、この操作では引っぱらない
        if (Math.abs(dx) < DIRECTION_SLOP && Math.abs(dy) < DIRECTION_SLOP) return;
        if (dy <= 0 || Math.abs(dx) > dy) {
          cancel();
          return;
        }
      }
      show(Math.max(0, Math.min(MAX_DISTANCE, dy * RESISTANCE)));
    },
    { passive: true },
  );

  document.addEventListener("touchend", () => {
    if (!start) return;
    if (distance >= THRESHOLD && confirmDiscardDrafts()) {
      start = null;
      refreshing = true;
      show(THRESHOLD, { animate: true });
      indicator.replaceChildren(h("span", { class: "spinner" }));
      location.reload();
    } else {
      cancel();
    }
  });
  document.addEventListener("touchcancel", cancel);
}

/** 書きかけのコメントなどがあれば、消えてもよいか確認する */
function confirmDiscardDrafts() {
  const hasDraft = [...document.querySelectorAll("textarea")].some((textarea) => textarea.value.trim() !== "");
  return !hasDraft || confirm("書きかけの内容は消えます。読み込み直しますか？");
}
