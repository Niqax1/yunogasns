// お知らせ：ヘッダーのベル（未読の数）、タイムラインの上の案内、お知らせの一覧

import { api } from "./api.js";
import { $, dateTimeFormat, h, linkify, spinner } from "./ui.js";

const unread = { count: 0, latest: null };

/** 未読のお知らせ（/api/me の unreadNotices）を受け取って、ベルの数字とタイムラインの案内を更新する */
export function setUnreadNotices(value) {
  unread.count = value?.count ?? 0;
  unread.latest = value?.latest ?? null;
  const badge = $("#notice-badge");
  badge.hidden = unread.count === 0;
  badge.textContent = unread.count > 9 ? "9+" : String(unread.count);
  $("#notice-button").setAttribute("aria-label", unread.count > 0 ? `お知らせ（未読${unread.count}件）` : "お知らせ");
  $("#notice-banner").hidden = !unread.latest;
  $("#notice-banner-title").textContent = unread.latest?.title ?? "";
}

/** お知らせの一覧を表示し、すべて既読にする（今回の表示では、未読だったものに NEW を付ける） */
export async function showNotices() {
  const list = $("#notice-list");
  const status = $("#notices-status");
  list.replaceChildren();
  status.replaceChildren(spinner());
  try {
    const { notices, readId } = await api("/api/notices");
    list.replaceChildren(...notices.map((notice) => renderNotice(notice, { isNew: notice.id > readId })));
    status.replaceChildren(notices.length === 0 ? h("p", {}, "お知らせはまだありません") : "");
    if (notices.some((notice) => notice.id > readId)) {
      await api("/api/notices/read", { method: "POST" });
      setUnreadNotices(null);
    }
  } catch (error) {
    status.replaceChildren(h("p", {}, error.message));
  }
}

/** お知らせ1件。extra は見出しの右端に置く要素（管理画面の削除ボタン） */
export function renderNotice(notice, { isNew = false, extra = null } = {}) {
  return h(
    "li",
    { class: "notice", dataset: { id: notice.id } },
    h(
      "div",
      { class: "notice-head" },
      isNew ? h("span", { class: "badge badge--new" }, "NEW") : null,
      h("time", { datetime: new Date(notice.createdAt).toISOString() }, dateTimeFormat.format(notice.createdAt)),
      extra,
    ),
    h("h2", { class: "notice-title" }, notice.title),
    notice.body ? h("div", { class: "notice-body" }, linkify(notice.body)) : null,
  );
}
