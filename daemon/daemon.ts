// =============================================================================
// english-coach daemon —— 常驻进程：握着到模型 API 的长连接，给 Claude Code 的 UserPromptSubmit hook 做英文纠错。
//
// 为什么常驻：hook 每条消息都是新进程，到 API 的 TCP + TLS 冷启要 0.7–1.5s；复用连接后短改写整单约 1s
//   （2026-10-16 实测：模型 0.8s + 一个来回 0.2s；连接空闲 5 分钟仍可复用）。本进程每 4 分钟向 API 主机发一次
//   心跳保温。
// 通道：anthropic（默认，Messages API）或 openai（任意 OpenAI 兼容的 /chat/completions），见 loadConfig。
// 做什么：监听 unix socket，POST /review（body = hook 的 stdin JSON，取 prompt 字段）→
//   ① 跳过规则（斜杠命令 / 代码块 / 多行粘贴 / 太短 / 中文为主 / 非人输入）→ 204 空响应，hook 不输出
//   ② 同步：短改写（只修语法去冗余，不改句序不删信息）→ 回 hook JSON：
//        additionalContext 给 Claude（原文照发，修正版作旁注，冲突以原文为准），systemMessage 给人看修正版
//   ③ 脱离：完整反馈（原文中译 · 纠错列表 · 修正版 · 修正版中译）追加到 <dataDir>/records/<日期>.jsonl，不阻塞响应
// 运行：node daemon.ts start（SessionStart hook 调：没在跑就脱离拉起一个，等 socket 就绪后退出）；
//   node daemon.ts（前台跑服务）；测试：node --test daemon/daemon.test.ts
// key：先 Keychain（service english-coach / account = 通道名，可在配置里改），再环境变量；首次请求懒加载，
//   读不到回 systemMessage，进程不崩。
// 不走冷启：hook 连不上本进程时先 start 一次再重试，仍不行只提示，不在 hook 里直接调 API。
// 落盘：记录含用户的英文原文与反馈，这是本功能的目的；目录 700。不记 key；上游错误只记状态码与错误类型，不记正文（正文可能回显 key）。
// =============================================================================
import { execFile, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// ENGLISH_COACH_HOME 覆盖数据目录：e2e 用临时目录跑，不污染真实记录
export const DATA_DIR =
  process.env.ENGLISH_COACH_HOME ?? nodePath.join(nodeOs.homedir(), '.english-coach');
export const SOCKET_PATH = nodePath.join(DATA_DIR, 'daemon.sock');
export const CONFIG_PATH = nodePath.join(DATA_DIR, 'config.json');
export const DISABLED_PATH = nodePath.join(DATA_DIR, 'disabled');
const SHORT_TIMEOUT_MS = 7000; // hook 侧 curl -m 9、Claude 侧 timeout 10：留出两层余量
const FULL_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 240_000; // 实测空闲 300s 连接仍在，取 4 分钟
const MIN_WORDS = 8; // 2026-10-16：5 个词的命令句（fix it now please thanks）也被改写，没有学习价值；8 个词起才是完整句
const MAX_LINES = 8;
const MAX_CHARS = 1500; // 约 250 个英文词；再长的单行基本是粘贴的 JSON / 日志，不是手写消息
const CJK_RATIO_SKIP = 0.3; // 按词单位算：汉字数 / HAN_CHARS_PER_WORD 对比英文词数，字符占比会被长 hex / 路径稀释
const HAN_CHARS_PER_WORD = 2; // 现代汉语平均词长约 1.5–2 字（北大 CCL 语料统计口径），取 2 偏向保留英文句
// 英文词 = 不挨数字的字母串：hex id / 带数字的 token（0123abcd…）不算词，否则一串 id 能顶几十个词
const WORD_RE = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z']*(?![A-Za-z0-9])/g;

export const SHORT_SYSTEM = [
  'You are an English editor for a Chinese software engineer who is writing to an AI coding assistant.',
  'Rewrite the message: fix grammar and word choice, remove redundancy.',
  'Keep every piece of information, the sentence order, and all code identifiers, paths, and quoted text exactly as written.',
  'If a part is ambiguous, keep its original wording.',
  'Output only the rewritten message, no preamble.',
].join(' ');

const FULL_SYSTEM = [
  '你是一位给中国软件工程师做英文写作辅导的老师。他用英文给 AI 编程助手写消息。',
  '只输出一个 JSON 对象，不加代码围栏、开场白或结语。四个字段，除 corrections 外都是单个字符串（不是数组）：',
  '"translation"：把他的英文原文逐句翻译成中文，合成一段字符串；写错的地方就按错的意思译，让他看到自己写出来的到底是什么。',
  '"corrections"：数组，每项 {"from": 原片段, "to": 改法, "why": 一句中文原因}。只列真正的错误和明显不地道的表达，不挑风格；没有就给空数组。',
  '"revised"：修正版英文。只修语法和冗余，不改句序，不删信息；代码、路径、引号内文字原样保留。',
  '"revisedTranslation"：修正版的中文翻译。',
].join('\n');

export interface Feedback {
  translation: string;
  corrections: { from: string; to: string; why: string }[];
  revised: string;
  revisedTranslation: string;
}

/** 一条记录 = JSONL 的一行。feedback 解析失败时保留模型原文在 raw，生成失败时记 error。 */
export interface CoachRecord {
  v: 1;
  ts: string;
  prompt: string;
  corrected: string;
  feedback: Feedback | null;
  raw?: string;
  error?: string;
}

function isCorrection(c: unknown): boolean {
  if (typeof c !== 'object' || c === null) {
    return false;
  }
  const { from, to, why } = c as Record<string, unknown>;
  return typeof from === 'string' && typeof to === 'string' && typeof why === 'string';
}

/** 英文词数（规则见 WORD_RE）；统计页按它算每百词错误数。 */
export function countEnglishWords(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

/** 解析完整反馈；模型偶尔包代码围栏，剥掉再解析，字段不全返回 null。 */
export function parseFeedback(text: string): Feedback | null {
  // 用首尾花括号截取，代替剥围栏的正则（后者有回溯风险）；围栏、前后空白一并去掉
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const v = JSON.parse(body) as Partial<Feedback>;
    if (
      typeof v.translation === 'string' &&
      Array.isArray(v.corrections) &&
      v.corrections.every((c) => isCorrection(c)) &&
      typeof v.revised === 'string' &&
      typeof v.revisedTranslation === 'string'
    ) {
      return v as Feedback;
    }
  } catch {
    // 不是 JSON：返回 null，调用方把原文存进 raw，记录不丢
  }
  return null;
}

export type Complete = (
  system: string,
  user: string,
  maxTokens: number,
  signal: AbortSignal,
) => Promise<string>;

interface HookOutput {
  hookSpecificOutput?: { hookEventName: 'UserPromptSubmit'; additionalContext: string };
  systemMessage: string;
}

// ---- 跳过规则 ----------------------------------------------------------------

/** 不该纠错的输入返回原因，该纠错返回 null。 */
export function getSkipReason(prompt: string): string | null {
  const text = prompt.trim();
  if (text === '') {
    return 'empty';
  }
  if (text.startsWith('/') || text.startsWith('!')) {
    return 'command';
  }
  if (
    // usage limit：Claude Code 额度重置后自动发的续跑消息（2026-11 旧记录里出现 3 次）
    /<(task-notification|cross-session-message|system-reminder)\b|\[Artifact comment|^Your claude\.ai usage limit has reset/.test(
      text,
    )
  ) {
    return 'not-human';
  }
  if (text.includes('```')) {
    return 'code-block';
  }
  if (text.length > MAX_CHARS) {
    return 'too-long';
  }
  if (text.split('\n').length > MAX_LINES) {
    return 'paste';
  }
  // 2026-10-19 误触发：URL 的 host / 路径段被数成词，两条 GitHub 链接就凑够 14 个词
  const prose = text.replaceAll(/\S+/g, (token) => (token.indexOf('://', 1) > 0 ? ' ' : token));
  const hanWords = (prose.match(/\p{Script=Han}/gu)?.length ?? 0) / HAN_CHARS_PER_WORD;
  const words = countEnglishWords(prose);
  if (hanWords > 0 && hanWords / (hanWords + words) > CJK_RATIO_SKIP) {
    return 'chinese';
  }
  return words < MIN_WORDS ? 'too-short' : null;
}

// ---- 模型客户端 ----------------------------------------------------------------

export interface Config {
  provider: 'anthropic' | 'openai';
  model: string;
  baseUrl: string;
  keychainService: string;
  keychainAccount: string;
  envKey: string;
}

const PROVIDER_DEFAULTS = {
  // Haiku 5.5：当前最便宜的 Claude；thinking 默认开，短改写显式关掉（见 buildRequest）
  anthropic: {
    model: 'claude-haiku-5-5',
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
  },
  // openai 没有默认模型：各家 OpenAI 兼容端点的模型名不同，必须在配置里写
  openai: { model: '', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
} as const;

function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end--;
  }
  return url.slice(0, end);
}

/** 合并 <dataDir>/config.json 与通道默认值；文件不存在即全用默认（anthropic）。 */
export function resolveConfig(raw: Partial<Config>): Config {
  // config.json 是用户手写的：类型上是联合，运行时可能是任意字符串
  const provider = (raw.provider ?? 'anthropic') as string;
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`config.provider 只能是 anthropic 或 openai，拿到 ${provider}`);
  }
  const d = PROVIDER_DEFAULTS[provider];
  const model = raw.model ?? d.model;
  if (model === '') {
    throw new Error('provider=openai 时必须在 config.json 里写 model');
  }
  const baseUrl = trimTrailingSlash(raw.baseUrl ?? d.baseUrl);
  // 传输只实现了 https；http 端点写进来会让 daemon 起不来
  if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== 'https:') {
    throw new Error(`config.baseUrl 必须是 https:// 开头的合法地址，拿到 ${baseUrl}`);
  }
  return {
    provider,
    model,
    baseUrl,
    keychainService: raw.keychainService ?? 'english-coach',
    keychainAccount: raw.keychainAccount ?? provider,
    envKey: raw.envKey ?? d.envKey,
  };
}

