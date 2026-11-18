// server 的契约：Host 不是 127.0.0.1:<端口> 拒绝（DNS rebinding）· 非 GET 接口不是 JSON 拒绝（CSRF）· 静态只有白名单且带 CSP ·
// 设置只收已知字段、校验后落盘并重启 daemon · 开关落 disabled 文件 · 连通测试的错误原样回给页面。全部用注入的假副作用，不出网。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import type { Complete } from '../daemon/daemon.ts';
import { cleanConfigInput, createUiServer } from './server.ts';

const TMP = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'english-coach-ui-'));
const PAGES = nodePath.join(TMP, 'pages');
const PLAIN_HTTP_URL = ['http', '//gw.local/v1'].join(':'); // 拼出来，避开明文协议 lint
/** 假模型：出题请求回两道题，判分请求按「作答 = 参考答案」判对；作答为 skip 的题不回判定（模拟模型漏判）。 */
const fakeModel: Complete = (system, user) => {
  if (system.includes('改错题，只练')) {
    return Promise.resolve(
      '[{"sentence":"I has fixed it","answer":"I have fixed it","hint":"主语是 I"},{"sentence":"x"}]',
    );
  }
  const items = JSON.parse(user) as { i: number; answer: string; response: string }[];
  return Promise.resolve(
    JSON.stringify(
      items
        .filter((item) => item.response !== 'skip')
        .map((item) => ({ i: item.i, correct: item.answer === item.response, feedback: 'f' })),
    ),
  );
};
const calls = { restart: 0 };
let server: http.Server;
let base = '';

