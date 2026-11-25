# 手順書：固定CC＋資料添付つきの営業下書きを自動作成する（2026-11-25）

ゴール
1. Gmail コネクタを松山さんの withmare.jp アカウントに戻す
2. LINE 公式アカウント（お客様向け）で、友だち追加 → 問い合わせ → 返信 ができる
3. 毎朝の自動下書きに「CC：砂子さん（withmare.jp）」と「紹介資料 PDF の添付」が付く

所要：A（松山さん）20分 ＋ B（新しいセッション）30〜40分

---

## A. 松山さんが行う操作

### A-1. Gmail コネクタを withmare.jp に戻す（スマホのブラウザでも可）
1. https://claude.ai/customize/connectors を開く
2. Gmail →「接続を解除」
3. もう一度「接続」→ Google のアカウント選択で **松山さんの withmare.jp アカウント** を選び、許可する
4. この後に始めるセッションから有効になる（今あるセッションには反映されない）

### A-2. LINE 公式アカウントで問い合わせを受けて返信できるようにする（スマホの「LINE公式アカウント」アプリ）
対象は **お客様向けの「MARE（マレ）」**。資料の QR（@324eahss）で開くアカウントと同じか、先に自分のスマホで QR を読んで確認する。
毎朝の報告用（担当者専用）のアカウントは触らない。
1. ホーム → 設定 → 応答設定：「チャット」をオン、「応答メッセージ」をオフ
2. 設定 → 権限 → メンバーを追加：砂子さんを「管理者」または「運用担当者」で招待（リンクを LINE で送る）
3. スマホの通知設定でチャットの新着通知をオン（二人とも）
4. ホーム → あいさつメッセージ：例「ご覧いただきありがとうございます。会社名とご相談内容をお送りください。担当の松山・砂子からご返信します。」
5. 確認：自分の LINE（または家族の LINE）で QR から友だち追加 → メッセージを送る → アプリのチャットに届き、返信できれば OK

### A-3. 新しい資料 PDF を用意
- 砂子さんの新しい資料が届いていればそれを、まだなら今の版で進める（差し替えは後で登録し直すだけ）。
- B のセッションの最初のメッセージに PDF を添付する。

---

## B. 新しいセッションで行う作業（Claude が実施）

### B-0. セッションの始め方
- claude.ai/code で新しいセッションを作り、リポジトリは **shodankai.com と mare-sales-data の両方** を選ぶ。
- 最初のメッセージに PDF を添付し、次の文を貼り付ける：

```
sales/docs/runbook-cc-attachment.md の B を実行してください。
shodankai.com はブランチ claude/mare-sales-agent-gaseoc、mare-sales-data もブランチ claude/mare-sales-agent-gaseoc（無ければ main）を使う。
添付の PDF が紹介資料です。固定CCは（ここに砂子さんのアドレスを書く）。
送信は絶対にしない。下書きまで。
```

### B-1. 事前確認（1つでも NG なら止めて報告）
1. `/home/user/shodankai.com` と `/home/user/mare-sales-data` があり、指定ブランチになっている
2. `bash sales/bin/install-guard.sh` を実行し、`grep -c mcp__Gmail__ ~/.claude/settings.json` が 20 以上
3. `mcp__Gmail__list_drafts`（1件）で接続アカウントが **松山さんの withmare.jp** であること

### B-2. 資料と固定 CC を登録（mare-sales-data 側）
1. `node sales/bin/attachments.mjs add <添付PDFのパス> --name tanaroku-uriba`
   - ファイル名がそのまま相手に見える添付名になる。日本語名でよいが、意味の分かる名前にしてから登録する（例：`タナロク売場_ご紹介_MARE.pdf`）
2. `node sales/bin/attachments.mjs list` → `OK`
3. `mare-sales-data/config/mail-defaults.json` を作る：`{ "fixed_cc": ["<砂子さんのアドレス>"] }`
4. mare-sales-data をコミット・プッシュ

### B-3. 自分宛てのテスト下書き（営業先には出さない）
1. `create_draft`：To＝松山さんのアドレス、CC＝固定 CC、件名「[テスト] CC・添付つき下書き」、`attachments` は `node sales/bin/attachments.mjs ref tanaroku-uriba` の出力
2. `get_draft` で To・CC・件名・添付ファイル名を確認
3. 松山さんが Gmail の下書きを開き、CC と添付 PDF（開けるか、最終ページの QR）を確認 → 確認後に手動で削除

### B-4. 本番の自動下書きを1社で確認
1. 「daily-prospecting の手順で、今日は1社だけ」実行（候補選定 → 調査 → 分類 → 文面 → 下書き）
2. 下書きに CC・添付・本文の「資料を添付」「LINE のリンク」が入っていることを `get_draft` で確認
3. 松山さんが Gmail で中身を確認（送るかどうかは通常どおり「〇〇 送信OK」で判断）

### B-5. 毎朝のルーティンに反映
1. shodankai.com のブランチから main へのプルリクエストを作る → 松山さんが GitHub でマージ
   - 順番を守る：B-2（資料・CC の登録）が終わってからマージする。先にマージすると、資料未登録で毎朝のルーティンが止まる
2. 翌朝、自動下書きの差出人アカウント・CC・添付を Gmail で確認する

---

※ このファイルは公開リポジトリにあるため、個人のメールアドレスは書かない。

## 安全のための決まり（変更なし）
- 送信はしない。承認制送信は、松山さんが「〇〇 送信OK」と明示したものだけ。
- CC にできるのは `mail-defaults.json` の固定 CC だけ。BCC は不可。
- 添付できるのは登録した資料だけ。資料を差し替えたら `attachments.mjs add` で登録し直す。
