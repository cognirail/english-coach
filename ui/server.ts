// =============================================================================
// server —— 看板的本地服务：首页（打卡网格 + 统计）、记录页、设置页，加一组 JSON 接口。
//
// 用法     node ui/server.ts          打开看板：确保服务在跑（见 ensure），再用默认浏览器打开
//          node ui/server.ts ensure   确保服务在跑，不开浏览器（SessionStart 用；纠错提示末行链到它的地址）
//          node ui/server.ts serve    前台跑服务（ensure 内部用）
// 安全     不设登录态：看板只展示本机文件，本机其他账户也能打开（README 写明）。挡的是网页：
//          只监听 127.0.0.1 随机端口；Host 头必须是 127.0.0.1:<端口>（挡 DNS rebinding）；跨源读被同源策略挡；
//          非 GET 接口必须 content-type: application/json，跨站页面发不出（要预检，本服务不应答 CORS），挡 CSRF；
//          页面只有静态外链脚本，CSP 禁内联。设置页不收 key，只显示 key 在哪找到。
// 生命周期 常驻，随会话启动拉起；状态文件 <dataDir>/ui.json（600）记 url 与 pid，供复用；
//          ui.json 不再记自己的 pid（被新服务接替或被删）就退出。
// =============================================================================
import { execFile, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  CONFIG_PATH,
  createComplete,
  DATA_DIR,
  daemonPid,
  DISABLED_PATH,
  getSkipReason,
  keySource,
  uiStatePath,
  resolveConfig,
  SHORT_SYSTEM,
  type Complete,
  type Config,
} from '../daemon/daemon.ts';
import { computeStats, readRecords } from './data.ts';
import {
  appendSession,
  cleanAnswers,
  collectMaterial,
  generateExercises,
  gradeAnswers,
  readScores,
  toCategory,
} from './practice.ts';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = nodePath.join(HERE, 'pages');
const DAEMON_PATH = nodePath.join(HERE, '..', 'daemon', 'daemon.ts');
const STATE_PATH = uiStatePath(DATA_DIR);
const OWNER_CHECK_MS = 10_000; // 被接替后最多这么久退出
// 生命周期协议：ensure 只复用同协议的服务；旧服务（0.3 空闲退出、0.4.0 要 token）会被换掉
const UI_LIFECYCLE = 3;
const MAX_BODY = 64 * 1024;
const execFileAsync = promisify(execFile);

// 白名单路由：只有这些文件能被读到，路径参数不拼进文件系统
const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/review': ['review.html', 'text/html; charset=utf-8'],
  '/practice': ['practice.html', 'text/html; charset=utf-8'],
  '/practice.js': ['practice.js', 'text/javascript; charset=utf-8'],
  '/settings': ['settings.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/index.js': ['index.js', 'text/javascript; charset=utf-8'],
  '/review.js': ['review.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** 设置页能改的字段；空串 = 用默认值（不写进 config.json）。 */
const CONFIG_FIELDS = [
  'provider',
  'model',
  'baseUrl',
  'keychainService',
  'keychainAccount',
  'envKey',
] as const;

export interface UiOptions {
  dataDirectory: string;
  pagesDirectory: string;
  configPath: string;
  disabledPath: string;
  findKey: (config: Config) => Promise<'keychain' | 'env' | null>;
  daemonPid: () => Promise<number | null>;
  restartDaemon: () => Promise<void>;
  probe: (config: Config) => Promise<string>;
  complete: (config: Config) => Complete; // 练习出题与判分用；测试注入假的，不出网
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, '只接受 application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      throw new HttpError(413, '请求体过大');
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

async function readConfigFile(configPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/** 校验设置页提交的配置：只收已知字段的非空字符串；provider / model 交给 resolveConfig，baseUrl 必须是 http(s)。 */
export function cleanConfigInput(body: unknown): Partial<Config> {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, '配置必须是对象');
  }
  const out: Record<string, string> = {};
  for (const field of CONFIG_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new HttpError(400, `${field} 必须是字符串`);
    }
    if (value.trim() !== '') {
      out[field] = value.trim();
    }
  }
  try {
    resolveConfig(out);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return out;
}

async function isEnabled(disabledPath: string): Promise<boolean> {
  try {
    await access(disabledPath);
    return false;
  } catch {
    return true;
  }
}

async function settingsView(options: UiOptions): Promise<unknown> {
  // 只回已知字段：手写进 config.json 的其他字段（哪怕是 key）不出这个进程
  const raw = await readConfigFile(options.configPath);
  const file = Object.fromEntries(
    CONFIG_FIELDS.flatMap((k) => (Object.hasOwn(raw, k) ? [[k, raw[k]]] : [])),
  );
  let resolved: Config | null = null;
  let error: string | null = null;
  try {
    resolved = resolveConfig(file);
  } catch (error_) {
    error = (error_ as Error).message;
  }
  return {
    file,
    resolved,
    error,
    keySource: resolved === null ? null : await options.findKey(resolved),
    enabled: await isEnabled(options.disabledPath),
    daemonPid: await options.daemonPid(),
  };
}

type Route = (req: http.IncomingMessage, options: UiOptions) => Promise<unknown>;

/** 统计与练习只看现行跳过规则下仍会纠错的记录：规则收紧前录进来的粘贴命令等不算练习。记录页仍看全部。 */
async function readCoachable(dataDirectory: string): ReturnType<typeof readRecords> {
  const { records, bad } = await readRecords(dataDirectory);
  return { records: records.filter((r) => getSkipReason(r.prompt) === null), bad };
}

/** 请求体校验失败转 400；其余错误原样上抛。 */
function asBadRequest<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

/** 模型调用失败转 502：页面能区分「我填错了」和「模型那边出问题」。 */
async function viaModel<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new HttpError(502, (error as Error).message);
  }
}

