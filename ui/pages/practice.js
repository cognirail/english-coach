// 练习页：选一个错误分类 → 看自己这一类的规则与错例 → 出 5 道改错题 → 交卷由模型判分 → 战绩按分类累计。
import { api, CATEGORY_LABEL, el, renderNav, showFatal } from './app.js';

renderNav('/practice');

const $ = (id) => document.getElementById(id);
let current = null; // 当前分类
// 当前这一轮：出题时绑定分类，交卷用它而不是 current，切分类后旧题的成绩不会记到新分类
let round = { category: null, exercises: [] };
// 每次切分类 / 出题 / 交卷都加一；请求回来时不等于发出时的值就丢弃，旧响应不会覆盖新页面
let epoch = 0;
let busy = false;

/** 请求在飞时锁住会互相打架的按钮（分类、出题、交卷）。 */
function setBusy(value) {
  busy = value;
  $('generate').disabled = value;
  for (const chip of $('chips').querySelectorAll('button')) chip.disabled = value;
}

const pct = (correct, total) => (total ? `${Math.round((correct / total) * 100)}%` : '—');

function renderChips(categories) {
  const box = $('chips');
  box.replaceChildren();
  for (const c of categories) {
    const b = el('button', c.category === current ? 'chip on' : 'chip');
    b.type = 'button';
    b.textContent = `${CATEGORY_LABEL[c.category] ?? c.category} ${c.total}`;
    b.disabled = busy;
    b.addEventListener('click', () => {
      if (busy) return;
      history.replaceState(null, '', `/practice?category=${encodeURIComponent(c.category)}`);
      void load(c.category);
    });
    box.append(b);
  }
}

function renderList(id, items, empty) {
  const box = $(id);
  box.replaceChildren();
  if (!items.length) {
    box.append(el('li', 'muted', empty));
    return;
  }
  for (const item of items) box.append(item);
}

function renderMaterial(material) {
  renderList(
    'rules',
    material.rules.map((r) => el('li', null, r)),
    '这类还没有带规则的记录；新记录会自动带上。',
  );
  renderList(
    'examples',
    material.examples.slice(0, 5).map((e) => {
      const li = el('li');
      li.append(el('del', null, e.from), ' → ', el('ins', null, e.to));
      return li;
    }),
    '这类还没有你的错例。',
  );
}

function renderScores(scores) {
  const box = $('scores');
  box.replaceChildren();
  if (!scores.length) {
    box.append(el('p', 'muted', '还没练过。'));
    return;
  }
  const table = el('table', 'scores');
  const head = el('tr');
  for (const h of ['分类', '轮数', '题数', '正确率', '最近']) head.append(el('th', null, h));
  table.append(head);
  for (const s of scores) {
    const tr = el('tr');
    tr.append(
      el('td', null, CATEGORY_LABEL[s.category] ?? s.category),
      el('td', null, String(s.rounds)),
      el('td', null, String(s.items)),
      el('td', null, pct(s.correct, s.items)),
      el('td', null, new Date(s.last).toLocaleDateString('zh-CN')),
    );
    table.append(tr);
  }
  box.append(table);
}

function resetRound() {
  round = { category: null, exercises: [] };
  $('exercises').replaceChildren();
  $('submit-row').hidden = true;
  $('score').textContent = '';
  $('generate').textContent = '出 5 道题';
}

async function load(category) {
  const mine = ++epoch;
  try {
    const query = category ? `?category=${encodeURIComponent(category)}` : '';
    const data = await api(`/api/practice${query}`);
    if (mine !== epoch) return;
    if (!data.categories.length) {
      $('round-hint').textContent = '还没有可练习的分类：先用英文写几条 prompt 攒点错例。';
      $('generate').disabled = true;
      renderScores(data.scores);
      return;
    }
    // 没指定分类：默认练近 30 天错得最多的那类
    const pick = category ?? [...data.categories].sort((a, b) => b.recent - a.recent)[0].category;
    if (!category) return load(pick);
    current = pick;
    renderChips(data.categories);
    $('round-title').textContent = `改错练习 · ${CATEGORY_LABEL[current] ?? current}`;
    renderMaterial(data.material);
    renderScores(data.scores);
    resetRound();
  } catch (error) {
    showFatal(error);
  }
}

async function generate() {
  if (busy || !current) return;
  const mine = ++epoch;
  const category = current;
  const button = $('generate');
  setBusy(true);
  $('submit').disabled = true;
  button.textContent = '出题中…';
  try {
    const { exercises } = await api('/api/practice/generate', {
      method: 'POST',
      body: { category },
    });
    if (mine !== epoch) return;
    resetRound();
    round = { category, exercises };
    const list = $('exercises');
    for (const e of exercises) {
      const li = el('li');
      const input = el('textarea');
      input.rows = 2;
      input.value = e.sentence; // 预填原句：只改错处，不用重打整句
      const hint = el('details');
      hint.append(el('summary', null, '提示'), el('span', null, e.hint));
      li.append(el('div', 'text', e.sentence), input, e.hint ? hint : '', el('div', 'result'));
      list.append(li);
    }
    $('submit-row').hidden = false;
    $('submit').disabled = false;
    button.textContent = '换一轮';
  } catch (error) {
    if (mine !== epoch) return;
    button.textContent = '出 5 道题';
    $('score').textContent = `出题失败：${error.message}`;
    $('submit-row').hidden = false;
  } finally {
    setBusy(false);
  }
}

async function submit() {
  if (busy || !round.exercises.length) return;
  const mine = ++epoch;
  const { category, exercises } = round;
  const button = $('submit');
  button.disabled = true;
  setBusy(true);
  $('score').textContent = '判分中…';
  const inputs = [...$('exercises').querySelectorAll('textarea')];
  let isGraded = false;
  try {
    const result = await api('/api/practice/grade', {
      method: 'POST',
      body: {
        category,
        items: exercises.map((e, i) => ({ ...e, response: inputs[i].value })),
      },
    });
    if (mine !== epoch) return;
    isGraded = true;
    const boxes = [...$('exercises').querySelectorAll('.result')];
    result.items.forEach((g, i) => {
      const box = boxes[i];
      box.className = g.correct ? 'result good' : 'result bad';
      box.replaceChildren(
        el('div', null, `${g.correct ? '✓ 对' : '✗ 错'}  ${g.feedback}`),
        el('div', 'muted', `参考：${g.answer}`),
      );
      inputs[i].disabled = true;
    });
    $('score').textContent = `本轮 ${result.correct} / ${result.items.length}`;
    const data = await api(`/api/practice?category=${encodeURIComponent(category)}`);
    if (mine === epoch) renderScores(data.scores);
  } catch (error) {
    if (mine !== epoch) return;
    $('score').textContent = isGraded
      ? `成绩已记下，刷新战绩失败：${error.message}`
      : `判分失败：${error.message}`;
    button.disabled = isGraded; // 判分没成功可以重交；已判过不能再交一遍
  } finally {
    setBusy(false);
  }
}

$('generate').addEventListener('click', () => void generate());
$('submit').addEventListener('click', () => void submit());
void load(new URLSearchParams(location.search).get('category'));
