#!/usr/bin/env node
// Gmail 安全ガード（PreToolUse / PostToolUse フック）
//
// 方針: Gmail系ツールは「許可リスト方式」。明示的に許可したツール以外は全てブロックする。
//   - 送信・転送・削除・フィルタ作成などは、ツール名が何であっても許可リストに無い限り実行不可。
//   - 下書き作成時は宛先・プレースホルダ残り・重複アプローチを検査する。
//   - 全ての Gmail 系ツール呼び出しを sales/data/audit-log.jsonl に記録する。
//
// 使い方: node gmail-guard.mjs pre|post   （stdin にフック入力JSON）
// 終了コード 2 = ブロック（stderr の内容が Claude に返る）

import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2] === "post" ? "post" : "pre";
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const dataDir = path.join(projectDir, "sales", "data");
const auditPath = path.join(dataDir, "audit-log.jsonl");
const pipelinePath = path.join(dataDir, "pipeline.json");

// ---- 許可リスト（ツール名の末尾 = MCP の実ツール名） ----
// 読み取り系: 名前が以下の接頭辞で始まるものは許可
const READ_PREFIXES = ["search", "list", "get", "read", "fetch", "summarize"];
// 書き込み系で許可するもの（下書きのみ）
const DRAFT_TOOLS = ["create_draft", "update_draft", "create_or_update_draft"];
// 読み取り接頭辞でも、以下の語を含むものは拒否（念のため）
const DANGEROUS_WORDS = ["send", "forward", "delete", "trash", "filter", "reply_all", "schedule"];

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
      "このプロジェクトでは Gmail の送信・転送・削除は禁止されています。下書き保存のみ可能です。" +
      "送信は担当者が Gmail 上で内容と宛先を確認してから手動で行ってください。\n"
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
      if ((sameAddr || sameDomain) && !allowFollowup) {
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

// ---- PreToolUse 判定 ----
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