async function modelFor(options: UiOptions): Promise<Complete> {
  return options.complete(resolveConfig(await readConfigFile(options.configPath)));
}

/** 接口表：键为「方法 路径」，值返回 200 的 JSON 体；校验失败抛 HttpError。 */
const ROUTES: Record<string, Route> = {
  'GET /api/stats': async (_req, options) => {
    const { records, bad } = await readCoachable(options.dataDirectory);
    return { ...computeStats(records), bad, recent: records.slice(0, 5) };
  },
  'GET /api/records': (_req, options) => readRecords(options.dataDirectory),
  'GET /api/practice': async (req, options) => {
    const { records } = await readCoachable(options.dataDirectory);
    const category = toCategory(
      new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('category'),
    );
    return {
      categories: computeStats(records).categories.filter((c) => toCategory(c.category) !== null),
      scores: await readScores(options.dataDirectory),
      material: category === null ? null : collectMaterial(records, category),
    };
  },
  'POST /api/practice/generate': async (req, options) => {
    const category = toCategory(((await readBody(req)) as { category?: unknown } | null)?.category);
    if (category === null) {
      throw new HttpError(400, 'category 不在可练习的分类里');
    }
    const { records } = await readCoachable(options.dataDirectory);
    const complete = await modelFor(options);
    const exercises = await viaModel(() =>
      generateExercises(complete, category, collectMaterial(records, category)),
    );
    return { category, exercises };
  },
  'POST /api/practice/grade': async (req, options) => {
    const body = await readBody(req);
    const { category, items } = asBadRequest(() => cleanAnswers(body));
    const complete = await modelFor(options);
    const graded = await viaModel(() => gradeAnswers(complete, items));
    await appendSession(options.dataDirectory, {
      v: 1,
      ts: new Date().toISOString(),
      category,
      items: graded,
    });
    return { category, items: graded, correct: graded.filter((g) => g.correct).length };
  },
  'GET /api/health': () => Promise.resolve({ ok: true, pid: process.pid, lifecycle: UI_LIFECYCLE }),
  'GET /api/settings': (_req, options) => settingsView(options),
  'PUT /api/settings': async (req, options) => {
    const config = cleanConfigInput(await readBody(req));
    await writeFile(options.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await options.restartDaemon(); // daemon 只在启动时读配置
    return settingsView(options);
  },
  'PUT /api/enabled': async (req, options) => {
    const enabled = ((await readBody(req)) as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') {
      throw new HttpError(400, 'enabled 必须是布尔值');
    }
    await (enabled
      ? rm(options.disabledPath, { force: true })
      : writeFile(options.disabledPath, '', { mode: 0o600 }));
    return settingsView(options);
  },
  'POST /api/test': async (_req, options) => {
    const config = resolveConfig(await readConfigFile(options.configPath));
    const started = Date.now();
    try {
      const sample = await options.probe(config);
      return { ok: true, ms: Date.now() - started, sample };
    } catch (error) {
      // 错误文案来自 createComplete：只含 provider + 状态码或「没找到 key」，不含 key
      return { ok: false, ms: Date.now() - started, error: (error as Error).message };
    }
  },
  'POST /api/daemon/restart': async (_req, options) => {
    await options.restartDaemon();
    return settingsView(options);
  },
};

async function respondApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  options: UiOptions,
): Promise<void> {
  try {
    const route = ROUTES[`${req.method ?? ''} ${path}`];
    if (route === undefined) {
      throw new HttpError(404, '没有这个接口');
    }
    sendJson(res, 200, await route(req, options));
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 500, {
      error: (error as Error).message,
    });
  }
}

