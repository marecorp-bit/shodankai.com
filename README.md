# shodankai.com

商談会準備専門店のサイト。Astro の静的サイト。

## 公開の流れ

`main` にマージすると、Cloudflare（Workers Builds「shodankai-com」）が自動でビルドし、https://shodankai.com に反映される。
変更はブランチを切って PR で出し、人がマージする。

## 構成

```text
src/
├── content/
│   ├── blog/      記事（Markdown）
│   └── events/    展示会・商談会のページ（Markdown・1件1ファイル）
├── data/kit.ts    展示会ページに出す備品の一覧と、セットへの導線の文言
├── lib/events.ts  日付の表示、準備日程の逆算、一覧の並び順
├── pages/
│   ├── events/    展示会の一覧（締切の近い順）と各ページの型
│   └── blog/
└── styles/global.css
docs/展示会ページの書き方.md   展示会ページを足すときの決まり
```

展示会ページを足すときは、必ず `docs/展示会ページの書き方.md` を読む。

## コマンド

| コマンド | 内容 |
| :-- | :-- |
| `npm install` | 依存関係を入れる |
| `npm run dev` | 開発サーバー（localhost:4321） |
| `npm run build` | `dist/` にビルド。展示会ページの項目や本文の長さに不足があればここで止まる |
| `npm run preview` | ビルド結果を確認 |