export async function loadConfig(): Promise<Config> {
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Partial<Config>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`读 ${CONFIG_PATH} 失败：${errorMessage(error)}`, { cause: error });
    }
  }
  return resolveConfig(raw);
}

/** 拼一次请求：路径、鉴权头、body。纯函数，便于测试两种通道的形状。 */
export function buildRequest(
  config: Config,
  key: string,
  system: string,
  user: string,
  maxTokens: number,
): { url: URL; headers: Record<string, string>; body: string } {
  if (config.provider === 'anthropic') {
    return {
      url: new URL(`${config.baseUrl}/v1/messages`),
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' }, // Haiku 5.5 默认 effort medium，允许关；改写不需要推理，关掉省一截延迟
        system,
        messages: [{ role: 'user', content: user }],
      }),
    };
  }
  return {
    url: new URL(`${config.baseUrl}/chat/completions`),
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.model,
      max_completion_tokens: maxTokens, // 新模型拒收 max_tokens；兼容端点普遍也认这个名字
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  };
}

/** 从响应体取文本；拒答、空内容都抛错。 */
export function parseResponse(config: Config, text: string): string {
  let content: unknown;
  if (config.provider === 'anthropic') {
    const parsed = JSON.parse(text) as {
      stop_reason?: string;
      content?: { type: string; text?: string }[];
    };
    if (parsed.stop_reason === 'refusal') {
      throw new Error('模型拒答');
    }
    content = parsed.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  } else {
    const parsed = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
    content = parsed.choices?.[0]?.message?.content;
  }
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(`${config.provider} 返回空内容`);
  }
  return content.trim();
}

