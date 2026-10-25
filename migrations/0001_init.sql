-- 投稿
-- id は作成時刻（UNIXミリ秒）をそのまま使う。同じミリ秒に重なったときだけ +1 してずらすので、
-- 常に「新しい投稿ほど大きい」ことが保証される。これにより
--   ・タイムラインは主キーの範囲読みだけで取れる
--   ・7日を過ぎた投稿の削除も「id < 7日前の時刻」で済み、作成日時用のインデックスが要らない
-- （インデックスを1つ増やすと書き込み1回あたりの消費行数が増え、無料枠で書ける量が減る）
CREATE TABLE posts (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  -- 引用元の投稿ID。引用元は必ず先に作られ先に消えるので、外部キー制約はつけない
  -- （引用元が消えたあとは「削除された投稿」として表示する）
  quote_id      INTEGER,
  -- 一覧表示のたびに数えずに済むよう、件数は投稿側に持っておく
  comment_count INTEGER NOT NULL DEFAULT 0,
  quote_count   INTEGER NOT NULL DEFAULT 0
);

-- 「この投稿を引用した投稿」の一覧用。引用投稿だけを対象にした部分インデックスなので、
-- 通常の投稿の書き込みコストは増えない。
CREATE INDEX idx_posts_quote_id ON posts (quote_id) WHERE quote_id IS NOT NULL;

-- コメント（id の決め方は posts と同じ）
CREATE TABLE comments (
  id      INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL,
  name    TEXT    NOT NULL,
  body    TEXT    NOT NULL
);

-- 投稿ごとのコメント一覧の取得と、投稿と一緒にコメントを消すときに使う
CREATE INDEX idx_comments_post_id ON comments (post_id);
