import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
		}),
});

/**
 * 展示会・商談会のページ。
 * 書き方の決まりは docs/展示会ページの書き方.md を参照。
 * 公式ページで確かめられた項目だけを書く。確かめられない項目は「書かない」（省略する）。
 */
const events = defineCollection({
	loader: glob({ base: './src/content/events', pattern: '**/*.md' }),
	schema: z
		.object({
			// 正式名称（公式ページの表記どおり）
			name: z.string().min(2),
			// 一覧と meta description に使う1〜2文。独自の内容を含める
			description: z.string().min(20).max(160),
			// 業界。備品の出し分けに使う（food＝食品、it＝DX・IT）
			industry: z.enum(['food', 'it']),
			// 開催日（初日）と最終日。YYYY-MM-DD
			eventStart: z.coerce.date(),
			eventEnd: z.coerce.date().optional(),
			// 会場名（公式表記）と所在地の都道府県
			venue: z.string().optional(),
			prefecture: z.string().optional(),
			organizer: z.string().optional(),
			// 出展者の業種・規模（公式に書かれている範囲で）
			exhibitors: z.string().optional(),
			// 出展申込の締切。公式で確かめられた場合だけ書く
			applicationDeadline: z.coerce.date().optional(),
			// 出展料（公式表記のまま。税別・税込も含める）
			fee: z.string().optional(),
			// 公式ページ。最新情報の確認先として必ずリンクする
			officialUrl: z.url(),
			// 確かめるのに使ったページ（公式・主催者のもの）
			sources: z.array(z.url()).min(1),
			// 公式ページで内容を確かめた日
			verifiedAt: z.coerce.date(),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date(),
			// 下書き。true のものはビルドに含めない
			draft: z.boolean().default(false),
		})
		.refine((d) => !d.eventEnd || d.eventEnd >= d.eventStart, {
			message: 'eventEnd は eventStart 以降にしてください',
			path: ['eventEnd'],
		})
		.refine((d) => !d.applicationDeadline || d.applicationDeadline <= d.eventStart, {
			message: 'applicationDeadline は開催日より前にしてください',
			path: ['applicationDeadline'],
		}),
});

export const collections = { blog, events };
