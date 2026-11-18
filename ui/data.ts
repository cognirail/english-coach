// =============================================================================
// data —— 看板的数据层：读 <dataDir>/records/*.jsonl，按本地日期聚合出打卡网格与统计用的每日数字。
//
// 只在打开页面时读一次，写入端（daemon）保持纯追加；坏行（崩溃留下的半行）跳过并计数。
// 准确率口径：每百个英文词的纠错数，只算拿到结构化反馈的记录（feedback 非 null），越低越好。
// =============================================================================
import { readdir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import {
  CATEGORIES,
  countEnglishWords,
  isEnglishCorrection,
  recordsDirectory,
  type Category,
  type CoachRecord,
} from '../daemon/daemon.ts';

/** 读全部分片，按时间倒序。 */
export async function readRecords(
  dataDirectory: string,
): Promise<{ records: CoachRecord[]; bad: number }> {
  let files: string[] = [];
  try {
    const names = await readdir(recordsDirectory(dataDirectory));
    files = names.filter((f) => f.endsWith('.jsonl'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const records: CoachRecord[] = [];
  let bad = 0;
  for (const file of files) {
    const text = await readFile(nodePath.join(recordsDirectory(dataDirectory), file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        records.push(JSON.parse(line) as CoachRecord);
      } catch {
        bad++;
      }
    }
  }
  records.sort((a, b) => b.ts.localeCompare(a.ts));
  return { records, bad };
}

export interface DayStat {
  day: string; // 本地日期 YYYY-MM-DD
  count: number; // 当天记录条数（练习量）
  scored: number; // 其中拿到结构化反馈的条数
  words: number; // scored 记录的英文词数
  corrections: number; // scored 记录的纠错数
}

export interface Stats {
  days: DayStat[]; // 只含有记录的日子，按日期升序
  total: { count: number; days: number; corrections: number; words: number };
  streak: { current: number; longest: number };
  week: { thisWeek: Period; lastWeek: Period };
  categories: CategoryStat[]; // 按全部次数降序，0 次的不列
  weeks: (Period & { start: string })[]; // 最近 TREND_WEEKS 周，旧到新，start 为周一
}

export interface CategoryStat {
  category: Category | 'unlabeled';
  total: number;
  recent: number; // 最近 RECENT_DAYS 天（含今天）
}

const RECENT_DAYS = 30;
const TREND_WEEKS = 12;

export interface Period {
  count: number;
  words: number;
  corrections: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地日期；看板展示与打卡都按用户所在时区算一天。 */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + delta));
}

/** 周一为一周起点（国内习惯），返回 day 所在周的周一。 */
function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return addDays(day, -weekday);
}

const emptyPeriod = (): Period => ({ count: 0, words: 0, corrections: 0 });

function aggregateDays(records: CoachRecord[]): Map<string, DayStat> {
  const byDay = new Map<string, DayStat>();
  for (const r of records) {
    const day = localDay(new Date(r.ts));
    const s = byDay.get(day) ?? { day, count: 0, scored: 0, words: 0, corrections: 0 };
    s.count++;
    if (r.feedback !== null) {
      s.scored++;
      s.words += countEnglishWords(r.prompt);
      s.corrections += r.feedback.corrections.filter((c) => isEnglishCorrection(c)).length;
    }
    byDay.set(day, s);
  }
  return byDay;
}

/** 当前连续：今天还没写不算断，从昨天往回数。最长连续：升序扫一遍。 */
function computeStreak(
  byDay: Map<string, DayStat>,
  days: DayStat[],
  today: string,
): Stats['streak'] {
  let cursor = byDay.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (byDay.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let previous = '';
  for (const { day } of days) {
    run = previous !== '' && addDays(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { current, longest };
}

function computeWeeks(days: DayStat[], today: string): Stats['week'] {
  const thisMonday = weekStart(today);
  const lastMonday = addDays(thisMonday, -7);
  const thisWeek = emptyPeriod();
  const lastWeek = emptyPeriod();
  for (const s of days) {
    if (s.day > today) {
      continue; // 系统时钟曾被调快留下的未来记录不算进本周
    }
    let target: Period | null = null;
    if (s.day >= thisMonday) {
      target = thisWeek;
    } else if (s.day >= lastMonday) {
      target = lastWeek;
    }
    if (target !== null) {
      target.count += s.count;
      target.words += s.words;
      target.corrections += s.corrections;
    }
  }
  return { thisWeek, lastWeek };
}

function computeCategories(records: CoachRecord[], today: string): CategoryStat[] {
  const since = addDays(today, -(RECENT_DAYS - 1));
  const counts = new Map<CategoryStat['category'], CategoryStat>(
    [...CATEGORIES, 'unlabeled' as const].map((category) => [
      category,
      { category, total: 0, recent: 0 },
    ]),
  );
  for (const r of records) {
    const day = localDay(new Date(r.ts));
    const corrections = r.feedback?.corrections ?? [];
    for (const c of corrections) {
      if (!isEnglishCorrection(c) || day > today) {
        continue;
      }
      const stat = counts.get(c.category ?? 'unlabeled');
      if (stat !== undefined) {
        stat.total++;
        stat.recent += day >= since ? 1 : 0;
      }
    }
  }
  return counts
    .values()
    .filter((s) => s.total > 0)
    .toArray()
    .toSorted((a, b) => (b.total === a.total ? b.recent - a.recent : b.total - a.total));
}

function computeTrend(days: DayStat[], today: string): Stats['weeks'] {
  const first = addDays(weekStart(today), -7 * (TREND_WEEKS - 1));
  const weeks = Array.from({ length: TREND_WEEKS }, (_, index) => ({
    start: addDays(first, index * 7),
    ...emptyPeriod(),
  }));
  for (const s of days) {
    if (s.day < first || s.day > today) {
      continue;
    }
    const week = weeks[Math.floor(daysBetween(first, s.day) / 7)];
    if (week !== undefined) {
      week.count += s.count;
      week.words += s.words;
      week.corrections += s.corrections;
    }
  }
  return weeks;
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export function computeStats(records: CoachRecord[], now = new Date()): Stats {
  const byDay = aggregateDays(records);
  const days = byDay
    .values()
    .toArray()
    .toSorted((a, b) => a.day.localeCompare(b.day));
  const today = localDay(now);
  return {
    days,
    total: {
      count: records.length,
      days: days.length,
      corrections: days.reduce((n, s) => n + s.corrections, 0),
      words: days.reduce((n, s) => n + s.words, 0),
    },
    streak: computeStreak(byDay, days, today),
    week: computeWeeks(days, today),
    categories: computeCategories(records, today),
    weeks: computeTrend(days, today),
  };
}
