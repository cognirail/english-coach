import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { readRecords, renderHtml } from './review.ts';

const rec = (ts: string): string =>
  JSON.stringify({ v: 1, ts, prompt: 'p', corrected: 'c', feedback: null });

void test('readRecords：跨分片合并、倒序、跳过半行', async () => {
  const directory = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ec-review-'));
  mkdirSync(nodePath.join(directory, 'records'));
  writeFileSync(
    nodePath.join(directory, 'records', '2026-11-01.jsonl'),
    `${rec('2026-11-01T01:00:00.000Z')}\n{"v":1,"ts`,
  );
  writeFileSync(
    nodePath.join(directory, 'records', '2026-11-02.jsonl'),
    `${rec('2026-11-02T01:00:00.000Z')}\n`,
  );
  const { records, bad } = await readRecords(directory);
  assert.deepEqual(
    records.map((r) => r.ts),
    ['2026-11-02T01:00:00.000Z', '2026-11-01T01:00:00.000Z'],
  );
  assert.equal(bad, 1);
  assert.deepEqual(await readRecords(nodePath.join(directory, 'nope')), { records: [], bad: 0 });
});

void test('renderHtml：记录里的 </script> 不会提前闭合数据块，$ 不被当替换模式', () => {
  const html = renderHtml(
    '<script id="data" type="application/json">__DATA__</script>',
    [{ v: 1, ts: 't', prompt: '</script><b>x $& $1', corrected: 'c', feedback: null }],
    0,
  );
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  assert.ok(html.includes('$& $1'));
});
