-- 管理者からのお知らせ（アップデートの案内など）。投稿と違って自動では消えず、管理者が削除するまで残る
CREATE TABLE notices (
  -- 作成時刻（ミリ秒）。posts と同じ決め方（migrations/0001_init.sql 参照）
  id    INTEGER PRIMARY KEY,
  title TEXT    NOT NULL,
  body  TEXT    NOT NULL
);

-- どのお知らせまで読んだか（notices.id）。これより新しいお知らせを未読として数える
ALTER TABLE users ADD COLUMN notices_read_id INTEGER NOT NULL DEFAULT 0;
