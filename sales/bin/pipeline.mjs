#!/usr/bin/env node
// 営業パイプライン管理 CLI（sales/data/pipeline.json を読み書き）
//
//   node sales/bin/pipeline.mjs list [--status S] [--class A|B|C|D]
//   node sales/bin/pipeline.mjs show <id>
//   node sales/bin/pipeline.mjs upsert <id> '<JSON>'     項目の追加・更新（状態遷移は下記コマンドで）
//   node sales/bin/pipeline.mjs set-status <id> <status> [--note "..."] [--thread-id T] [--draft-id D]
//   node sales/bin/pipeline.mjs followups [--days 14]    送信済みで返信なし・経過日数以上
//   node sales/bin/pipeline.mjs due                      次回連絡予定日が今日以前
//   node sales/bin/pipeline.mjs check-dup <email>        既存接触の確認
//   node sales/bin/pipeline.mjs where                    データ保存先の表示
//
// 状態: researched → classified → draft_saved → sent → replied → meeting → won / lost
//       （on_hold, followup_draft_saved も可）
// 「sent」は Gmail の送信済みで確認できた場合のみ（--thread-id 必須）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 営業データ: SALES_DATA_DIR > 隣接の非公開リポジトリ mare-sales-data/data > sales/data
const sibling = path.resolve(here, "..", "..", "..", "mare-sales-data");
const dataDir = process.env.SALES_DATA_DIR || (fs.existsSync(sibling) ? path.join(sibling, "data") : path.resolve(here, "..", "data"));
const file = path.join(dataDir, "pipeline.json");
const auditPath = path.join(dataDir, "audit-log.jsonl");

const STATUSES = [
  "researched", "classified", "draft_saved", "sent", "replied",
  "meeting", "followup_draft_saved", "won", "lost", "on_hold",
];

const today = () => new Date().toISOString().slice(0, 10);
const load = () => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { companies: [] }; }
};
const save = (db) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 2) + "\n");
};
const audit = (e) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), source: "pipeline", ...e }) + "\n");
};
const die = (m) => { console.error(m); process.exit(1); };
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);
const row = (c) =>
  [c.id, c.name, c.classification || "-", c.status, c.sent_date || "-", c.replied ? "返信あり" : "返信なし", c.next_contact_date || "-", c.next_action || "-"].join(" | ");

const [cmd, ...args] = process.argv.slice(2);
const db = load();
const find = (id) => db.companies.find((c) => c.id === id);

switch (cmd) {
  case "list": {
    const st = flag(args, "--status"), cl = flag(args, "--class");
    const rows = db.companies.filter((c) => (!st || c.status === st) && (!cl || c.classification === cl));
    console.log("id | 企業名 | 分類 | 状態 | 送信日 | 返信 | 次回連絡日 | 次回アクション");
    rows.forEach((c) => console.log(row(c)));
    break;
  }
  case "show": {
    const c = find(args[0]) || die(`見つかりません: ${args[0]}`);
    console.log(JSON.stringify(c, null, 2));
    break;
  }
  case "upsert": {
    const [id, json] = args;
    if (!id || !/^[a-z0-9-]+$/.test(id)) die("id は英小文字・数字・ハイフンで指定してください");
    let patch;
    try { patch = JSON.parse(json || "{}"); } catch { die("JSON が不正です"); }
    delete patch.status; delete patch.sent_date; delete patch.history; // 状態は set-status で変更
    let c = find(id);
    if (!c) {
      c = { id, status: "researched", emails: [], draft_ids: [], replied: false, allow_followup: false, history: [], created: today() };
      db.companies.push(c);
    }
    Object.assign(c, patch, { updated: today() });
    c.history.push({ date: today(), event: "upsert", fields: Object.keys(patch) });
    save(db);
    audit({ action: "upsert", id, fields: Object.keys(patch) });
    console.log(`更新しました: ${id}`);
    break;
  }
  case "set-status": {
    const [id, status] = args;
    const c = find(id) || die(`見つかりません: ${id}`);
    if (!STATUSES.includes(status)) die(`不正な状態: ${status}（${STATUSES.join(", ")}）`);
    const thread = flag(args, "--thread-id"), draft = flag(args, "--draft-id"), note = flag(args, "--note");
    if (status === "sent" && !thread) die("sent にするには Gmail 送信済みで確認したスレッドID（--thread-id）が必要です");
    if ((status === "draft_saved" || status === "followup_draft_saved") && !draft) die("下書き保存状態には --draft-id が必要です");
    if (draft) c.draft_ids.push(draft);
    if (thread) c.thread_id = thread;
    if (status === "draft_saved" && !c.first_approach_date) c.first_approach_date = today();
    if (status === "sent") { c.sent_date = c.sent_date || today(); c.allow_followup = false; }
    if (status === "followup_draft_saved") c.allow_followup = false;
    if (status === "replied") c.replied = true;
    c.history.push({ date: today(), event: `${c.status} → ${status}`, note, draft_id: draft, thread_id: thread });
    c.status = status;
    c.updated = today();
    save(db);
    audit({ action: "set-status", id, status, draft_id: draft, thread_id: thread });
    console.log(`${id}: ${status}`);
    break;
  }
  case "followups": {
    const days = Number(flag(args, "--days") || 14);
    const rows = db.companies.filter((c) => c.status === "sent" && !c.replied && daysSince(c.sent_date) >= days);
    console.log(`送信後 ${days} 日以上・返信なし: ${rows.length} 件`);
    rows.forEach((c) => console.log(`${row(c)} | 経過 ${daysSince(c.sent_date)} 日`));
    break;
  }
  case "due": {
    const rows = db.companies.filter((c) => c.next_contact_date && c.next_contact_date <= today() && !["won", "lost"].includes(c.status));
    console.log(`次回連絡予定日を過ぎた／今日: ${rows.length} 件`);
    rows.forEach((c) => console.log(row(c)));
    break;
  }
  case "where": {
    console.log(dataDir);
    break;
  }
  case "check-dup": {
    const email = (args[0] || "").toLowerCase();
    const domain = email.split("@")[1];
    const hits = db.companies.filter((c) => (c.emails || []).some((e) => e.toLowerCase() === email || e.toLowerCase().split("@")[1] === domain));
    if (!hits.length) console.log("既存の接触記録はありません");
    else hits.forEach((c) => console.log(`重複の可能性: ${row(c)}`));
    process.exit(hits.length ? 3 : 0);
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n"));
}
