// 三个页面共用：token、接口调用、导航、DOM 小工具。只用 textContent 写入：记录是用户原文，含任意字符。

// token 从 /english-coach:dashboard 打开时的 #t=... 拿到，存 localStorage 后立刻从地址栏抹掉。
// localStorage 按 127.0.0.1:<端口> 隔离，服务换端口后旧 token 自然作废。
const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromHash) {
  localStorage.setItem('ec-token', fromHash);
  history.replaceState(null, '', location.pathname + location.search);
}

export async function api(path, init = {}) {
  const headers = { 'x-token': localStorage.getItem('ec-token') ?? '' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
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

export function renderNav(active) {
  const nav = el('nav');
  nav.append(el('span', 'brand', 'english-coach'));
  for (const [href, label] of [
    ['/', '概览'],
    ['/review', '记录'],
    ['/settings', '设置'],
  ]) {
    const a = el('a', href === active ? 'active' : null, label);
    a.href = href;
    nav.append(a);
  }
  document.querySelector('main').prepend(nav);
}

/** 页面级错误：token 失效等，直接告诉人怎么恢复。 */
export function showFatal(error) {
  const p = el('p', 'warn', `加载失败：${error.message}`);
  document.querySelector('main').append(p);
}