const execFileAsync = promisify(execFile);

/** 读 Keychain 条目；没有这一项时 security 退出码 44，超时（钥匙串被锁时会弹窗等人）也按「没配」返回空串。 */
async function readKeychain(config: Config): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', config.keychainService, '-a', config.keychainAccount, '-w'],
      { timeout: 2000 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** key 从哪找到的；只给设置页显示来源，不返回 key 本身。 */
export async function keySource(config: Config): Promise<'keychain' | 'env' | null> {
  if ((await readKeychain(config)) !== '') {
    return 'keychain';
  }
  return (process.env[config.envKey]?.trim() ?? '') === '' ? null : 'env';
}

/** 先 Keychain 后环境变量。 */
async function apiKey(config: Config): Promise<string> {
  let key = await readKeychain(config);
  key ||= process.env[config.envKey]?.trim() ?? '';
  if (key === '') {
    throw new Error(
      `没找到 key：Keychain ${config.keychainService}/${config.keychainAccount} 与环境变量 ${config.envKey} 都为空`,
    );
  }
  return key;
}

// 一条消息同时发短改写 + 完整反馈两路请求，保温 2 条连接；第 3 条起冷启（连发间隔 <3s 才会碰到）
const WARM_SOCKETS = 2;
const agent = new https.Agent({ keepAlive: true, maxSockets: WARM_SOCKETS });

export function createComplete(config: Config): Complete {
  // key 缓存跟着这一份配置走：换配置就换实例，不会把旧 provider 的 key 发给新端点
  let cachedKey: string | null = null;
  return async (system, user, maxTokens, signal) => {
    const key = (cachedKey ??= await apiKey(config));
    const { url, headers, body } = buildRequest(config, key, system, user, maxTokens);
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'POST',
          agent,
          signal,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (r) => {
          let text = '';
          r.setEncoding('utf8');
          r.on('data', (chunk: string) => {
            text += chunk;
          });
          r.on('end', () => {
            resolve({ status: r.statusCode ?? 0, text });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    if (res.status === 401) {
      cachedKey = null;
    } // key 换了：下次重读 Keychain
    if (res.status !== 200) {
      // 只带状态码，不带正文和错误码：兼容端点可能在任一字段里回显 key
      throw new Error(`${config.provider} ${res.status}`);
    }
    return parseResponse(config, res.text);
  };
}

/** 并发打 WARM_SOCKETS 次主机根路径（返回什么码都行，只为让连接池里一直有这么多条热连接）。 */
function heartbeat(config: Config): void {
  for (let index = 0; index < WARM_SOCKETS; index++) {
    const request = https
      .get(new URL('/', config.baseUrl), { agent }, (r) => r.resume())
      .on('error', (error) => {
        process.stderr.write(`heartbeat ${error.message}\n`);
      });
    // 绝对截止而非空闲超时：根路径慢慢滴数据也不能一直占着连接池里的位置
    const timer = setTimeout(() => {
      request.destroy();
    }, 5000);
    request.on('close', () => {
      clearTimeout(timer);
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 服务 ----------------------------------------------------------------------

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export const recordsDirectory = (dataDirectory: string): string =>
  nodePath.join(dataDirectory, 'records');

/** 按本地日期分片追加一行 JSON：写入只追加不重读，崩溃最多留半行，读端跳过坏行。 */
async function appendRecord(dataDirectory: string, at: Date, record: CoachRecord): Promise<void> {
  const directory = recordsDirectory(dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    nodePath.join(directory, `${localDate(at)}.jsonl`),
    `${JSON.stringify(record)}\n`,
    {
      mode: 0o600,
    },
  );
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => {
      resolve(text);
    });
    req.on('error', reject);
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body?: HookOutput | Record<string, unknown>,
): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res
    .writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    })
    .end(text);
}

export interface ServerOptions {
  dataDirectory: string;
  complete: Complete;
  now?: () => Date;
}

/** 完整反馈落当天 JSONL；生成失败也写一条带 error 的记录，连写都失败才打 stderr。 */
async function recordFullFeedback(
  options: ServerOptions,
  at: Date,
  prompt: string,
  corrected: string,
): Promise<void> {
  const record: CoachRecord = { v: 1, ts: at.toISOString(), prompt, corrected, feedback: null };
  try {
    const full = await options.complete(FULL_SYSTEM, prompt, 1500, withTimeout(FULL_TIMEOUT_MS));
    record.feedback = parseFeedback(full);
    if (record.feedback === null) {
      record.raw = full;
    }
  } catch (error) {
    record.error = errorMessage(error);
  }
  try {
    await appendRecord(options.dataDirectory, at, record);
  } catch (error) {
    process.stderr.write(`append ${errorMessage(error)}\n`);
  }
}

/** 建 HTTP 服务（不 listen）；complete 可注入便于测试。 */
export function createServer(options: ServerOptions): http.Server {
  const now = options.now ?? ((): Date => new Date());

  return http.createServer((req, res) => {
    void (async (): Promise<void> => {
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, pid: process.pid });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/review') {
        send(res, 404);
        return;
      }
      let prompt: unknown;
      try {
        prompt = (JSON.parse(await readBody(req)) as { prompt?: unknown }).prompt;
      } catch (error) {
        send(res, 400, {
          systemMessage: `english-coach: hook 输入不是 JSON（${errorMessage(error)}）`,
        });
        return;
      }
      if (typeof prompt !== 'string' || getSkipReason(prompt) !== null) {
        send(res, 204);
        return;
      }
      const at = now();
      let corrected: string;
      try {
        corrected = await options.complete(
          SHORT_SYSTEM,
          prompt,
          600,
          withTimeout(SHORT_TIMEOUT_MS),
        );
      } catch (error) {
        send(res, 200, {
          systemMessage: `english-coach: 短改写失败，本条未附修正版（${errorMessage(error)}）`,
        });
        return;
      }
      send(res, 200, {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `english-coach（英文纠错插件，用户已知）：下面是用户这条英文原文的修正版，只用它来理解意图；修正版与原文冲突时以原文为准。不要在回复里评论、复述或致谢这段修正，用户在别处看反馈。\n\n${corrected}`,
        },
        systemMessage: `english-coach 修正版：\n${corrected}\n完整反馈：/english-coach:dashboard`,
      });
      // 脱离响应：完整反馈落当天 JSONL，失败也写一条让人看见
      const pending = recordFullFeedback(options, at, prompt, corrected);
      PENDING.add(pending);
      void pending.finally(() => PENDING.delete(pending));
    })();
  });
}

