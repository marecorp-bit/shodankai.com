#!/usr/bin/env node
// 送信承認 CLI（承認制送信：担当者が「送信OK」と明示したメールだけを送れるようにする）
//
//   node sales/bin/approve.mjs add <メール文面ファイル.md> --by "<担当者の承認発言の要旨>"
//   node sales/bin/approve.mjs list
//   node sales/bin/approve.mjs revoke <approval_id>
//
// 重要: add は「担当者がチャット等で明示的に送信を承認したとき」だけ実行すること。
//       エージェントが自分の判断で承認を作ってはならない。
//
// 承認は「宛先 + 件名 + 本文」のハッシュで記録する。送信時にフック(gmail-guard)が同じハッシュを照合し、
// 1文字でも違えば送信をブロックする。承認は1回限り（送信で使用済みになる）・有効期限7日。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = path.resolve(here, "..", "..", "..", "mare-sales-data");
const dataDir = process.env.SALES_DATA_DIR || (fs.existsSync(sibling) ? path.join(sibling, "data") : path.resolve(here, "..", "data"));
const file = path.join(dataDir, "approvals.json");
const auditPath = path.join(dataDir, "audit-log.jsonl");

export const normalize = (s) => String(s || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
export const approvalHash = (to, subject, body) =>
  crypto.createHash("sha256").update(`${String(to).toLowerCase().trim()}\n${normalize(subject)}\n${normalize(body)}`).digest("hex");

const load = () => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { approvals: [] }; }
};
const save = (db) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(db, null, 2) + "\n"); };
const audit = (e) => fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), source: "approve", ...e }) + "\n");
const die = (m) => { console.error(m); process.exit(1); };

// メール文面ファイル（frontmatter + 本文 + self-check コメント）を読む
export function parseEmailFile(p) {
  const s = fs.readFileSync(p, "utf8");
  const m = s.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("frontmatter が見つかりません");
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/\s+#.*$/, "").trim();
  }
  const body = m[2].split("<!-- self-check")[0];
  return { company_id: fm.company_id, type: fm.type, to: fm.to, subject: fm.subject, body: normalize(body) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, ...args] = process.argv.slice(2);
  const db = load();
  if (cmd === "add") {
    const p = args[0] || die("メール文面ファイルを指定してください");
    const i = args.indexOf("--by");
    const by = i >= 0 ? args[i + 1] : "";
    if (!by) die("--by に担当者の承認発言の要旨を書いてください（例: \"2026-11-20 チャットで『河内屋 送信OK』\"）");
    const e = parseEmailFile(p);
    if (!e.to || !e.subject || !e.body) die("to / subject / 本文のいずれかが空です");
    if (/\{\{[^}]*\}\}|【要記入】|TODO/.test(e.subject + e.body)) die("未記入のプレースホルダが残っています");
    const h0 = approvalHash(e.to, e.subject, e.body);
    const dup = db.approvals.find((a) => a.hash === h0 && !a.used_at && !a.revoked_at && new Date(a.expires_at) >= new Date());
    if (dup) die(`同じ文面の有効な承認が既にあります（${dup.id}）。二重送信防止のため追加できません。`);
    const id = "ap_" + crypto.randomBytes(4).toString("hex");
    const now = new Date();
    const rec = {
      id, company_id: e.company_id, type: e.type, to: e.to.toLowerCase(), subject: e.subject,
      hash: approvalHash(e.to, e.subject, e.body), source_file: path.basename(p), approved_by: by,
      approved_at: now.toISOString(), expires_at: new Date(now.getTime() + 7 * 86400000).toISOString(), used_at: null,
    };
    db.approvals.push(rec);
    save(db);
    audit({ action: "approve", id, company_id: e.company_id, to: rec.to, subject: e.subject, by });
    console.log(`承認を登録しました: ${id}（宛先 ${rec.to}／件名 ${e.subject}／期限 ${rec.expires_at.slice(0, 10)}）`);
  } else if (cmd === "list") {
    for (const a of db.approvals) {
      const st = a.revoked_at ? "取消" : a.used_at ? "使用済み" : new Date(a.expires_at) < new Date() ? "期限切れ" : "有効";
      console.log(`${a.id} | ${st} | ${a.company_id} | ${a.to} | ${a.subject}`);
    }
  } else if (cmd === "revoke") {
    const a = db.approvals.find((x) => x.id === args[0]) || die("見つかりません");
    a.revoked_at = new Date().toISOString();
    save(db);
    audit({ action: "revoke", id: a.id });
    console.log(`取り消しました: ${a.id}`);
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).join("\n"));
  }
}
