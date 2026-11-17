// =============================================================================
// server —— 看板的本地服务：首页（打卡网格 + 统计）、记录页、设置页，加一组 JSON 接口。
//
// 用法     node ui/server.ts          打开看板：有活着的服务就复用，没有就后台拉起一个，再用默认浏览器打开
//          node ui/server.ts serve    前台跑服务（open 内部用）
// 安全     只监听 127.0.0.1 随机端口；Host 头必须是 127.0.0.1:<端口>（挡 DNS rebinding）；
//          /api/* 必须带 x-token（随机 24 字节，经 URL 的 # 片段交给页面，不进服务端日志和 Referer）；
//          页面只有静态外链脚本，CSP 禁内联。设置页不收 key，只显示 key 在哪找到。
// 生命周期 30 分钟没有请求自动退出；状态文件 <dataDir>/ui.json（600）记 url 与 token，供下次复用。
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
  keySource,
  resolveConfig,
  SHORT_SYSTEM,
  SOCKET_PATH,
  type Config,
} from '../daemon/daemon.ts';
import { computeStats, readRecords } from './data.ts';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = nodePath.join(HERE, 'pages');
const DAEMON_PATH = nodePath.join(HERE, '..', 'daemon', 'daemon.ts');
const STATE_PATH = nodePath.join(DATA_DIR, 'ui.json');
// open 时交给浏览器的跳转页：token 写在 600 文件里，不进 /usr/bin/open 的 argv（ps 可见）
const BOOTSTRAP_PATH = nodePath.join(DATA_DIR, 'open.html');
const IDLE_EXIT_MS = 30 * 60_000;
const MAX_BODY = 64 * 1024;
const execFileAsync = promisify(execFile);

// 白名单路由：只有这些文件能被读到，路径参数不拼进文件系统
const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/review': ['review.html', 'text/html; charset=utf-8'],
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
  onRequest?: () => void;
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

/** 接口表：键为「方法 路径」，值返回 200 的 JSON 体；校验失败抛 HttpError。 */
const ROUTES: Record<string, Route> = {
  'GET /api/stats': async (_req, options) => {
    const { records, bad } = await readRecords(options.dataDirectory);
    return { ...computeStats(records), bad, recent: records.slice(0, 5) };
  },
  'GET /api/records': (_req, options) => readRecords(options.dataDirectory),
  'GET /api/health': () => Promise.resolve({ ok: true, pid: process.pid }),
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
    options.onRequest?.();
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

/** 已记录的服务是否还活着且 token 对得上。 */
async function isServing(state: UiState): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/health', state.url), {
      headers: { 'x-token': state.token },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 只删记着自己 pid 的状态文件：并发起了两个服务时，先退出的不能删掉另一个的。 */
async function removeOwnState(): Promise<void> {
  const state = await readState();
  if (state?.pid === process.pid) {
    await rm(STATE_PATH, { force: true });
  }
}

async function serve(): Promise<void> {
  const token = process.env.EC_UI_TOKEN ?? '';
  if (token.length < 32) {
    throw new Error('缺少 EC_UI_TOKEN：请用 node ui/server.ts 打开，不要直接跑 serve');
  }
  let idle: NodeJS.Timeout | undefined;
  const bump = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      void removeOwnState().finally(() => process.exit(0));
    }, IDLE_EXIT_MS);
  };
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
    onRequest: bump,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  bump();
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/`;
  // 先写临时文件再 rename：读的一方不会看到半个 JSON；并发 open 时后写的赢
  const temporary = `${STATE_PATH}.${process.pid}`;
  await writeFile(temporary, JSON.stringify({ url, token, pid: process.pid }), { mode: 0o600 });
  await rename(temporary, STATE_PATH);
  process.stdout.write(`english-coach ui ${url}\n`);
}

async function open(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  let state = await readState();
  if (state === null || !(await isServing(state))) {
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
  const link = `${state.url}#t=${state.token}`;
  await writeFile(
    BOOTSTRAP_PATH,
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${link}">\n`,
    { mode: 0o600 },
  );
  await execFileAsync('/usr/bin/open', [BOOTSTRAP_PATH]);
  process.stdout.write(`english-coach 看板已打开：${state.url}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'serve') {
      await serve();
    } else {
      await open();
    }
  } catch (error) {
    process.stderr.write(`english-coach 看板：${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