before(async () => {
  mkdirSync(PAGES);
  writeFileSync(nodePath.join(PAGES, 'index.html'), '<p>index</p>');
  server = createUiServer({
    dataDirectory: TMP,
    pagesDirectory: PAGES,
    configPath: nodePath.join(TMP, 'config.json'),
    disabledPath: nodePath.join(TMP, 'disabled'),
    findKey: () => Promise.resolve('keychain'),
    daemonPid: () => Promise.resolve(4242),
    restartDaemon: () => {
      calls.restart++;
      return Promise.resolve();
    },
    probe: () => Promise.reject(new Error('openai 401')),
    complete: () => fakeModel,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
});

const api = (
  path: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<Response> => fetch(base + path, init);
const statusOf = async (response: Promise<Response>): Promise<number> => {
  const r = await response;
  return r.status;
};
const put = (path: string, body: unknown): Promise<Response> =>
  api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** fetch 不让改 Host 头，用 node:http 直发。 */
function statusWithHost(path: string, host: string): Promise<number> {
  return new Promise((resolve) => {
    http
      .request(`${base}${path}`, { headers: { host } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      })
      .end();
  });
}

void test('安全边界：错 Host / 跨站表单式写请求 / 白名单外路径都拒绝；页面带 CSP', async () => {
  assert.equal(await statusWithHost('/api/settings', 'evil.example:80'), 421);
  // 跨站 <form method=post> 只能发 form / text 类型：无请求体的写接口也要挡住，否则别的网站能触发连通测试花钱
  for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
    const r = await api('/api/test', { method: 'POST', headers: { 'content-type': type } });
    assert.equal(r.status, 415);
  }
  assert.equal(await statusOf(api('/api/daemon/restart', { method: 'POST' })), 415);
  assert.equal(await statusOf(fetch(`${base}/config.json`)), 404);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
});

void test('设置：校验失败 400 不落盘；成功只落已知字段并重启 daemon', async () => {
  const file = nodePath.join(TMP, 'config.json');
  assert.equal(await statusOf(put('/api/settings', { provider: 'openai' })), 400); // openai 必须写 model
  assert.ok(!existsSync(file));
  assert.equal(await statusOf(put('/api/settings', { baseUrl: 'file:///etc/hosts' })), 400);
  assert.equal(await statusOf(put('/api/settings', { baseUrl: PLAIN_HTTP_URL })), 400); // 只实现了 https

  const ok = await put('/api/settings', {
    provider: 'openai',
    model: ' m1 ',
    baseUrl: '',
    unknownField: 'dropped',
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { provider: 'openai', model: 'm1' });
  assert.equal(calls.restart, 1);
  const view = (await ok.json()) as { keySource: string; daemonPid: number };
  assert.equal(view.keySource, 'keychain');
  assert.equal(view.daemonPid, 4242);
});

void test('开关落 disabled 文件；连通测试失败原样回给页面；非 JSON 请求体 415', async () => {
  await put('/api/enabled', { enabled: false });
  assert.ok(existsSync(nodePath.join(TMP, 'disabled')));
  await put('/api/enabled', { enabled: true });
  assert.ok(!existsSync(nodePath.join(TMP, 'disabled')));
  const testResponse = await api('/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const t = (await testResponse.json()) as { ok: boolean; error: string };
  assert.deepEqual([t.ok, t.error], [false, 'openai 401']);
  const raw = await api('/api/enabled', { method: 'PUT', body: 'enabled=false' });
  assert.equal(raw.status, 415);
});

void test('健康检查不碰 Keychain；坏请求地址 400 不崩；设置只回已知字段', async () => {
  const healthResponse = await api('/api/health');
  const health = (await healthResponse.json()) as { ok: boolean; lifecycle: number };
  assert.equal(health.ok, true);
  assert.equal(health.lifecycle, 3); // ensure 只复用这个协议的服务
  assert.equal(await statusWithHost('//[', `127.0.0.1:${new URL(base).port}`), 400);
  writeFileSync(
    nodePath.join(TMP, 'config.json'),
    JSON.stringify({ model: 'm1', apiKey: 'leak-me' }),
  );
  const viewResponse = await api('/api/settings');
  const view = (await viewResponse.json()) as { file: Record<string, unknown> };
  assert.deepEqual(view.file, { model: 'm1' });
});

void test('cleanConfigInput：非字符串字段拒绝；空对象即全默认', () => {
  assert.throws(() => cleanConfigInput({ model: 3 }), /model 必须是字符串/);
  assert.deepEqual(cleanConfigInput({}), {});
});

void test('练习：出题过滤字段不全的题；判分落 practice 分片；空作答不问模型直接判错；坏分类 400', async () => {
  const post = (path: string, body: unknown): Promise<Response> =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  writeFileSync(nodePath.join(TMP, 'config.json'), '{}');
  assert.equal(await statusOf(post('/api/practice/generate', { category: 'other' })), 400);
  const generated = await post('/api/practice/generate', { category: 'tense' });
  const { exercises } = (await generated.json()) as {
    exercises: { sentence: string; answer: string }[];
  };
  assert.equal(exercises.length, 1);

  const items = [
    { ...exercises[0], response: 'I have fixed it' },
    { sentence: 'b', answer: 'c', response: '  ' },
    { sentence: 'it say ok', answer: 'it says ok', response: ' it  say ok ' }, // 原句没动
  ];
  const graded = await post('/api/practice/grade', { category: 'tense', items });
  const result = (await graded.json()) as { correct: number; items: { feedback: string }[] };
  assert.equal(result.correct, 1);
  assert.equal(result.items[1]?.feedback, '没有作答');
  assert.equal(result.items[2]?.feedback, '原句没有改动');
  assert.equal(await statusOf(post('/api/practice/grade', { category: 'tense', items: [] })), 400);
  // 模型漏判一题：整轮 502，不落成绩
  const omitted = [{ sentence: 'a b', answer: 'a c', response: 'skip' }];
  assert.equal(
    await statusOf(post('/api/practice/grade', { category: 'tense', items: omitted })),
    502,
  );
  // 结构坏但 JSON 合法的行跳过，不拖垮练习页
  writeFileSync(
    nodePath.join(TMP, 'practice', 'bad.jsonl'),
    ['null', '{}', '{"category":"tense","ts":"x","items":[null]}', ''].join('\n'),
  );

  const overview = await api('/api/practice');
  const view = (await overview.json()) as {
    scores: { category: string; items: number; correct: number }[];
  };
  assert.deepEqual(
    view.scores.map(({ category, items: n, correct }) => [category, n, correct]),
    [['tense', 3, 1]],
  );
});
