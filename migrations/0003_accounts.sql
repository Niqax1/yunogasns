-- ログイン機能・いいねしたアカウントの記録・写真の添付のための変更

-- アカウント。作成は管理者だけが行う（自分で登録する機能はない）
CREATE TABLE users (
  -- ログインID（英数字と _）。ログインのときは大文字・小文字を区別しない
  id            TEXT    PRIMARY KEY COLLATE NOCASE,
  -- 表示名。本人があとから変更できる
  name          TEXT    NOT NULL,
  -- パスワードのハッシュ（src/auth.ts 参照）。パスワードそのものは保存しない
  password_hash TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  -- アイコン画像の KV のキー。未設定なら NULL
  avatar_key    TEXT,
  created_at    INTEGER NOT NULL
);

-- ログイン中の端末。Cookie に入れたトークンそのものではなく、そのハッシュを保存する
CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

-- だれがどの投稿にいいねしたか。行が1つだけの表にして（WITHOUT ROWID）、書き込みを1回あたり1行に抑える
CREATE TABLE likes (
  post_id    INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
) WITHOUT ROWID;

-- 投稿者・コメントした人のアカウント。ログイン導入前の投稿は NULL のまま（name に当時の名前が残っている）
ALTER TABLE posts ADD COLUMN user_id TEXT;
ALTER TABLE comments ADD COLUMN user_id TEXT;

-- 添付した写真。[{"k": KVのキー, "w": 幅, "h": 高さ}] の JSON
ALTER TABLE posts ADD COLUMN images TEXT;

-- ログイン導入前のいいねは、だれが押したか分からず likes 表と数が合わないので 0 に戻す
UPDATE posts SET like_count = 0;
