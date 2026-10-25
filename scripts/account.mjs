// アカウントを発行する（すでにあるIDなら、パスワードを発行し直す）コマンド。
// 最初の管理者アカウントを作るときや、管理者のパスワードが分からなくなったときに使う。
//
//   npm run account -- <ID> [--admin] [--remote]
//
// --admin  管理者にする
// --remote 本番のデータベースが対象（付けないと手元の npm run dev 用のデータベース）
//
// パスワードは自動で作り、画面に1回だけ表示する。データベースにはハッシュだけを保存する。
// パスワードを発行し直したアカウントは、ログイン中の端末もすべてログアウトになる。

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/auth.ts と同じ方式・同じ回数でハッシュを作る（変えるときは両方そろえる）
const PBKDF2_ITERATIONS = 30_000;
const PASSWORD_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
const PASSWORD_LENGTH = 10;

const args = process.argv.slice(2);
const id = args.find((arg) => !arg.startsWith("--"));
const isAdmin = args.includes("--admin");
const remote = args.includes("--remote");

if (!id || !/^[A-Za-z0-9_]{1,20}$/.test(id)) {
  console.error("使い方: npm run account -- <ID（英数字と _、20文字まで）> [--admin] [--remote]");
  process.exit(1);
}

const password = Array.from(crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH)), (byte) =>
  PASSWORD_CHARS.charAt(byte % PASSWORD_CHARS.length),
).join("");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const hash = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
const passwordHash = `pbkdf2$${PBKDF2_ITERATIONS}$${Buffer.from(salt).toString("base64")}$${Buffer.from(hash).toString("base64")}`;

// ID は上で英数字と _ だけに限っているので、そのまま SQL に入れても安全
const sql = [
  `INSERT INTO users (id, name, password_hash, is_admin, created_at)
   VALUES ('${id}', '${id}', '${passwordHash}', ${isAdmin ? 1 : 0}, ${Date.now()})
   ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash${isAdmin ? ", is_admin = 1" : ""}`,
  `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE id = '${id}')`,
].join(";\n");

const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
execFileSync(process.execPath, [wrangler, "d1", "execute", "DB", remote ? "--remote" : "--local", "--command", sql], {
  stdio: ["ignore", "ignore", "inherit"],
});

console.log(`\n${remote ? "本番" : "手元"}のデータベースにアカウントを発行しました${isAdmin ? "（管理者）" : ""}。`);
console.log(`  ID:         ${id}`);
console.log(`  パスワード: ${password}`);
console.log("パスワードはここでしか表示されません。控えておいてください。");
