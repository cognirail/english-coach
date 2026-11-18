// 概览：统计卡 + 打卡网格（最近 53 周，周一为每列第一格）+ 最近 5 条。
import { api, CATEGORY_LABEL, dayOf, el, errorRate, fmtRate, renderNav, showFatal } from './app.js';

renderNav('/');

const MIN_SCORED = 3; // 准确率视图：当天少于 3 条有结构化反馈的记录，样本太少，画虚线格不着色
const VOLUME_LEVELS = [1, 3, 6, 10]; // 条数 ≥ 这些值分别进第 1–4 档
const RATE_LEVELS = [10, 5, 2]; // 每百词错误数 ≤ 这些值分别进第 2–4 档，> 10 为第 1 档（越绿越准）

function volumeLevel(count) {
  return VOLUME_LEVELS.filter((n) => count >= n).length;
}
function rateLevel(rate) {
  return 1 + RATE_LEVELS.filter((n) => rate <= n).length;
}

function tile(label, value, sub) {
  const t = el('div', 'card tile');
  t.append(el('div', 'label', label), el('div', 'value', value));
  if (sub) t.append(el('div', 'sub', sub));
  return t;
}

/** 本周对上周：「↑ 进步 / ↓ 退步 / 持平」+ 上周值；任一侧没有数据返回空串。 */
function trend(now, before, lowerIsBetter, format = String) {
  if (now === null || before === null) return '';
  if (now === before) return `持平（上周 ${format(before)}）`;
  const better = lowerIsBetter ? now < before : now > before;
  return `${better ? '↑ 进步' : '↓ 退步'}（上周 ${format(before)}）`;
}

function renderTiles(s) {
  const totalRate = errorRate(s.total.corrections, s.total.words);
  const tw = s.week.thisWeek;
  const lw = s.week.lastWeek;
  const twRate = errorRate(tw.corrections, tw.words);
  const lwRate = errorRate(lw.corrections, lw.words);
  document
    .getElementById('tiles')
    .append(
      tile('总记录', String(s.total.count), `${s.total.days} 天 · ${s.total.corrections} 处纠错`),
      tile('连续打卡', `${s.streak.current} 天`, `最长 ${s.streak.longest} 天`),
      tile('每百词错误', fmtRate(totalRate), '全部记录，越低越好'),
      tile('本周条数', String(tw.count), trend(tw.count, lw.count, false) || `上周 ${lw.count}`),
      tile(
        '本周每百词错误',
        fmtRate(twRate),
        trend(twRate, lwRate, true, fmtRate) || `上周 ${fmtRate(lwRate)}`,
      ),
    );
}

function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function renderHeat(s, mode) {
  const byDay = new Map(s.days.map((d) => [d.day, d]));
  const today = new Date();
  const todayKey = dayOf(today);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const start = addDays(monday, -52 * 7);
  const heat = document.getElementById('heat');
  heat.replaceChildren();

  const months = el('div', 'months');
  const weekdays = el('div', 'weekdays');
  const cells = el('div', 'cells');
  for (const label of ['一', '', '三', '', '五', '', '']) {
    weekdays.append(el('span', null, label));
  }
  let lastMonth = -1;
  let practiced = 0;
  for (let week = 0; week < 53; week++) {
    const first = addDays(start, week * 7);
    months.append(
      el('span', null, first.getMonth() === lastMonth ? '' : `${first.getMonth() + 1}月`),
    );
    lastMonth = first.getMonth();
    for (let d = 0; d < 7; d++) {
      const date = addDays(first, d);
      const key = dayOf(date);
      const stat = byDay.get(key);
      const cell = el(stat ? 'a' : 'span', 'cell');
      if (key > todayKey) {
        cell.classList.add('future');
      } else if (stat) {
        practiced++;
        cell.href = `/review?day=${key}`;
        const rate = errorRate(stat.corrections, stat.words);
        if (mode === 'volume') {
          cell.dataset.l = String(volumeLevel(stat.count));
        } else if (stat.scored >= MIN_SCORED && rate !== null) {
          cell.dataset.l = String(rateLevel(rate));
        } else {
          cell.classList.add('thin');
        }
        cell.dataset.tip = `${key} · ${stat.count} 条 · ${stat.corrections} 处纠错 · 每百词错误 ${fmtRate(rate)}`;
      } else {
        cell.dataset.tip = `${key} · 没有记录`;
      }
      cells.append(cell);
    }
  }
  heat.append(months, weekdays, cells);
  document.getElementById('heat-title').textContent =
    mode === 'volume' ? `过去一年练习了 ${practiced} 天` : '每日准确率（每百词错误数，越绿越准）';

  const legend = document.getElementById('legend');
  legend.replaceChildren();
  if (mode === 'volume') {
    legend.append(el('span', null, '少'));
    for (const l of [0, 1, 2, 3, 4]) {
      const c = el('span', 'cell');
      if (l) c.dataset.l = String(l);
      legend.append(c);
    }
    legend.append(el('span', null, '多'));
  } else {
    const thin = el('span', 'cell thin');
    legend.append(thin, el('span', null, `不足 ${MIN_SCORED} 条`), el('span', null, '　>10'));
    for (const l of [1, 2, 3, 4]) {
      const c = el('span', 'cell');
      c.dataset.l = String(l);
      legend.append(c);
    }
    legend.append(el('span', null, '≤2'));
  }
}

