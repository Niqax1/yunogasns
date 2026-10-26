-- プロフィール・フォロー・通知（Web Push）のための変更

-- フォロー。notify は、この人の新しい投稿を通知するか（フォローした時点ではオン）
CREATE TABLE follows (
  follower_id TEXT    NOT NULL,
  followee_id TEXT    NOT NULL,
  notify      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
) WITHOUT ROWID;

-- フォロワーの一覧と、新しい投稿を通知する相手を調べるため
CREATE INDEX idx_follows_followee_id ON follows (followee_id);

-- アカウントごとの通知の設定。いいねは数が多くなりがちなので、最初はオフにしておく
ALTER TABLE users ADD COLUMN notify_comments INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN notify_quotes   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN notify_likes    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN notify_follows  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN notify_notices  INTEGER NOT NULL DEFAULT 1;

-- 通知を受け取る端末（ブラウザの Web Push の登録情報）。1つのアカウントで複数の端末を登録できる
CREATE TABLE push_subscriptions (
  endpoint   TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions (user_id);

-- プロフィールに、その人の投稿を新しい順に出すため
CREATE INDEX idx_posts_user_id ON posts (user_id);
