// 通知（Web Push）の送り主を証明する鍵（VAPID）を作るコマンド。
//
//   npm run vapid-keys [-- --force]
//
// 秘密鍵は .dev.vars（Git に入れないファイル）に、公開鍵は wrangler.jsonc の vars に書き込む。
// 秘密鍵は画面に表示しない。本番には npx wrangler secret bulk .dev.vars で設定する。
// 鍵を作り直すと、それまでに通知をオンにした端末には届かなくなる（各端末でオンにし直す必要がある）ので、
// すでに鍵があるときは --force を付けたときだけ作り直す。

import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const devVarsPath = fileURLToPath(new URL("../.dev.vars", import.meta.url));
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const PRIVATE_KEY_LINE = /^VAPID_PRIVATE_KEY=.*$/m;
const PUBLIC_KEY_VALUE = /("VAPID_PUBLIC_KEY"\s*:\s*")[^"]*(")/;

const devVars = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : "";
const config = readFileSync(configPath, "utf8");
if (PRIVATE_KEY_LINE.test(devVars) && !process.argv.includes("--force")) {
  console.error("鍵はすでに .dev.vars にあります。作り直すときは npm run vapid-keys -- --force");
  console.error("（作り直すと、通知をオンにしていた端末はすべて、オンにし直す必要があります）");
  process.exit(1);
}
if (!PUBLIC_KEY_VALUE.test(config)) {
  console.error('wrangler.jsonc の vars に "VAPID_PUBLIC_KEY": "" の行が見つかりません。');
  process.exit(1);
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
// 公開鍵は 0x04 + x + y の65バイト、秘密鍵は32バイト。どちらも base64url
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);

const line = `VAPID_PRIVATE_KEY=${jwk.d}`;
const separator = devVars && !devVars.endsWith("\n") ? "\n" : "";
writeFileSync(devVarsPath, PRIVATE_KEY_LINE.test(devVars) ? devVars.replace(PRIVATE_KEY_LINE, line) : `${devVars}${separator}${line}\n`);
writeFileSync(configPath, config.replace(PUBLIC_KEY_VALUE, `$1${publicKey.toString("base64url")}$2`));

console.log("通知用の鍵を作りました（秘密鍵は .dev.vars、公開鍵は wrangler.jsonc）。");
console.log("本番で使うには、npx wrangler secret bulk .dev.vars で秘密鍵を設定してから、wrangler.jsonc の変更をプッシュしてください。");