function renderToggle(s) {
  const box = document.getElementById('toggle');
  const buttons = [
    ['volume', '练习量'],
    ['rate', '准确率'],
  ].map(([mode, label]) => {
    const b = el('button', mode === 'volume' ? 'on' : null, label);
    b.addEventListener('click', () => {
      for (const x of buttons) x.classList.toggle('on', x === b);
      renderHeat(s, mode);
    });
    return b;
  });
  box.append(...buttons);
}

function wireTip() {
  const tip = document.getElementById('tip');
  const heat = document.getElementById('heat');
  heat.addEventListener('mouseover', (e) => {
    const text = e.target.dataset?.tip;
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = e.target.getBoundingClientRect();
    tip.style.left = `${Math.max(4, r.left + r.width / 2 - tip.offsetWidth / 2)}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 6}px`;
  });
  heat.addEventListener('mouseleave', () => {
    tip.hidden = true;
  });
}

const PRACTICABLE = (c) => c !== 'other' && c !== 'unlabeled';

function renderCategories(categories) {
  const box = document.getElementById('cats');
  if (!categories.length) {
    box.append(el('p', 'muted', '还没有纠错记录。'));
    return;
  }
  const max = categories[0].total;
  for (const c of categories) {
    const row = el('div', 'bar-row');
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${(c.total / max) * 100}%`; // CSSOM 赋值，不受 CSP 的内联 style 限制
    track.append(fill);
    row.append(
      el('span', 'bar-label', CATEGORY_LABEL[c.category] ?? c.category),
      track,
      el('span', 'bar-num', `${c.total} · ${c.recent}`),
    );
    if (PRACTICABLE(c.category)) {
      const a = el('a', 'bar-act', '练习');
      a.href = `/practice?category=${encodeURIComponent(c.category)}`;
      row.append(a);
    } else {
      row.append(el('span', 'bar-act'));
    }
    box.append(row);
  }
}

function renderTrend(weeks) {
  const box = document.getElementById('trend');
  const rates = weeks.map((w) => errorRate(w.corrections, w.words));
  const max = Math.max(...rates.filter((r) => r !== null), 1);
  weeks.forEach((w, i) => {
    const col = el('div', 'trend-col');
    const rate = rates[i];
    const bar = el('div', rate === null ? 'trend-bar empty' : 'trend-bar');
    bar.style.height = rate === null ? '2px' : `${Math.max(4, (rate / max) * 100)}%`;
    col.title =
      rate === null
        ? `${w.start} 那周没有可算的记录`
        : `${w.start} 那周：${w.count} 条，${w.corrections} 处纠错 / ${w.words} 词`;
    const [, m, d] = w.start.split('-');
    col.append(
      el('span', 'trend-val', fmtRate(rate)),
      el('div', 'trend-plot'),
      el('span', 'trend-day', `${Number(m)}/${Number(d)}`),
    );
    col.querySelector('.trend-plot').append(bar);
    box.append(col);
  });
}

function renderRecent(records) {
  const box = document.getElementById('recent');
  if (!records.length) {
    box.append(el('p', 'muted', '还没有记录：写一条 8 个词以上的英文 prompt 试试。'));
    return;
  }
  for (const r of records) {
    const a = el('article');
    const n = r.feedback ? r.feedback.corrections.length : null;
    a.append(
      el(
        'div',
        'time',
        `${new Date(r.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${n === null ? '无结构化反馈' : `${n} 处纠错`}`,
      ),
      el('div', 'text', r.prompt),
    );
    box.append(a);
  }
  const more = el('a', null, '看全部记录 →');
  more.href = '/review';
  box.append(more);
}

try {
  const s = await api('/api/stats');
  renderTiles(s);
  renderToggle(s);
  renderHeat(s, 'volume');
  wireTip();
  renderCategories(s.categories);
  renderTrend(s.weeks);
  renderRecent(s.recent);
} catch (error) {
  showFatal(error);
}
