// 记录页：按天分组的完整反馈卡片；?day=YYYY-MM-DD 只看一天（从打卡网格点进来）；搜索框过滤原文与纠错。
import { api, CATEGORY_LABEL, dayOf, el, renderNav, showFatal } from './app.js';

renderNav('/review');

function card(r) {
  const a = el('article');
  a.append(
    el(
      'div',
      'time',
      new Date(r.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    ),
  );
  a.append(el('div', 'label', '原文'), el('div', 'text', r.prompt));
  const f = r.feedback;
  if (f && f.corrections.length) {
    const ol = el('ol');
    for (const c of f.corrections) {
      const li = el('li');
      if (c.category) li.append(el('span', 'tag', CATEGORY_LABEL[c.category] ?? c.category));
      li.append(
        el('del', null, c.from),
        ' → ',
        el('ins', null, c.to),
        ' ',
        el('span', 'why', c.why),
      );
      if (c.rule) li.append(el('div', 'rule', `规则：${c.rule}`));
      ol.append(li);
    }
    a.append(el('div', 'label', '纠错'), ol);
  }
  a.append(el('div', 'label', '修正版'), el('div', 'text', f ? f.revised : r.corrected));
  if (f) {
    const d = el('details');
    d.append(
      el('summary', null, '中译'),
      el('div', 'label', '原文中译'),
      el('div', 'text', f.translation),
      el('div', 'label', '修正版中译'),
      el('div', 'text', f.revisedTranslation),
    );
    a.append(d);
  } else if (r.raw) {
    const d = el('details');
    d.append(el('summary', null, '完整反馈（未结构化）'), el('div', 'text', r.raw));
    a.append(d);
  }
  if (r.error) a.append(el('div', 'warn', `完整反馈失败：${r.error}`));
  a.dataset.search = [
    r.prompt,
    r.corrected,
    f
      ? f.corrections
          .map(
            (c) => `${c.from} ${c.to} ${c.why} ${c.rule ?? ''} ${CATEGORY_LABEL[c.category] ?? ''}`,
          )
          .join(' ')
      : '',
  ]
    .join(' ')
    .toLowerCase();
  return a;
}

function wireSearch(list) {
  document.getElementById('q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const a of list.querySelectorAll('article'))
      a.hidden = q !== '' && !a.dataset.search.includes(q);
    for (const h of list.querySelectorAll('h2')) {
      let n = h.nextElementSibling;
      let any = false;
      while (n && n.tagName === 'ARTICLE') {
        any ||= !n.hidden;
        n = n.nextElementSibling;
      }
      h.hidden = !any;
    }
  });
}

try {
  const { records: all, bad } = await api('/api/records');
  const onlyDay = new URLSearchParams(location.search).get('day');
  const records = onlyDay ? all.filter((r) => dayOf(new Date(r.ts)) === onlyDay) : all;
  document.getElementById('all').hidden = !onlyDay;
  const fixes = records.reduce((s, r) => s + (r.feedback ? r.feedback.corrections.length : 0), 0);
  const days = new Set(records.map((r) => dayOf(new Date(r.ts)))).size;
  document.getElementById('stat').textContent =
    `${onlyDay ? `${onlyDay} · ` : ''}${records.length} 条 · ${days} 天 · ${fixes} 处纠错${bad ? ` · 跳过 ${bad} 行坏数据` : ''}`;
  const list = document.getElementById('list');
  let current = '';
  for (const r of records) {
    const day = dayOf(new Date(r.ts));
    if (day !== current) {
      current = day;
      list.append(el('h2', null, day));
    }
    list.append(card(r));
  }
  if (!records.length) list.append(el('p', 'muted', '这里还没有记录。'));
  wireSearch(list);
} catch (error) {
  showFatal(error);
}