/** 脱离响应后还在跑的完整反馈；SIGTERM 时等它们写完再退，设置页保存重启不丢记录。 */
const PENDING = new Set<Promise<void>>();
const DRAIN_MS = 20_000; // 完整反馈单次请求上限之上留余量

/** 本机 socket 上的 daemon 是否在应答 /health。 */
function isAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    http
      .get({ socketPath: SOCKET_PATH, path: '/health', timeout: 300 }, (r) => {
        r.resume();
        resolve(r.statusCode === 200);
      })
      .on('error', () => {
        resolve(false);
      })
      .on('timeout', function (this: http.ClientRequest) {
        this.destroy();
      });
  });
}

/** start：已在跑就静默退出；否则脱离拉起一个（detached = 新会话，hook 进程退出不连带杀掉），等 socket 就绪。 */
async function start(): Promise<void> {
  if (await isAlive()) {
    return;
  }
  // 绝对截止：hook 的 15 秒预算里给拉起留约 3 秒（加上首尾两次健康检查各最多 0.3 秒）
  const deadline = Date.now() + 3000;
  await mkdir(nodePath.join(DATA_DIR, 'logs'), { recursive: true, mode: 0o700 });
  const log = openSync(nodePath.join(DATA_DIR, 'logs', 'daemon.log'), 'a', 0o600);
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: ['ignore', log, log],
  }).unref();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(150, deadline - Date.now())));
    if (await isAlive()) {
      return;
    }
  }
  throw new Error(`daemon 3 秒内没起来，看 ${nodePath.join(DATA_DIR, 'logs', 'daemon.log')}`);
}

