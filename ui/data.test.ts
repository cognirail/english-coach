// data 的契约：跨分片合并、倒序、跳过半行；按本地日期聚合；准确率只算有结构化反馈的记录；
// 连续天数「今天没写不算断」；本周 / 上周以周一为界。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import type { CoachRecord } from '../daemon/daemon.ts';
import { computeStats, localDay, readRecords } from './data.ts';

const TMP = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'english-coach-data-'));
after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** 2026 年本地时间 m-d 10:00 的一条记录；corrections 为 null 表示没拿到结构化反馈。 */
function rec(m: number, d: number, prompt: string, corrections: number | null): CoachRecord {
  return {
    v: 1,
    ts: new Date(2026, m - 1, d, 10).toISOString(),
    prompt,
    corrected: prompt,
    feedback:
      corrections === null
        ? null
        : {
            translation: '',
            corrections: Array.from({ length: corrections }, () => ({
              from: 'a',
              to: 'b',
              why: 'c',
            })),
            revised: prompt,
            revisedTranslation: '',
          },
  };
}

void test('readRecords：跨分片合并、倒序、跳过半行', async () => {
  const directory = nodePath.join(TMP, 'records');
  mkdirSync(directory, { recursive: true });
  const a = rec(10, 1, 'first one here', 0);
  const b = rec(10, 2, 'second one here', 1);
  writeFileSync(nodePath.join(directory, '2026-10-01.jsonl'), `${JSON.stringify(a)}\n{"v":1,"ts`);
  writeFileSync(nodePath.join(directory, '2026-10-02.jsonl'), `${JSON.stringify(b)}\n`);
  const { records, bad } = await readRecords(TMP);
  assert.deepEqual(
    records.map((r) => r.prompt),
    ['second one here', 'first one here'],
  );
  assert.equal(bad, 1);
});

void test('computeStats：按天聚合；没结构化反馈的只算练习量不算准确率', () => {
  const s = computeStats(
    [
      rec(11, 16, 'one two three four', 2),
      rec(11, 16, 'five six', null),
      rec(11, 17, 'seven eight nine', 0),
    ],
    new Date(2026, 10, 17, 20),
  );
  assert.deepEqual(s.days, [
    { day: '2026-11-16', count: 2, scored: 1, words: 4, corrections: 2 },
    { day: '2026-11-17', count: 1, scored: 1, words: 3, corrections: 0 },
  ]);
  assert.deepEqual(s.total, { count: 3, days: 2, corrections: 2, words: 7 });
});

void test('computeStats：连续天数今天没写不算断；最长连续；本周从周一算、不含未来', () => {
  // 2026-11-17 是周二：本周 = 11-16 起，上周 = 11-09 ~ 11-15
  const records = [
    rec(11, 1, 'a b', 0),
    rec(11, 2, 'a b', 0),
    rec(11, 3, 'a b', 0),
    rec(11, 14, 'a b', 1),
    rec(11, 15, 'a b', 0),
    rec(11, 16, 'a b c', 1),
    rec(12, 1, 'a b', 2), // 未来日期（时钟曾被调快）：不进本周
  ];
  const s = computeStats(records, new Date(2026, 10, 17, 9));
  assert.deepEqual(s.streak, { current: 3, longest: 3 });
  assert.deepEqual(s.week.thisWeek, { count: 1, words: 3, corrections: 1 });
  assert.deepEqual(s.week.lastWeek, { count: 2, words: 4, corrections: 1 });
  assert.equal(localDay(new Date(2026, 0, 5)), '2026-01-05');
});
