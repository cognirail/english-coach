// =============================================================================
// review —— 读 <dataDir>/records/*.jsonl，把全部记录内联进一个自包含 HTML（review.html），用默认浏览器打开。
//
// 为什么生成而不开服务：只在看的时候读一次，写入端保持纯追加；不开本地端口，也没有 file:// 下 fetch 被拦的问题。
// 运行：node review/review.ts（/english-coach:review 调它）；--no-open 只生成不打开（测试用）。
// =============================================================================
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR, recordsDirectory, type CoachRecord } from '../daemon/daemon.ts';

const TEMPLATE = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'template.html');

/** 读全部分片；坏行（崩溃留下的半行）跳过并计数。按时间倒序。 */
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

/** 数据放进 application/json 脚本块；转义 < 防止记录里的 </script> 提前闭合。 */
export function renderHtml(template: string, records: CoachRecord[], bad: number): string {
  const data = JSON.stringify({ records, bad }).replaceAll('<', String.raw`\u003c`);
  return template.replace('__DATA__', () => data);
}

async function main(): Promise<void> {
  const { records, bad } = await readRecords(DATA_DIR);
  const out = nodePath.join(DATA_DIR, 'review.html');
  await writeFile(out, renderHtml(await readFile(TEMPLATE, 'utf8'), records, bad), { mode: 0o600 });
  const skipped = bad > 0 ? `（跳过 ${bad} 行坏数据）` : '';
  process.stdout.write(`english-coach: ${records.length} 条记录${skipped} → ${out}\n`);
  if (!process.argv.includes('--no-open')) {
    execFile('/usr/bin/open', [out]);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
