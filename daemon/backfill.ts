// =============================================================================
// backfill —— 给 0.3 之前的记录补纠错分类（category）与语法规则（rule），让错误分布和专项练习能用上旧数据。
//
// 用法：node daemon/backfill.ts        只改缺分类的纠错，其余字段与坏行原样保留
// 安全：先建 <数据目录>/migrating 并停掉 daemon、等它写完手头记录退出，迁移期间 daemon 不启动、hook 直接跳过，
//       所以改写分片时没有并发追加；改前把整片原样复制到 records/.backup-0.3/（已存在不覆盖，留的是最早那份）；
//       写临时文件再 rename。
// =============================================================================
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CATEGORIES,
  createComplete,
  DATA_DIR,
  daemonPid,
  loadConfig,
  MIGRATING_PATH,
  recordsDirectory,
  type CoachRecord,
  type Complete,
  type Correction,
} from './daemon.ts';

const CLASSIFY_SYSTEM = [
  '你是英文写作老师。输入是一个 JSON 数组，每项是一条已有的纠错 {"i": 编号, "from","to","why"}。',
  `每条输入恰好输出一项，不拆不合，组成 JSON 数组，每项 {"i": 同一编号, "category": 分类, "rule": 一句中文语法规则}。category 只能取 ${CATEGORIES.join(' / ')} 之一。`,
  'rule 写这条错误背后可推广的规则，不重复 why。只输出 JSON 数组，不加代码围栏或其他文字。',
].join('\n');
const PARALLEL = 4; // 同时在飞的请求数：网关并发友好，38 条约半分钟
const STOP_WAIT_MS = 25_000; // daemon 收 SIGTERM 后最多等 20 秒写完手头反馈，再留 5 秒余量

const isUnlabeled = (r: CoachRecord): boolean =>
  r.feedback?.corrections.some((c) => c.category === undefined) ?? false;

/** 解析模型给的分类数组，按编号 i 对回纠错；模型偶尔把一条拆成几条（2026-11-17 实测 4 条回 6 项），
 *  多出的编号忽略，缺任一编号返回 null，这条记录保持原样。 */
function parseLabels(text: string, corrections: Correction[]): Correction[] | null {
  try {
    const labels = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as unknown;
    if (!Array.isArray(labels)) {
      return null;
    }
    const byIndex = new Map(
      labels.map((l) => [(l as Record<string, unknown>).i, l as Record<string, unknown>]),
    );
    if (corrections.some((_, index) => !byIndex.has(index))) {
      return null;
    }
    return corrections.map((c, index) => {
      const label = byIndex.get(index) ?? {};
      const rule = typeof label.rule === 'string' ? label.rule.trim() : '';
      return {
        ...c,
        category: CATEGORIES.find((k) => k === label.category) ?? 'other',
        ...(rule === '' ? {} : { rule }),
      };
    });
  } catch {
    return null;
  }
}

type Outcome = 'ok' | 'failed';

/** 给一条记录补分类，原地改 record。 */
async function labelRecord(record: CoachRecord, complete: Complete): Promise<Outcome> {
  const feedback = record.feedback;
  if (feedback === null) {
    return 'failed';
  }
  const input = feedback.corrections.map(({ from, to, why }, index) => ({
    i: index,
    from,
    to,
    why,
  }));
  const text = await complete(
    CLASSIFY_SYSTEM,
    JSON.stringify(input),
    1200,
    AbortSignal.timeout(30_000),
  );
  const labeled = parseLabels(text, feedback.corrections);
  if (labeled === null) {
    return 'failed';
  }
  feedback.corrections = labeled;
  return 'ok';
}

/** 有限并发跑完一组任务；单条失败只计数，不中断其余。 */
async function runPool(tasks: (() => Promise<Outcome>)[]): Promise<{ ok: number; failed: number }> {
  const result = { ok: 0, failed: 0 };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const label = tasks[next++] as () => Promise<Outcome>;
      try {
        result[await label()]++;
      } catch {
        result.failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  return result;
}

export interface BackfillResult {
  shards: number;
  labeled: number;
  failed: number;
}

async function backfillShard(
  file: string,
  backupDirectory: string,
  complete: Complete,
): Promise<{ ok: number; failed: number }> {
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  const records = lines.map((line): CoachRecord | null => {
    try {
      return line.trim() === '' ? null : (JSON.parse(line) as CoachRecord);
    } catch {
      return null; // 坏行原样保留
    }
  });
  const todo = records.filter((r): r is CoachRecord => r !== null && isUnlabeled(r));
  if (todo.length === 0) {
    return { ok: 0, failed: 0 };
  }
  const counts = await runPool(todo.map((r) => (): Promise<Outcome> => labelRecord(r, complete)));
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backup = nodePath.join(backupDirectory, nodePath.basename(file));
  // 只留第一次的原文件：已有备份说明之前跑过，那份才是改动前的样子
  try {
    await copyFile(file, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const after = lines.map((line, index) => {
    const r = records[index];
    return r === null || r === undefined ? line : JSON.stringify(r);
  });
  const temporary = `${file}.backfill`;
  await writeFile(temporary, after.join('\n'), { mode: 0o600 });
  await rename(temporary, file);
  return counts;
}

export async function backfill(dataDirectory: string, complete: Complete): Promise<BackfillResult> {
  const directory = recordsDirectory(dataDirectory);
  const backupDirectory = nodePath.join(directory, '.backup-0.3');
  const entries = await readdir(directory);
  const names = entries.filter((f) => f.endsWith('.jsonl')).toSorted((a, b) => a.localeCompare(b));
  const result: BackfillResult = { shards: 0, labeled: 0, failed: 0 };
  for (const name of names) {
    const counts = await backfillShard(nodePath.join(directory, name), backupDirectory, complete);
    if (counts.ok + counts.failed > 0) {
      result.shards++;
      result.labeled += counts.ok;
      result.failed += counts.failed;
    }
  }
  return result;
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 停掉 socket 上的 daemon 并等进程真正退出（退出前它会写完手头的记录）；
 *  再空等 1 秒确认没有建标记前已在启动的 daemon 冒出来。 */
async function stopDaemon(): Promise<void> {
  const deadline = Date.now() + STOP_WAIT_MS;
  for (;;) {
    const pid = await daemonPid();
    if (pid === null) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await daemonPid()) === null) {
        return;
      }
      continue;
    }
    process.kill(pid, 'SIGTERM');
    while (isRunning(pid)) {
      if (Date.now() > deadline) {
        throw new Error(`daemon（pid ${pid}）${STOP_WAIT_MS / 1000} 秒没退出，迁移没开始`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** 建迁移标记（已存在说明有迁移在跑或上次被强杀）→ 停 daemon → 迁移 → 删标记；daemon 下一条 prompt 时由 hook 拉起。 */
async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  try {
    const marker = await open(MIGRATING_PATH, 'wx', 0o600);
    await marker.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${MIGRATING_PATH} 已存在：另一个迁移在跑，或上次被强杀；确认没有在跑后删掉它再试`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await stopDaemon();
    return await work();
  } finally {
    await rm(MIGRATING_PATH, { force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const complete = createComplete(await loadConfig());
  const result = await runExclusive(() => backfill(DATA_DIR, complete));
  process.stdout.write(
    `补分类：${result.labeled} 条记录，失败 ${result.failed} 条（原样保留，可再跑一次），涉及 ${result.shards} 个分片；原文件备份在 records/.backup-0.3/\n`,
  );
}