async function respondStatic(
  res: http.ServerResponse,
  entry: [file: string, type: string],
  options: UiOptions,
): Promise<void> {
  try {
    const body = await readFile(nodePath.join(options.pagesDirectory, entry[0]));
    res.writeHead(200, { 'content-type': entry[1], ...SECURITY_HEADERS });
    res.end(body);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

export function createUiServer(options: UiOptions): http.Server {
  const server = http.createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (req.headers.host !== `127.0.0.1:${port}`) {
      sendJson(res, 421, { error: 'Host 不对' });
      return;
    }
    if (!URL.canParse(req.url ?? '/', 'http://127.0.0.1')) {
      sendJson(res, 400, { error: '请求地址不合法' });
      return;
    }
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path.startsWith('/api/')) {
      if (
        req.method !== 'GET' &&
        !(req.headers['content-type'] ?? '').startsWith('application/json')
      ) {
        sendJson(res, 415, { error: '写接口只收 application/json' });
        return;
      }
      void respondApi(req, res, path, options);
      return;
    }
    const entry = STATIC[path];
    if (entry === undefined || req.method !== 'GET') {
      sendJson(res, 404, { error: '没有这个页面' });
      return;
    }
    void respondStatic(res, entry, options);
  });
  return server;
}

// ---- 真实副作用：daemon 状态与重启、连通测试 ----------------------------------

/** SIGTERM 现有 daemon，等它退出后拉起新的；新进程启动时重新读 config.json。 */
async function restartDaemon(): Promise<void> {
  const pid = await daemonPid();
  if (pid !== null) {
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (await daemonPid()) !== null) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await execFileAsync(process.execPath, [DAEMON_PATH, 'start'], { timeout: 8000 });
}

async function probe(config: Config): Promise<string> {
  const complete = createComplete(config);
  return complete(
    SHORT_SYSTEM,
    'please help me check why this test is fail after I change the config',
    200,
    AbortSignal.timeout(15_000),
  );
}

// ---- 入口 ----------------------------------------------------------------------

interface UiState {
  url: string;
  pid: number;
}

async function readState(): Promise<UiState | null> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as UiState;
  } catch {
    return null;
  }
}

/** 已记录的服务活着时返回它的生命周期协议（旧版没有该字段记 0）；不在返回 null。 */
async function servingLifecycle(state: UiState): Promise<number | null> {
  try {
    const res = await fetch(new URL('/api/health', state.url), {
      signal: AbortSignal.timeout(1000),
    });
    if (res.status === 401) {
      return 0; // 0.4.0 及以前要 token：活着，但是旧协议
    }
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { lifecycle?: unknown };
    return typeof body.lifecycle === 'number' ? body.lifecycle : 0;
  } catch {
    return null;
  }
}

