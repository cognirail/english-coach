// =============================================================================
// server —— 看板的本地服务：首页（打卡网格 + 统计）、记录页、设置页，加一组 JSON 接口。
//
// 用法     node ui/server.ts          打开看板：确保服务在跑（见 ensure），再用默认浏览器打开
//          node ui/server.ts ensure   确保服务在跑并刷新跳转页 open.html，不开浏览器（SessionStart 用）
//          node ui/server.ts serve    前台跑服务（ensure 内部用）
// 安全     只监听 127.0.0.1 随机端口；Host 头必须是 127.0.0.1:<端口>（挡 DNS rebinding）；
//          /api/* 必须带 x-token（随机 24 字节，经 URL 的 # 片段交给页面，不进服务端日志和 Referer）；
//          页面只有静态外链脚本，CSP 禁内联。设置页不收 key，只显示 key 在哪找到。
// 生命周期 常驻，随会话启动拉起；状态文件 <dataDir>/ui.json（600）记 url 与 token，供复用；
//          ui.json 不再记自己的 pid（被新服务接替或被删）就退出。
// =============================================================================
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  CONFIG_PATH,
  createComplete,
  DATA_DIR,
  DISABLED_PATH,
  getSkipReason,
  keySource,
  OPEN_PAGE_PATH,
  resolveConfig,
  SHORT_SYSTEM,
  SOCKET_PATH,
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
const STATE_PATH = nodePath.join(DATA_DIR, 'ui.json');
const OWNER_CHECK_MS = 10_000; // 并发拉起时跳转页可能指向退出的那个，所有者最多这么久后改回来
// 生命周期协议：ensure 只复用同协议的服务；0.3 及以前的服务（30 分钟空闲退出，health 不带此字段）会被换掉
const UI_LIFECYCLE = 2;
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
  token: string;
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

function isTokenValid(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== 'string') {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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
      if (!isTokenValid(req.headers['x-token'], options.token)) {
        sendJson(res, 401, { error: 'token 不对：从 /english-coach:dashboard 重新打开' });
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

function daemonPid(): Promise<number | null> {
  return new Promise((resolve) => {
    http
      .get({ socketPath: SOCKET_PATH, path: '/health', timeout: 500 }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => {
          body += chunk;
        });
        r.on('end', () => {
          try {
            const { pid } = JSON.parse(body) as { pid?: unknown };
            resolve(typeof pid === 'number' ? pid : null);
          } catch {
            resolve(null);
          }
        });
      })
      .on('timeout', function (this: http.ClientRequest) {
        this.destroy();
      })
      .on('error', () => {
        resolve(null);
      });
  });
}

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
  token: string;
  pid: number;
}

async function readState(): Promise<UiState | null> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as UiState;
  } catch {
    return null;
  }
}

/** 已记录的服务活着且 token 对得上时，返回它的生命周期协议（旧版没有该字段记 0）；不在返回 null。 */
async function servingLifecycle(state: UiState): Promise<number | null> {
  try {
    const res = await fetch(new URL('/api/health', state.url), {
      headers: { 'x-token': state.token },
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { lifecycle?: unknown };
    return typeof body.lifecycle === 'number' ? body.lifecycle : 0;
  } catch {
    return null;
  }
}

const openPage = (state: UiState): string =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${state.url}#t=${state.token}">\n`;

/** 跳转页：token 写在 600 文件里，不进 /usr/bin/open 的 argv（ps 可见），也不进终端输出；临时文件 + rename，读的一方不会看到半页。 */
async function writeOpenPage(state: UiState): Promise<void> {
  const temporary = `${OPEN_PAGE_PATH}.${process.pid}`;
  await writeFile(temporary, openPage(state), { mode: 0o600 });
  await rename(temporary, OPEN_PAGE_PATH);
}

async function serve(): Promise<void> {
  const token = process.env.EC_UI_TOKEN ?? '';
  if (token.length < 32) {
    throw new Error('缺少 EC_UI_TOKEN：请用 node ui/server.ts 打开，不要直接跑 serve');
  }
  const server = createUiServer({
    token,
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
  // 先写临时文件再 rename：读的一方不会看到半个 JSON；并发 open 时后写的赢
  const own: UiState = { url, token, pid: process.pid };
  const temporary = `${STATE_PATH}.${process.pid}`;
  await writeFile(temporary, JSON.stringify(own), { mode: 0o600 });
  await rename(temporary, STATE_PATH);
  process.stdout.write(`english-coach ui ${url}\n`);
  // 常驻不设空闲退出：提示里的链接随时可点。被接替（ui.json 换了 pid 或没了）就退，不留孤儿进程；
  // 仍是所有者就把跳转页改回指向自己（并发拉起时 ensure 可能写的是随后退出的那个）
  setInterval(() => void keepOwnership(own), OWNER_CHECK_MS).unref();
}

async function keepOwnership(own: UiState): Promise<void> {
  const state = await readState();
  if (state?.pid !== process.pid) {
    process.exit(0);
  }
  let current = '';
  try {
    current = await readFile(OPEN_PAGE_PATH, 'utf8');
  } catch {
    // 跳转页不在（被删）：下面重写
  }
  if (current !== openPage(own)) {
    try {
      await writeOpenPage(own);
    } catch (error) {
      process.stderr.write(`跳转页重写失败：${(error as Error).message}\n`); // 下一轮再试
    }
  }
}

/** 停掉旧协议的服务：刚用 token 验过是我们的，pid 可信；验完到这里它恰好自己退了也算达成。 */
function stopServer(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

/** 服务没在跑（或是旧协议的）就后台拉起新的，然后重写跳转页；返回在跑的服务状态。 */
async function ensure(): Promise<UiState> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  let state = await readState();
  const lifecycle = state === null ? null : await servingLifecycle(state);
  if (state === null || lifecycle !== UI_LIFECYCLE) {
    if (state !== null && lifecycle !== null) {
      stopServer(state.pid);
    }
    await rm(STATE_PATH, { force: true });
    await mkdir(nodePath.join(DATA_DIR, 'logs'), { recursive: true, mode: 0o700 });
    const log = openSync(nodePath.join(DATA_DIR, 'logs', 'ui.log'), 'a', 0o600);
    // token 走环境变量不走 argv：argv 在 ps 里对本机其他用户可见
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, EC_UI_TOKEN: randomBytes(24).toString('base64url') },
    }).unref();
    const deadline = Date.now() + 3000;
    while ((state = await readState()) === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (state === null) {
      throw new Error(`看板服务 3 秒内没起来，看 ${nodePath.join(DATA_DIR, 'logs', 'ui.log')}`);
    }
  }
  await writeOpenPage(state);
  return state;
}

async function open(): Promise<void> {
  const state = await ensure();
  await execFileAsync('/usr/bin/open', [OPEN_PAGE_PATH]);
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
