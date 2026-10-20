import type { CollectionEntry } from 'astro:content';
import { getCollection } from 'astro:content';

export type EventEntry = CollectionEntry<'events'>;

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** YYYY-MM-DD は UTC 0時として読み込まれるので、UTC の値で日付を扱う */
export function fmtDate(d: Date, withWeekday = true): string {
	const s = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
	return withWeekday ? `${s}（${WEEKDAYS[d.getUTCDay()]}）` : s;
}

export function fmtShort(d: Date): string {
	return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS[d.getUTCDay()]}）`;
}

export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function fmtPeriod(start: Date, end?: Date): string {
	if (!end || end.getTime() === start.getTime()) return fmtDate(start);
	const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
	const endText = sameYear
		? `${end.getUTCMonth() + 1}月${end.getUTCDate()}日（${WEEKDAYS[end.getUTCDay()]}）`
		: fmtDate(end);
	return `${fmtDate(start)}〜${endText}`;
}

/** ビルドした日（日本時間）を UTC 0時の Date で返す */
export function buildToday(): Date {
	const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
	return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
	return new Date(d.getTime() + days * DAY);
}

export type ScheduleStep = {
	date: Date;
	label: string;
	detail: string;
	/** 締切など、公式の日付そのもの */
	fixed?: boolean;
};

/**
 * 開催日と出展申込締切から、準備の日程を逆算する。
 * 各ステップの日付は目安。締切が分からない場合は申込側のステップを出さない。
 */
export function buildSchedule(data: EventEntry['data']): ScheduleStep[] {
	const start = data.eventStart;
	const steps: ScheduleStep[] = [];
	const deadline = data.applicationDeadline;

	if (deadline) {
		steps.push({
			date: addDays(deadline, -21),
			label: '出展するかを決める',
			detail:
				'出展料だけでなく、ブースの備品・交通費・人件費まで含めて社内で決めておく。出展の決裁と一緒に備品も決めると、あとで別の稟議を立てずに済みます。',
		});
		steps.push({
			date: deadline,
			label: '出展申込の締切',
			detail: '公式に掲載されている締切です。受付状況は変わることがあるため、必ず公式ページで確認してください。',
			fixed: true,
		});
	}

	const rel: Array<[number, string, string]> = [
		[
			-56,
			'出展マニュアルを読む',
			'搬入出の時間、宅配便の受付期間と宛先、小間の寸法、電源の有無、防炎の指定を確認する。備品の大きさと送り方はここで決まります。',
		],
		[
			-42,
			'出す商品を絞り、「バイヤーが知らないこと」を1つ決める',
			'並べる商品を主力中心に絞る。社内では当たり前すぎて説明を省いている事実を1つ選び、POPの一文にする。',
		],
		[
			-28,
			'備品をそろえる',
			'高さ（ライザー）・光（ライト）・文字（POP）・布（クロス）の4つを先に決める。当日に会場で考える余裕はありません。',
		],
		[
			-21,
			'POP・パネルを入稿する',
			'通路から読めるのは10文字前後。社名より「何の商品で、何が違うか」を大きく。',
		],
		[
			-14,
			'事務所で一度組んでみる',
			'長机と同じ大きさの台で実際に組み、3m離れて写真を撮る。文字が読めるか、商品が暗くないかをここで直す。',
		],
		[
			-7,
			'荷物を発送する',
			'宅配で送る場合は、出展マニュアルにある受付期間と宛先の書き方に合わせる。梱包は設営する順番に詰める。',
		],
		[
			-1,
			'搬入・設営',
			'クロス → ライザー → 主力商品 → ライト → POP の順。最後に通路へ出て3m離れて確認する。',
		],
	];
	for (const [offset, label, detail] of rel) {
		steps.push({ date: addDays(start, offset), label, detail });
	}

	steps.push({
		date: start,
		label: '開催初日',
		detail: '開催日は公式ページで最新の情報を確認してください。',
		fixed: true,
	});
	const last = data.eventEnd ?? start;
	steps.push({
		date: addDays(last, 2),
		label: '名刺の相手にお礼とフォロー',
		detail: '会期終了から48時間以内に。その場で分けておいた名刺から、優先度の高い相手に先に連絡する。',
	});

	return steps.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** 公開する展示会（下書き以外） */
export async function getPublishedEvents(): Promise<EventEntry[]> {
	return getCollection('events', ({ data }) => !data.draft);
}

/**
 * 一覧の並び順。
 * 1. 申込締切がまだ先のもの（締切の近い順）
 * 2. 締切が過ぎた・不明だが開催がまだ先のもの（開催の近い順）
 * 終了した展示会は一覧に出さない（ページは残す）。
 */
export function sortForListing(events: EventEntry[], today = buildToday()) {
	const t = today.getTime();
	const upcoming = events.filter((e) => (e.data.eventEnd ?? e.data.eventStart).getTime() >= t);
	const open = upcoming
		.filter((e) => e.data.applicationDeadline && e.data.applicationDeadline.getTime() >= t)
		.sort((a, b) => a.data.applicationDeadline!.getTime() - b.data.applicationDeadline!.getTime());
	const rest = upcoming
		.filter((e) => !open.includes(e))
		.sort((a, b) => a.data.eventStart.getTime() - b.data.eventStart.getTime());
	return { open, rest };
}

/** 本文が短すぎるページ（開催情報を写しただけのページ）をビルドで止める */
export const MIN_BODY_CHARS = 300;