async function serve(): Promise<void> {
  const server = createUiServer({
    dataDirectory: DATA_DIR,
    pagesDirectory: PAGES_DIR,
    configPath: CONFIG_PATH,
    disabledPath: DISABLED_PATH,
    findKey: keySource,
    daemonPid,
    restartDaemon,
    probe,
    complete: createComplete,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/`;
  // 先写临时文件再 rename：读的一方不会看到半个 JSON（ensure 已串行，不会有两个服务抢写）
  const own: UiState = { url, pid: process.pid };
  const temporary = `${STATE_PATH}.${process.pid}`;
  await writeFile(temporary, JSON.stringify(own), { mode: 0o600 });
  await rename(temporary, STATE_PATH);
  process.stdout.write(`english-coach ui ${url}\n`);
  // 常驻不设空闲退出：提示里的链接随时可点。被接替（ui.json 换了 pid 或没了）就退，不留孤儿进程
  setInterval(() => void exitIfReplaced(), OWNER_CHECK_MS).unref();
}

async function exitIfReplaced(): Promise<void> {
  const state = await readState();
  if (state?.pid !== process.pid) {
    process.exit(0);
  }
}

/** 停掉旧协议的服务。端口应答不等于 pid 还是它（服务死后端口和 pid 都可能被别的进程复用），
 *  所以发信号前用 ps 确认这个 pid 跑的就是看板服务；确认不了就不动它。 */
async function stopServer(pid: number): Promise<void> {
  let ps: { stdout: string };
  try {
    ps = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command=']);
  } catch {
    return; // ps 退出码非 0 = 没有这个进程
  }
  if (!/ui\/server\.ts serve\s*$/.test(ps.stdout.trim())) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

const LOCK_STALE_MS = 10_000; // 大于一次 ensure 的最长耗时（起服务等 3 秒）：超过就当持锁进程已崩

/** 锁文件存在多久了；刚被释放（不存在）记 0。 */
async function lockAge(lock: string): Promise<number> {
  try {
    const held = await stat(lock);
    return Date.now() - held.mtimeMs;
  } catch {
    return 0;
  }
}

/** ensure 跨进程串行：两个会话同时启动时只拉起一个服务，后到的等锁后复用它，不会拿到马上被接替的地址。 */
async function withEnsureLock<T>(run: () => Promise<T>): Promise<T> {
  const lock = `${STATE_PATH}.lock`;
  const deadline = Date.now() + LOCK_STALE_MS + 2000;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    if ((await lockAge(lock)) > LOCK_STALE_MS) {
      await rm(lock, { force: true });
    } else if (Date.now() > deadline) {
      throw new Error(`等不到 ${lock}，确认没有卡住的 ensure 后删掉它`);
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await run();
  } finally {
    await rm(lock, { force: true });
  }
}

/** 服务没在跑（或是旧协议的）就后台拉起新的；返回在跑的服务状态。 */
async function ensure(): Promise<UiState> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  return withEnsureLock(ensureLocked);
}

async function ensureLocked(): Promise<UiState> {
  let state = await readState();
  const lifecycle = state === null ? null : await servingLifecycle(state);
  if (state === null || lifecycle !== UI_LIFECYCLE) {
    if (state !== null && lifecycle !== null) {
      await stopServer(state.pid);
    }
    await rm(STATE_PATH, { force: true });
    await mkdir(nodePath.join(DATA_DIR, 'logs'), { recursive: true, mode: 0o700 });
    const log = openSync(nodePath.join(DATA_DIR, 'logs', 'ui.log'), 'a', 0o600);
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
      detached: true,
      stdio: ['ignore', log, log],
    }).unref();
    const deadline = Date.now() + 3000;
    while ((state = await readState()) === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (state === null) {
      throw new Error(`看板服务 3 秒内没起来，看 ${nodePath.join(DATA_DIR, 'logs', 'ui.log')}`);
    }
  }
  return state;
}

async function open(): Promise<void> {
  const state = await ensure();
  await execFileAsync('/usr/bin/open', [state.url]);
  process.stdout.write(`english-coach 看板已打开：${state.url}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'serve') {
      await serve();
    } else if (process.argv[2] === 'ensure') {
      await ensure();
    } else {
      await open();
    }
  } catch (error) {
    process.stderr.write(`english-coach 看板：${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
