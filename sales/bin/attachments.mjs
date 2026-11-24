#!/usr/bin/env node
// 営業メールの添付ファイル許可リスト
//
//   node sales/bin/attachments.mjs add <ファイル> --name <登録名>   ファイルを mare-sales-data/assets/ にコピーし、ハッシュを登録
//   node sales/bin/attachments.mjs list                            登録済みの添付と、ファイルの実在・ハッシュ一致を表示
//   node sales/bin/attachments.mjs ref <登録名>                    Gmail の create_draft に渡す attachments 配列(JSON)を出力
//
// 許可リスト: mare-sales-data/config/attachments.json（非公開）
//   { "attachments": [ { "name": "tanaroku-uriba", "filename": "タナロク売場_ご紹介.pdf",
//                        "path": "assets/....pdf", "sha256": "...", "mimeType": "application/pdf", "added_at": "..." } ] }
// フック(gmail-guard)は、ここに登録された内容（sha256 一致）・ファイル名のファイルしか添付させない。
// 資料を差し替えたら add し直す（同じ登録名は上書き）。古い版のハッシュは無効になる。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = path.resolve(here, "..", "..", "..", "mare-sales-data");
export const dataDir = process.env.SALES_DATA_DIR || (fs.existsSync(sibling) ? path.join(sibling, "data") : path.resolve(here, "..", "data"));
export const privateRoot = path.resolve(dataDir, "..");
const configPath = path.join(privateRoot, "config", "attachments.json");

export const sha256File = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export function loadAttachments() {
  try {
    const j = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return Array.isArray(j.attachments) ? j.attachments : [];
  } catch {
    return [];
  }
}

// ツール入力の attachments 1件から内容の sha256 を求める。
// content は「sha256:<hex>:<絶対パス>」形式のファイル参照、または base64。
// ファイル参照の場合は、実ファイルのハッシュが参照のハッシュと一致することも確かめる。
export function attachmentDigest(att) {
  const c = String((att && att.content) || "");
  const ref = c.match(/^sha256:([0-9a-f]{64}):(.+)$/);
  if (ref) {
    const [, h, p] = ref;
    let actual = null;
    try { actual = sha256File(p); } catch { return { error: `添付ファイルを読めません: ${p}` }; }
    if (actual !== h) return { error: "添付ファイル参照のハッシュと実ファイルの内容が一致しません。" };
    return { sha256: h };
  }
  if (!c) return { error: "添付の content が空です。" };
  return { sha256: crypto.createHash("sha256").update(Buffer.from(c, "base64")).digest("hex") };
}

// 添付配列を許可リストと照合する。OK なら { ok:true, hashes:[...] }、NG なら { ok:false, reason }
export function checkAttachments(list) {
  if (!list || !list.length) return { ok: true, hashes: [] };
  const allowed = loadAttachments();
  if (!allowed.length) return { ok: false, reason: "添付の許可リスト（mare-sales-data/config/attachments.json）が無いか空です。" };
  const hashes = [];
  for (const att of list) {
    if (att.inline) return { ok: false, reason: "インライン添付は使用できません。" };
    const d = attachmentDigest(att);
    if (d.error) return { ok: false, reason: d.error };
    const hit = allowed.find((a) => a.sha256 === d.sha256);
    if (!hit) return { ok: false, reason: "許可リストに登録されていないファイル（または古い版）は添付できません。" };
    if (att.filename !== hit.filename) return { ok: false, reason: `添付のファイル名は登録どおり「${hit.filename}」にしてください。` };
    if (hashes.includes(d.sha256)) return { ok: false, reason: "同じファイルが重複して添付されています。" };
    hashes.push(d.sha256);
  }
  return { ok: true, hashes: hashes.sort() };
}

// 登録名から create_draft / send_message 用の attachments 配列を作る
export function attachmentRefs(names) {
  const allowed = loadAttachments();
  return names.map((n) => {
    const a = allowed.find((x) => x.name === n);
    if (!a) throw new Error(`未登録の添付です: ${n}`);
    const abs = path.join(privateRoot, a.path);
    if (sha256File(abs) !== a.sha256) throw new Error(`登録後にファイルが変わっています: ${a.path}（add し直してください）`);
    return { filename: a.filename, mimeType: a.mimeType, content: `sha256:${a.sha256}:${abs}` };
  });
}

// 登録名 → sha256（承認ハッシュ用）
export function hashesForNames(names) {
  return attachmentRefs(names).map((r) => r.content.split(":")[1]).sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, ...args] = process.argv.slice(2);
  const die = (m) => { console.error(m); process.exit(1); };
  if (cmd === "add") {
    const src = args[0] || die("ファイルを指定してください");
    const i = args.indexOf("--name");
    const name = i >= 0 ? args[i + 1] : die("--name <登録名> を指定してください（例: tanaroku-uriba）");
    if (!/^[a-z0-9-]+$/.test(name)) die("登録名は半角英小文字・数字・ハイフンのみ");
    const filename = path.basename(src);
    const ext = path.extname(filename).toLowerCase();
    const mimeType = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg" }[ext] || die(`未対応の形式: ${ext}`);
    const rel = path.join("assets", `${name}${ext}`);
    fs.mkdirSync(path.join(privateRoot, "assets"), { recursive: true });
    fs.copyFileSync(src, path.join(privateRoot, rel));
    const rec = { name, filename, path: rel, sha256: sha256File(path.join(privateRoot, rel)), mimeType, added_at: new Date().toISOString() };
    const list = loadAttachments().filter((a) => a.name !== name);
    list.push(rec);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ attachments: list }, null, 2) + "\n");
    console.log(`登録しました: ${name}（${filename}／${rec.sha256.slice(0, 12)}…）→ ${rel}`);
  } else if (cmd === "list") {
    for (const a of loadAttachments()) {
      let st;
      try { st = sha256File(path.join(privateRoot, a.path)) === a.sha256 ? "OK" : "内容不一致"; } catch { st = "ファイル無し"; }
      console.log(`${a.name} | ${a.filename} | ${a.path} | ${st}`);
    }
  } else if (cmd === "ref") {
    try { console.log(JSON.stringify(attachmentRefs(args), null, 2)); } catch (e) { die(e.message); }
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).join("\n"));
  }
}
