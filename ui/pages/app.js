// 三个页面共用：接口调用、导航、DOM 小工具。只用 textContent 写入：记录是用户原文，含任意字符。

export async function api(path, init = {}) {
  // 写接口一律带 JSON 类型：服务端靠它挡跨站表单（见 server.ts 安全一节）
  const headers = (init.method ?? 'GET') === 'GET' ? {} : { 'content-type': 'application/json' };
  const res = await fetch(path, {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 每百词错误数；没有可算的词返回 null。 */
export const errorRate = (corrections, words) => (words > 0 ? (corrections / words) * 100 : null);
export const fmtRate = (rate) => (rate === null ? '—' : rate.toFixed(1));

/** 纠错分类的中文名；与 daemon/daemon.ts 的 CATEGORIES 同一张表。 */
export const CATEGORY_LABEL = {
  tense: '时态',
  agreement: '主谓一致',
  article: '冠词',
  preposition: '介词',
  plural: '单复数',
  'word-choice': '用词搭配',
  'word-order': '语序',
  'missing-word': '缺词',
  redundancy: '冗余',
  spelling: '拼写',
  punctuation: '标点大小写',
  other: '其他',
  unlabeled: '未分类',
};

export function renderNav(active) {
  const nav = el('nav');
  nav.append(el('span', 'brand', 'english-coach'));
  for (const [href, label] of [
    ['/', '概览'],
    ['/review', '记录'],
    ['/practice', '练习'],
    ['/settings', '设置'],
  ]) {
    const a = el('a', href === active ? 'active' : null, label);
    a.href = href;
    nav.append(a);
  }
  document.querySelector('main').prepend(nav);
}

/** 页面级错误：直接告诉人加载失败的原因。 */
export function showFatal(error) {
  const p = el('p', 'warn', `加载失败：${error.message}`);
  document.querySelector('main').append(p);
}
