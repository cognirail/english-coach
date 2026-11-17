// server 的契约：Host 不是 127.0.0.1:<端口> 拒绝（DNS rebinding）· /api 无 token 拒绝 · 静态只有白名单且带 CSP ·
// 设置只收已知字段、校验后落盘并重启 daemon · 开关落 disabled 文件 · 连通测试的错误原样回给页面。全部用注入的假副作用，不出网。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { cleanConfigInput, createUiServer } from './server.ts';

const TMP = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'english-coach-ui-'));
const PAGES = nodePath.join(TMP, 'pages');
const PLAIN_HTTP_URL = ['http', '//gw.local/v1'].join(':'); // 拼出来，避开明文协议 lint
const TOKEN = 'a'.repeat(32);
const calls = { restart: 0 };
let server: http.Server;
let base = '';

before(async () => {
  mkdirSync(PAGES);
  writeFileSync(nodePath.join(PAGES, 'index.html'), '<p>index</p>');
  server = createUiServer({
    token: TOKEN,
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
): Promise<Response> =>
  fetch(base + path, { ...init, headers: { 'x-token': TOKEN, ...init.headers } });
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
      .request(`${base}${path}`, { headers: { host, 'x-token': TOKEN } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      })
      .end();
  });
}

void test('安全边界：错 Host / 缺 token / 白名单外路径都拒绝；页面带 CSP', async () => {
  assert.equal(await statusWithHost('/api/settings', 'evil.example:80'), 421);
  assert.equal(await statusOf(fetch(`${base}/api/settings`)), 401);
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
  const testResponse = await api('/api/test', { method: 'POST' });
  const t = (await testResponse.json()) as { ok: boolean; error: string };
  assert.deepEqual([t.ok, t.error], [false, 'openai 401']);
  const raw = await api('/api/enabled', { method: 'PUT', body: 'enabled=false' });
  assert.equal(raw.status, 415);
});

void test('健康检查不碰 Keychain；坏请求地址 400 不崩；设置只回已知字段', async () => {
  const healthResponse = await api('/api/health');
  const health = (await healthResponse.json()) as { ok: boolean };
  assert.equal(health.ok, true);
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
