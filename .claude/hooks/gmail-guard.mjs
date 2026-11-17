#!/usr/bin/env node
// Gmail 安全ガード（PreToolUse / PostToolUse フック）
//
// 方針: Gmail系ツールは「許可リスト方式」。明示的に許可したツール以外は全てブロックする。
//   - 転送・削除・フィルタ作成などは、ツール名が何であっても許可リストに無い限り実行不可。
//   - send_message は送信ポリシー（非公開リポジトリ config/send-policy.json）に従う。既定 off。draftId 送信は常に禁止。
//   - 下書き作成時は宛先・プレースホルダ残り・重複アプローチを検査する。
//   - 全ての Gmail 系ツール呼び出しを sales/data/audit-log.jsonl に記録する。
//
// 使い方: node gmail-guard.mjs pre|post   （stdin にフック入力JSON）
// 終了コード 2 = ブロック（stderr の内容が Claude に返る）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "post" ? "post" : "pre";
// リポジトリ位置はスクリプト自身の場所から求める（作業ディレクトリに依存しない）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 営業データ: SALES_DATA_DIR > 隣接の非公開リポジトリ mare-sales-data/data > sales/data
const sibling = path.resolve(repoRoot, "..", "mare-sales-data");
const dataDir = process.env.SALES_DATA_DIR || (fs.existsSync(sibling) ? path.join(sibling, "data") : path.join(repoRoot, "sales", "data"));
const auditPath = path.join(dataDir, "audit-log.jsonl");
const pipelinePath = path.join(dataDir, "pipeline.json");

// ---- 許可リスト（ツール名の末尾 = MCP の実ツール名） ----
// 読み取り系: 名前が以下の接頭辞で始まるものは許可
const READ_PREFIXES = ["search", "list", "get", "read", "fetch", "summarize"];
// 書き込み系で許可するもの（下書きのみ）
const DRAFT_TOOLS = ["create_draft", "update_draft", "create_or_update_draft"];
// 読み取り接頭辞でも、以下の語を含むものは拒否（念のため）
const DANGEROUS_WORDS = ["send", "forward", "reply", "delete", "trash", "filter", "spam", "label", "schedule"];

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function audit(entry) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // 記録に失敗しても判定は継続する
  }
}

function block(reason, toolName, input) {
  audit({ phase: "pre", decision: "blocked", tool: toolName, reason, input: summarizeInput(input) });
  process.stderr.write(
    `[gmail-guard] ブロックしました: ${reason}\n` +
      "このプロジェクトでは Gmail の転送・削除は禁止、送信は送信ポリシー（mare-sales-data/config/send-policy.json）の範囲内のみ可能です。" +
      "ブロックを回避しようとせず、担当者に報告してください。\n"
  );
  process.exit(2);
}

function summarizeInput(input) {
  // 本文全体は記録しない（個人情報の不要な保存を避ける）
  if (!input || typeof input !== "object") return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > 200) out[k] = v.slice(0, 80) + `…(${v.length}文字)`;
    else out[k] = v;
  }
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STRICT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// 宛先系フィールド（to / cc / bcc / recipients など）からアドレスを収集
function collectRecipients(input) {
  const found = { to: [], cc: [], bcc: [] };
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      const bucket = key === "cc" ? "cc" : key === "bcc" ? "bcc" : /^(to|recipients?|to_recipients|toaddresses)$/.test(key) ? "to" : null;
      if (bucket) {
        const vals = Array.isArray(v) ? v : [v];
        for (const item of vals) {
          if (typeof item === "string") found[bucket].push(...(item.match(EMAIL_RE) || []));
          else if (item && typeof item === "object") {
            const s = item.email || item.address || "";
            if (s) found[bucket].push(s);
          }
        }
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  };
  walk(input);
  return found;
}

function isReply(input) {
  const s = JSON.stringify(input || {});
  return /"(thread_?id|threadId|in_?reply_?to|inReplyTo|reply_to_message_id|message_id)"\s*:\s*"[^"]+"/i.test(s);
}

function allText(input) {
  return JSON.stringify(input || {});
}

function loadPipeline() {
  try {
    return JSON.parse(fs.readFileSync(pipelinePath, "utf8"));
  } catch {
    return { companies: [] };
  }
}

function checkDraft(toolName, input) {
  const rcpt = collectRecipients(input);
  const all = [...rcpt.to, ...rcpt.cc, ...rcpt.bcc];

  if (rcpt.to.length === 0) block("宛先(To)が指定されていない、または読み取れません。", toolName, input);
  for (const a of all) {
    if (!STRICT_EMAIL_RE.test(a)) block(`宛先の形式が不正です: ${a}`, toolName, input);
  }
  if (rcpt.to.length > 1) block("営業メールの宛先(To)は1件のみにしてください（一斉送信防止）。", toolName, input);
  if (rcpt.bcc.length > 0) block("BCC は使用できません（一斉送信防止）。", toolName, input);

  const text = allText(input);
  if (/\{\{[^}]*\}\}|【要記入】|＜要記入＞|TODO/.test(text)) {
    block("本文または件名に未記入のプレースホルダ（{{…}} / 【要記入】 / TODO）が残っています。", toolName, input);
  }

  // 重複アプローチ防止（返信下書きは除く）
  if (!isReply(input)) {
    const p = loadPipeline();
    const to = rcpt.to[0].toLowerCase();
    const domain = to.split("@")[1];
    const FREE = ["gmail.com", "yahoo.co.jp", "outlook.com", "hotmail.com", "icloud.com", "outlook.jp"];
    for (const c of p.companies || []) {
      const status = c.status || "";
      if (!["draft_saved", "sent", "replied", "meeting", "followup_draft_saved"].includes(status)) continue;
      const emails = (c.emails || []).map((e) => String(e).toLowerCase());
      const sameAddr = emails.includes(to);
      const sameDomain = !FREE.includes(domain) && emails.some((e) => e.split("@")[1] === domain);
      const allowFollowup = c.allow_followup === true;
      // 同じ会社の記録済み下書きを、同じ宛先のまま更新する場合は重複ではない
      const draftId = String(input.draftId || input.draft_id || "");
      const updatingOwnDraft = !!draftId && sameAddr && (c.draft_ids || []).includes(draftId);
      if ((sameAddr || sameDomain) && !allowFollowup && !updatingOwnDraft) {
        block(
          `重複アプローチの可能性: ${c.name}（状態: ${status}）に既に ${sameAddr ? "同一アドレス" : "同一ドメイン"}で接触記録があります。` +
            "フォローアップの場合は担当者の確認後、pipeline で allow_followup を true にしてください。",
          toolName,
          input
        );
      }
    }
  }
  return rcpt;
}

