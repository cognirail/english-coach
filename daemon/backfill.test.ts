// backfill 的契约：只给缺分类的纠错补 category / rule · 坏行与已分类的记录原样保留 · 模型答非所问的记录不动 ·
// 改前备份原分片且第二次跑不覆盖备份。用假 complete，不出网。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { backfill } from './backfill.ts';
import type { Complete } from './daemon.ts';

const TMP = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'english-coach-backfill-'));
after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const record = (prompt: string, corrections: object[]): string =>
  JSON.stringify({
    v: 1,
    ts: '2026-11-01T01:00:00.000Z',
    prompt,
    corrected: prompt,
    feedback: { translation: 't', corrections, revised: prompt, revisedTranslation: 't' },
  });

void test('只补缺分类的纠错；坏行、已分类、模型答错的记录原样保留；备份只留第一次', async () => {
  const directory = nodePath.join(TMP, 'records');
  mkdirSync(directory);
  const file = nodePath.join(directory, '2026-11-01.jsonl');
  const old = { from: 'a idea', to: 'an idea', why: '元音前用 an' };
  const lines = [
    record('needs label', [old]),
    '{"half a line',
    record('already labeled', [{ ...old, category: 'article' }]),
    record('model answers wrong length', [old, old]),
  ];
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  const original = readFileSync(file, 'utf8');
  const complete: Complete = (_system, user) => {
    const n = (JSON.parse(user) as unknown[]).length;
    return Promise.resolve(
      // 1 条：模型多给一项（拆分），按编号对回仍算成功；2 条：缺编号 1，整条不动
      n === 1
        ? '[{"i":0,"category":"article","rule":"元音音素前用 an"},{"i":1,"category":"tense"}]'
        : '[{"i":0,"category":"tense"}]',
    );
  };

  const result = await backfill(TMP, complete);
  assert.deepEqual(result, { shards: 1, labeled: 1, failed: 1 });
  const after = readFileSync(file, 'utf8').split('\n');
  const first = JSON.parse(after[0] ?? '') as { feedback: { corrections: unknown } };
  assert.deepEqual(first.feedback.corrections, [
    { ...old, category: 'article', rule: '元音音素前用 an' },
  ]);
  assert.deepEqual(after.slice(1), [...lines.slice(1), '']);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // 第二次跑：已分类的跳过，答错的那条再试一次；备份仍是最初的原文件
  await backfill(TMP, complete);
  assert.equal(
    readFileSync(nodePath.join(directory, '.backup-0.3', '2026-11-01.jsonl'), 'utf8'),
    original,
  );
});
