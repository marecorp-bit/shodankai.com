#!/usr/bin/env node
// LINE 公式アカウント「MARE営業レポート」から担当者へ要約を送る
//   node sales/bin/line-notify.mjs "<本文>"         … 本文を送信
//   node sales/bin/line-notify.mjs --file <path>     … ファイルの内容を送信
//   node sales/bin/line-notify.mjs --check           … トークンとアカウント情報の確認のみ（送信しない）
//
// - 担当者だけが友だちの専用アカウントなので broadcast（友だち全員へ送信）を使う（ユーザーID不要）
// - 安全策: 送信前に友だち数を確認し、config/line-notify.json の max_followers を超えていたら送らない
// - チャネルアクセストークンはコードにも環境変数にも置かない。プロキシが api.line.me への通信に自動付与する
// - 1通 5000 文字まで。超える分は切り詰める

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = path.resolve(here, "..", "..", "..", "mare-sales-data");
const cfgPath = path.join(sibling, "config", "line-notify.json");
const auditPath = path.join(sibling, "data", "audit-log.jsonl");
const cfg = (() => { try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch { return { enabled: false }; } })();

function api(method, url, body) {
  const args = ["-sS", "--max-time", "20", "-X", method, url, "-H", "Authorization: Bearer proxy-injected", "-w", "\n%{http_code}"];
  if (body) args.push("-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  const out = execFileSync("curl", args).toString("utf8");
  const i = out.lastIndexOf("\n");
  return { status: Number(out.slice(i + 1)), body: out.slice(0, i) };
}
const audit = (e) => { try { fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), source: "line-notify", ...e }) + "\n"); } catch {} };
const die = (m) => { console.error(m); audit({ action: "error", message: m }); process.exit(1); };

const args = process.argv.slice(2);
const info = api("GET", "https://api.line.me/v2/bot/info");
if (info.status !== 200) die(`LINE トークン確認に失敗しました（HTTP ${info.status}）: ${info.body.slice(0, 200)}`);
const bot = JSON.parse(info.body);
if (cfg.expected_basic_id && bot.basicId !== cfg.expected_basic_id) die(`想定外の LINE アカウントです: ${bot.basicId}（想定 ${cfg.expected_basic_id}）`);

// 友だち数（統計は前日分。新しいアカウント等で未集計なら null）
const d = new Date(Date.now() - 86400000 + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
let followers = null;
const ins = api("GET", `https://api.line.me/v2/bot/insight/followers?date=${d}`);
if (ins.status === 200) { const j = JSON.parse(ins.body); if (j.status === "ready") followers = j.followers - (j.blocks || 0); }

if (args[0] === "--check") {
  console.log(`OK: ${bot.displayName}（${bot.basicId}） 友だち数: ${followers ?? "未集計"} 送信設定: ${cfg.enabled ? "有効" : "無効"}`);
  process.exit(0);
}
if (!cfg.enabled) die("LINE 通知は無効です（config/line-notify.json の enabled）");
const max = Number(cfg.max_followers || 1);
if (followers !== null && followers > max) die(`友だち数 ${followers} が上限 ${max} を超えているため送信しません（担当者以外に届く恐れ）`);

let text = args[0] === "--file" ? fs.readFileSync(args[1], "utf8") : args.join(" ");
text = text.trim();
if (!text) die("本文が空です");
if (text.length > 4900) text = text.slice(0, 4890) + "\n…（続きは Claude で）";

const r = api("POST", "https://api.line.me/v2/bot/message/broadcast", { messages: [{ type: "text", text }] });
if (r.status !== 200) die(`LINE 送信に失敗しました（HTTP ${r.status}）: ${r.body.slice(0, 200)}`);
audit({ action: "broadcast", chars: text.length, followers });
console.log(`LINE に送信しました（${text.length}文字、友だち数: ${followers ?? "未集計"}）`);