const raw = readStdin();
let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  // 入力が読めない場合は安全側に倒してブロック
  process.stderr.write("[gmail-guard] フック入力を解析できないためブロックしました。\n");
  process.exit(2);
}

const toolName = payload.tool_name || "";
const input = payload.tool_input || {};
const shortName = toolName.split("__").pop().toLowerCase();

if (!/gmail/i.test(toolName)) process.exit(0); // Gmail 以外は対象外

if (mode === "post") {
  const resp = payload.tool_response;
  const respStr = typeof resp === "string" ? resp : JSON.stringify(resp || "");
  const idMatch = respStr.match(/"(?:draft_?id|id)"\s*:\s*"([^"]+)"/i);
  audit({ phase: "post", tool: toolName, result_id: idMatch ? idMatch[1] : null, ok: !/error/i.test(respStr.slice(0, 200)) });
  process.exit(0);
}

// ---- 送信ポリシー（非公開リポジトリ config/send-policy.json） ----
// mode: "off"（既定・ファイル無し時も off）| "test"（許可リストの宛先にのみ送信可）
// それ以外の値（将来の "live" 等）は未実装のためブロック（fail-closed）。
function loadSendPolicy() {
  const p = path.resolve(dataDir, "..", "config", "send-policy.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { mode: "off" };
  }
}

function sendsToday() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    return fs
      .readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((l) => l.includes('"decision":"allowed"') && l.includes("send_message") && l.includes(`"ts":"${today}`)).length;
  } catch {
    return 0;
  }
}

function checkSend(toolName, input) {
  const policy = loadSendPolicy();
  if (policy.mode === "off") block("送信ポリシーが off です（config/send-policy.json）。送信は担当者が Gmail 上で行ってください。", toolName, input);
  if (policy.mode !== "test") block(`送信ポリシーのモード "${policy.mode}" は未対応です。`, toolName, input);
  // draftId 指定時は to/cc/bcc 等が無視され「下書きの宛先」にそのまま送信される。
  // フックからは下書きの実際の宛先を検証できないため、draftId による送信は常にブロックする。
  if (Object.keys(input).some((k) => /draft/i.test(k))) {
    block("下書きID(draftId)指定の送信は禁止です（実際の宛先を検証できないため）。宛先・件名・本文を明示して送信してください。", toolName, input);
  }
  const allowed = (policy.allowed_recipients || []).map((a) => String(a).toLowerCase());
  const rcpt = collectRecipients(input);
  if (rcpt.to.length !== 1) block("送信の宛先(To)は1件のみです。", toolName, input);
  if (rcpt.cc.length || rcpt.bcc.length) block("テスト送信では CC/BCC は使用できません。", toolName, input);
  const to = rcpt.to[0].toLowerCase();
  if (!STRICT_EMAIL_RE.test(to)) block(`宛先の形式が不正です: ${to}`, toolName, input);
  if (!allowed.includes(to)) block(`テストモードでは許可リスト外の宛先には送信できません: ${to}`, toolName, input);
  const prefix = policy.require_subject_prefix || "";
  if (prefix && !String(input.subject || "").startsWith(prefix)) block(`テスト送信の件名は「${prefix}」で始めてください。`, toolName, input);
  if (/\{\{[^}]*\}\}|【要記入】|＜要記入＞|TODO/.test(allText(input))) block("未記入のプレースホルダが残っています。", toolName, input);
  if (input.attachments && input.attachments.length) block("テスト送信では添付ファイルは使用できません。", toolName, input);
  const cap = Number(policy.max_sends_per_day || 0);
  if (cap > 0 && sendsToday() >= cap) block(`本日の送信上限（${cap}件）に達しました。`, toolName, input);
  return { to, mode: policy.mode };
}

// ---- PreToolUse 判定 ----
if (shortName === "send_message") {
  const r = checkSend(toolName, input);
  audit({ phase: "pre", decision: "allowed", tool: toolName, to: [r.to], send_mode: r.mode, subject: String(input.subject || "").slice(0, 80) });
  process.exit(0);
}
if (DANGEROUS_WORDS.some((w) => shortName.includes(w))) {
  block(`危険な操作（${shortName}）は禁止されています。`, toolName, input);
}
if (DRAFT_TOOLS.includes(shortName)) {
  const rcpt = checkDraft(toolName, input);
  audit({ phase: "pre", decision: "allowed", tool: toolName, to: rcpt.to, cc: rcpt.cc, reply: isReply(input) });
  process.exit(0);
}
if (READ_PREFIXES.some((p) => shortName.startsWith(p))) {
  audit({ phase: "pre", decision: "allowed", tool: toolName, input: summarizeInput(input) });
  process.exit(0);
}
block(`許可リストに無い Gmail ツール（${shortName}）です。必要な場合は担当者が許可リストを更新してください。`, toolName, input);
