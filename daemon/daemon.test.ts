// daemon.test.ts —— 跳过规则逐条 · /review 的三种响应（跳过 204 / 成功带 additionalContext + systemMessage /
// 短改写失败只回 systemMessage）· 完整反馈脱离响应后追加到当天 JSONL · 两种模型通道的请求与错误形状 · 单实例锁。
// 模型调用用假 complete 注入，不出网。
// 运行：pnpm test
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildRequest,
  createServer,
  getSkipReason,
  parseFeedback,
  parseResponse,
  resolveConfig,
  type CoachRecord,
  type Complete,
} from './daemon.ts';

const TMP = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'english-coach-test-'));
after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const ENGLISH = 'I now suddenly have a idea, is write a cc plugin to help me learn english.';
const FEEDBACK = {
  translation: '我突然有个想法',
  corrections: [{ from: 'a idea', to: 'an idea', why: '元音前用 an' }],
  revised: 'I suddenly have an idea.',
  revisedTranslation: '我突然有个想法。',
};
const FIXED_AT = new Date(2026, 9, 16, 14, 5);

void test('getSkipReason：命令 / 非人输入 / 代码块 / 粘贴 / 中文 / 太短 跳过，普通英文不跳', () => {
  const cases: [string, string | null][] = [
    ['', 'empty'],
    ['/commit now', 'command'],
    ['!ls -la', 'command'],
    ['<task-notification>done</task-notification> please check', 'not-human'],
    [
      'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached.',
      'not-human',
    ],
    ['fix this:\n```ts\nconst a = 1\n```', 'code-block'],
    [
      Array.from({ length: 9 }, (_, index) => `line ${index} of pasted log output here`).join('\n'),
      'paste',
    ],
    ['帮我看看这个 bug 在哪里', 'chinese'],
    // 2026-10-16 误触发：长 hex 把字符占比稀释到 10%，hex 里的字母还被数成词
    [
      '现在还是在显示 instruction，sessionid  0123456789abcdef0123456789abcdef [Image #5]',
      'chinese',
    ],
    ['look at 0123456789abcdef0123456789abcdef please', 'too-short'],
    [
      'https://github.com/cognirail/go-lint-config\nhttps://github.com/cognirail/rust-lint-config',
      'too-short',
    ],
    ['看下这个仓 https://github.com/cognirail/go-lint-config', 'chinese'],
    ['ok go', 'too-short'],
    ['fix it now please thanks', 'too-short'],
    ['please check the launchd config carefully', 'too-short'],
    ['word '.repeat(400), 'too-long'],
    [ENGLISH, null],
    ['please fix the bug in `src/auth.ts` 然后跑测试', null],
  ];
  for (const [input, want] of cases) {
    assert.equal(getSkipReason(input), want, JSON.stringify(input));
  }
});

function fakeComplete(behaviour: 'ok' | 'short-fails' | 'full-fails'): Complete {
  return (system) => {
    const isFull = system.includes('"corrections"');
    if (isFull) {
      return behaviour === 'full-fails'
        ? Promise.reject(new Error('boom-full'))
        : Promise.resolve(JSON.stringify(FEEDBACK));
    }
    return behaviour === 'short-fails'
      ? Promise.reject(new Error('boom-short'))
      : Promise.resolve('I suddenly have an idea.');
  };
}

interface Reply {
  status: number;
  body: string;
}

async function withServer(
  name: string,
  complete: Complete,
  fn: (post: (json: unknown) => Promise<Reply>, dataDirectory: string) => Promise<void>,
): Promise<void> {
  const dataDirectory = nodePath.join(TMP, name);
  mkdirSync(dataDirectory, { recursive: true });
  const sock = nodePath.join(TMP, `${name}.sock`);
  const server = createServer({ dataDirectory, complete, now: (): Date => FIXED_AT });
  await new Promise<void>((r) => server.listen(sock, r));
  const post = (json: unknown): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(json);
      const req = http.request({ socketPath: sock, path: '/review', method: 'POST' }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  try {
    await fn(post, dataDirectory);
  } finally {
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
  }
}

/** 等当天分片出现且非空（appendFile 先建空文件再写入，只等存在会读到空串），解析成记录。 */
async function waitForRecords(dataDirectory: string): Promise<CoachRecord[]> {
  const path = nodePath.join(dataDirectory, 'records', '2026-10-16.jsonl');
  for (let index = 0; index < 20; index++) {
    try {
      const text = readFileSync(path, 'utf8');
      if (text.endsWith('\n')) {
        return text
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as CoachRecord);
      }
    } catch {
      // 还没建出来
    }
    await sleep(50);
  }
  throw new Error(`没等到 ${path}`);
}

