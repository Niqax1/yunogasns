-- いいねの数。ログインがないので「だれが押したか」は記録せず、件数だけを持つ
-- （同じブラウザから二重に押せないようにするのは画面側で行う）。
-- 件数だけなら、いいね1回の書き込みは1行で済む。
ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
