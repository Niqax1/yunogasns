-- コメントへのいいね・コメントの引用のための変更

-- だれがどのコメントにいいねしたか。likes と同じく主キーだけの表にして、いいね1回の書き込みを1行に抑える
CREATE TABLE comment_likes (
  comment_id INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
) WITHOUT ROWID;

-- 投稿と同じく、表示のたびに数えずに済むよう件数をコメント側に持っておく
ALTER TABLE comments ADD COLUMN like_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN quote_count INTEGER NOT NULL DEFAULT 0;

-- 引用元のコメントID。quote_id（投稿の引用）とどちらか一方だけが入る。
-- 「このコメントを引用した投稿」の一覧は出さないので、インデックスは付けない（投稿の書き込み行数を増やさないため）
ALTER TABLE posts ADD COLUMN quote_comment_id INTEGER;
