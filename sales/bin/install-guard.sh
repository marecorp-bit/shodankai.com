#!/usr/bin/env bash
# Gmail 安全ガードをユーザー設定 (~/.claude/settings.json) に入れる。
# 使い方: bash shodankai.com/sales/bin/install-guard.sh   （リポジトリの親ディレクトリから）
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$HOME/.claude"
node -e '
const fs=require("fs");const repo=process.argv[1];const out=process.argv[2];
const s=JSON.parse(fs.readFileSync(repo+"/.claude/settings.json","utf8"));
const hook=repo+"/.claude/hooks/gmail-guard.mjs";
s.hooks.PreToolUse[0].hooks[0].command=`node ${hook} pre || exit 2`;
s.hooks.PostToolUse[0].hooks[0].command=`node ${hook} post || true`;
fs.writeFileSync(out,JSON.stringify(s,null,2)+"\n");' "$REPO" "$HOME/.claude/settings.json"
echo "installed Gmail guard -> $HOME/.claude/settings.json"