/**
 * 自愈：两个会话同时 start 时后来者的 rename 会覆盖先来者的 socket 路径，先来者从此没人连得上。
 * 不用 pid 锁文件（用户态锁在崩溃回收时总有竞态），改为以 socket 路径为唯一事实：
 * 每 5 秒问一次路径上应答的是不是自己，不是（或路径没了）就放手，手头的请求做完后自然退出。
 */
function watchOwnership(onReplaced: () => void): void {
  http
    .get({ socketPath: SOCKET_PATH, path: '/health', timeout: 1000 }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => {
        body += chunk;
      });
      r.on('end', () => {
        let pid: unknown;
        try {
          ({ pid } = JSON.parse(body) as { pid?: unknown });
        } catch {
          return; // 应答不是 JSON：不是本程序的 daemon，也不该误杀自己，下一轮再看
        }
        if (pid !== process.pid) {
          onReplaced();
        }
      });
    })
    .on('timeout', function (this: http.ClientRequest) {
      this.destroy(); // 忙到 1 秒没应答不算被替换
    })
    .on('error', (error) => {
      // 路径没了（ENOENT）或有文件没人听（ECONNREFUSED，接管者被 kill -9）都说明路径不是自己的：自己在听就一定连得上
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        onReplaced();
      }
    });
}

