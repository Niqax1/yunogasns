/** 管理者からのお知らせ */

import type { CurrentUser } from "./auth";
import { MAX_BODY_LENGTH, MAX_NOTICE_TITLE_LENGTH } from "./config";
import { HttpError, cleanText, json, readJson } from "./http";
import type { Notifier } from "./notify";

// お知らせの一覧で返す最大件数
const NOTICES_LIMIT = 50;

type NoticeRow = { id: number; title: string; body: string };

/** お知らせの一覧（新しい順）。readId より新しいものが、この人にとっての未読 */
export async function listNotices(env: Env, me: CurrentUser): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id, title, body FROM notices ORDER BY id DESC LIMIT ?1")
    .bind(NOTICES_LIMIT)
    .all<NoticeRow>();
  return json({ notices: results.map(toNotice), readId: me.noticesReadId });
}

/** 未読のお知らせの数と、いちばん新しい未読のお知らせ（タイムラインの上に出す） */
export async function unreadNotices(env: Env, me: CurrentUser) {
  const row = await env.DB.prepare(
    `SELECT id, title, (SELECT COUNT(*) FROM notices WHERE id > ?1) AS count
     FROM notices WHERE id > ?1 ORDER BY id DESC LIMIT 1`,
  )
    .bind(me.noticesReadId)
    .first<{ id: number; title: string; count: number }>();
  return row ? { count: row.count, latest: { id: row.id, title: row.title } } : { count: 0, latest: null };
}

/** お知らせをすべて既読にする */
export async function markNoticesRead(env: Env, me: CurrentUser): Promise<Response> {
  await env.DB.prepare("UPDATE users SET notices_read_id = (SELECT COALESCE(MAX(id), 0) FROM notices) WHERE id = ?1")
    .bind(me.id)
    .run();
  return json({ ok: true });
}

/** 管理者がお知らせを送る（{"title": ..., "body": ...}）。本文は空でもよい */
export async function createNotice(env: Env, request: Request, me: CurrentUser, now: number, notifier: Notifier): Promise<Response> {
  const input = await readJson(request);
  const title = cleanText(input.title, "タイトル", MAX_NOTICE_TITLE_LENGTH, { multiline: false });
  const body = cleanText(input.body, "本文", MAX_BODY_LENGTH, { multiline: true, allowEmpty: true });
  const [inserted] = await env.DB.batch<NoticeRow>([
    // id の決め方は投稿と同じ（作成時刻と、既存の最大id+1 の大きいほう）
    env.DB.prepare(
      `INSERT INTO notices (id, title, body) VALUES (MAX(?1, COALESCE((SELECT MAX(id) FROM notices), 0) + 1), ?2, ?3)
       RETURNING id, title, body`,
    ).bind(now, title, body),
    // 送った本人には、自分のお知らせを未読として出さない
    env.DB.prepare("UPDATE users SET notices_read_id = (SELECT MAX(id) FROM notices) WHERE id = ?1").bind(me.id),
  ]);
  const notice = inserted?.results[0];
  if (!notice) throw new Error("INSERT INTO notices returned no row");
  notifier.notice(me, notice);
  return json({ notice: toNotice(notice) }, 201);
}

export async function deleteNotice(env: Env, id: number): Promise<Response> {
  const result = await env.DB.prepare("DELETE FROM notices WHERE id = ?1").bind(id).run();
  if (result.meta.changes === 0) throw new HttpError(404, "そのお知らせは見つかりません。");
  return json({ deleted: true });
}

function toNotice(row: NoticeRow) {
  return { id: row.id, createdAt: row.id, title: row.title, body: row.body };
}
