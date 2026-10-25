// 画面全体で共有する状態

/** ログイン中のアカウント（ログインしていなければ null） */
export const session = { me: null };

/** 取得済みの投稿（id → 投稿）。引用ボタンなどから投稿の中身を引くのに使う */
export const posts = new Map();

export function remember(post) {
  const known = posts.get(post.id);
  if (known) return Object.assign(known, post);
  posts.set(post.id, post);
  return post;
}

/** 自分の投稿なら削除できる。管理者はだれの投稿でも削除できる */
export function canDelete(post) {
  const me = session.me;
  return Boolean(me && (me.isAdmin || (post.author.id !== null && post.author.id === me.id)));
}