void test('/review 成功：additionalContext 给 Claude、systemMessage 给人，完整反馈追加到当天 JSONL', async () => {
  await withServer('ok', fakeComplete('ok'), async (post, dataDirectory) => {
    const r = await post({ prompt: ENGLISH, hook_event_name: 'UserPromptSubmit' });
    assert.equal(r.status, 200);
    const out = JSON.parse(r.body) as {
      hookSpecificOutput: { additionalContext: string };
      systemMessage: string;
    };
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /以原文为准[\s\S]*I suddenly have an idea\./,
    );
    assert.match(
      out.systemMessage,
      /^english-coach 修正版：\nI suddenly have an idea\.\n完整反馈：\/english-coach:review$/,
    );
    const [rec] = await waitForRecords(dataDirectory);
    assert.ok(rec !== undefined);
    assert.equal(rec.prompt, ENGLISH);
    assert.equal(rec.corrected, 'I suddenly have an idea.');
    assert.equal(rec.ts, FIXED_AT.toISOString());
    assert.deepEqual(rec.feedback, FEEDBACK);
  });
});

void test('/review 跳过：中文或命令 → 204 空体', async () => {
  await withServer('skip', fakeComplete('ok'), async (post) => {
    for (const json of [{ prompt: '/help' }, { prompt: '这是中文消息，不用检查' }, { nope: 1 }]) {
      const r = await post(json);
      assert.equal(r.status, 204, JSON.stringify(json));
    }
  });
});

void test('/review 短改写失败：只回 systemMessage，不附 additionalContext', async () => {
  await withServer('short-fails', fakeComplete('short-fails'), async (post) => {
    const r = await post({ prompt: ENGLISH });
    assert.equal(r.status, 200);
    const out = JSON.parse(r.body) as { hookSpecificOutput?: unknown; systemMessage: string };
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, /短改写失败.*boom-short/);
  });
});

void test('/review 完整反馈失败：记录带 error，响应不受影响', async () => {
  await withServer('full-fails', fakeComplete('full-fails'), async (post, dataDirectory) => {
    const r = await post({ prompt: ENGLISH });
    assert.equal(r.status, 200);
    const [rec] = await waitForRecords(dataDirectory);
    assert.ok(rec !== undefined);
    assert.equal(rec.feedback, null);
    assert.equal(rec.error, 'boom-full');
  });
});

void test('parseFeedback：剥代码围栏；非 JSON 或缺字段返回 null', () => {
  assert.deepEqual(parseFeedback(`\`\`\`json\n${JSON.stringify(FEEDBACK)}\n\`\`\``), FEEDBACK);
  assert.equal(parseFeedback('### 原文中译\n...'), null);
  assert.equal(parseFeedback('{"translation":"x"}'), null);
  // 纠错项不合格（null / 缺字段）也返回 null，走 raw 回退；否则记录页渲染到这条会抛错
  assert.equal(parseFeedback(JSON.stringify({ ...FEEDBACK, corrections: [null] })), null);
  assert.equal(
    parseFeedback(JSON.stringify({ ...FEEDBACK, corrections: [{ from: 'a', to: 'b' }] })),
    null,
  );
});

void test('resolveConfig：默认 anthropic + Haiku；openai 不写 model 报错；baseUrl 去尾斜杠', () => {
  const d = resolveConfig({});
  assert.equal(d.provider, 'anthropic');
  assert.equal(d.model, 'claude-haiku-5-5');
  assert.equal(d.keychainAccount, 'anthropic');
  assert.throws(() => resolveConfig({ provider: 'openai' }), /必须在 config.json 里写 model/);
  const o = resolveConfig({ provider: 'openai', model: 'm', baseUrl: 'https://x.test/v1/' });
  assert.equal(o.baseUrl, 'https://x.test/v1');
  assert.equal(o.envKey, 'OPENAI_API_KEY');
});

void test('buildRequest / parseResponse：两种通道的请求形状与取文本', () => {
  const a = resolveConfig({});
  const ra = buildRequest(a, 'k', 'sys', 'hi', 600);
  assert.equal(ra.url.href, 'https://api.anthropic.com/v1/messages');
  assert.equal(ra.headers['x-api-key'], 'k');
  const ba = JSON.parse(ra.body) as Record<string, unknown>;
  assert.deepEqual(ba.thinking, { type: 'disabled' });
  assert.equal(ba.system, 'sys');
  assert.equal(ba.temperature, undefined);
  assert.equal(
    parseResponse(
      a,
      JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: ' ok ' }] }),
    ),
    'ok',
  );
  assert.throws(
    () => parseResponse(a, JSON.stringify({ stop_reason: 'refusal', content: [] })),
    /拒答/,
  );

  const o = resolveConfig({ provider: 'openai', model: 'm' });
  const ro = buildRequest(o, 'k', 'sys', 'hi', 600);
  assert.equal(ro.url.href, 'https://api.openai.com/v1/chat/completions');
  assert.equal(ro.headers.authorization, 'Bearer k');
  assert.equal((JSON.parse(ro.body) as Record<string, unknown>).max_completion_tokens, 600);
  assert.equal(
    parseResponse(o, JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
    'ok',
  );
  assert.throws(() => parseResponse(o, JSON.stringify({ choices: [] })), /空内容/);
});