async function serve(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700);
  if (await isAlive()) {
    return;
  }
  const config = await loadConfig();
  const server = createServer({ dataDirectory: DATA_DIR, complete: createComplete(config) });
  // 先绑私有路径再 rename 到公共路径：rename 原子替换崩溃残留的旧文件；libuv 关闭 unix socket 时会 unlink 它绑定的路径，
  // 绑私有路径就保证任何进程退出时只删自己那个名字，不会删到公共路径上别人的 socket
  const ownPath = `${SOCKET_PATH}.${process.pid}`;
  await rm(ownPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ownPath, resolve);
  });
  await chmod(ownPath, 0o600);
  await rename(ownPath, SOCKET_PATH);
  process.stdout.write(
    `english-coach daemon listening ${SOCKET_PATH} (${config.provider} ${config.model})\n`,
  );
  heartbeat(config);
  const heartbeatTimer = setInterval(() => {
    heartbeat(config);
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
  const ownershipTimer = setInterval(() => {
    watchOwnership(() => {
      process.stdout.write(`socket 已被另一个 daemon 接管，本进程 ${process.pid} 退出\n`);
      clearInterval(heartbeatTimer);
      clearInterval(ownershipTimer);
      server.close(); // 不再接新连接；手头请求做完后自然退出
    });
  }, 5000);
  ownershipTimer.unref();
  const stop = (): void => {
    server.close();
    void Promise.race([
      Promise.allSettled(PENDING),
      new Promise((r) => setTimeout(r, DRAIN_MS).unref()),
    ]).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// 被测试 import 时不启动；只在 node daemon.ts 直接跑时启动
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'start') {
      await start();
    } else {
      await serve();
    }
  } catch (error) {
    process.stderr.write(`english-coach daemon 启动失败：${errorMessage(error)}\n`);
    process.exit(1);
  }
}
