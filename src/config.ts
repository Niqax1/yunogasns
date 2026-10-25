// 保存期間。これを過ぎた投稿は表示せず、定期処理で削除する。
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// public/js/ui.js にも同じ値があるので、変えるときは両方そろえる
export const MAX_NAME_LENGTH = 20;
export const MAX_BODY_LENGTH = 1000;
export const MAX_IMAGES_PER_POST = 4;

export const PAGE_SIZE = 30; // タイムライン・引用一覧で一度に返す件数
export const NEW_POSTS_LIMIT = 50; // 新着チェックで一度に返す件数
export const COMMENTS_PAGE_SIZE = 100;
export const LIKERS_LIMIT = 200; // 「いいねした人」の一覧で返す最大人数

// ログインID。英数字と _ だけにする（URLや表示で困らないように）
export const USER_ID_PATTERN = /^[A-Za-z0-9_]{1,20}$/;
