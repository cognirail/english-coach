// =============================================================================
// practice —— 专项练习：按一个错误分类，用他自己写错过的句子当素材出改错题，提交后由模型判分并落盘。
//
// 题型只有一种「改错句」：给一句含一处该类错误的英文（编程协作语境），他写出改好的句子。
// 判分交给模型而不是字符串比对：同一个错可以有几种对的改法。
// 落盘：<dataDir>/practice/<本地日期>.jsonl，一轮一行，只追加；统计按分类汇总正确率。
// =============================================================================
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import {
  CATEGORIES,
  isEnglishCorrection,
  type Category,
  type CoachRecord,
  type Complete,
} from '../daemon/daemon.ts';
import { localDay } from './data.ts';

export const EXERCISES_PER_ROUND = 5;
const MAX_EXAMPLES = 8; // 喂给出题模型的历史错例上限：够它模仿用词习惯，prompt 仍短
const MAX_RULES = 5;
const MAX_RESPONSE = 500; // 单题作答长度上限，挡住误粘贴的大段文字

export interface Exercise {
  sentence: string; // 含一处错误的句子
  answer: string; // 参考改法
  hint: string; // 中文提示：错在哪一类、往哪想，不直接给答案
}

export interface GradedItem extends Exercise {
  response: string;
  correct: boolean;
  feedback: string;
}

export interface PracticeSession {
  v: 1;
  ts: string;
  category: Category;
  items: GradedItem[];
}

export const practiceDirectory = (dataDirectory: string): string =>
  nodePath.join(dataDirectory, 'practice');

export function toCategory(value: unknown): Category | null {
  return CATEGORIES.find((c) => c === value && c !== 'other') ?? null;
}

/** 他在这一类里写错过的句子（新到旧）与出现过的规则（去重），出题和讲解都用它。 */
export function collectMaterial(
  records: CoachRecord[],
  category: Category,
): { examples: { from: string; to: string }[]; rules: string[] } {
  const examples: { from: string; to: string }[] = [];
  const rules = new Set<string>();
  for (const r of records) {
    const corrections = r.feedback?.corrections ?? [];
    for (const c of corrections) {
      if (c.category !== category || !isEnglishCorrection(c)) {
        continue;
      }
      // 同一个错反复犯只列一次，素材和页面上的「你写错过的」才不会被一句刷屏
      if (examples.length < MAX_EXAMPLES && examples.every((example) => example.from !== c.from)) {
        examples.push({ from: c.from, to: c.to });
      }
      if (c.rule !== undefined && rules.size < MAX_RULES) {
        rules.add(c.rule);
      }
    }
  }
  return { examples, rules: [...rules] };
}

// 每类错误的界定：出题模型拿到分类名容易漂到别的错（2026-11-17 实测「用词搭配」出了 3 道逗号连句）
const CATEGORY_SCOPE: Record<Category, string> = {
  tense: '时态：动词时态或形式错（has fix / I check it yesterday）',
  agreement: '主谓一致：主语和谓语单复数不一致（it say / the tests passes）',
  article: '冠词：a / an / the 缺、多或用错',
  preposition: '介词：介词缺、多或用错（depend of / discuss about）',
  plural: '单复数：名词单复数或可数性错（all case / many informations）',
  'word-choice':
    '用词搭配：选错词或动词名词搭配不地道（do a commit / open the bug）；不包括标点和语法结构',
  'word-order': '语序：词或从句位置错（疑问句语序、副词位置）',
  'missing-word': '缺词：少了必需的词（is there anything need → that needs）',
  redundancy: '冗余：多余的重复表达（return back / again repeat）',
  spelling: '拼写：单词拼错',
  punctuation: '标点与大小写：逗号连句、缺问号、句首或专有名词大小写',
  other: '其他',
};

const GENERATE_SYSTEM = [
  '你是英文写作老师，学生是用英文和 AI 编程助手协作的中国软件工程师。',
  `给他出 ${EXERCISES_PER_ROUND} 道改错题，只练用户消息里指定的那一类错误。`,
  '每题一句英文，恰好含一处该类错误，其余部分完全正确，不能混进别类错误；原句必须真的有错。语境用编程协作（提需求、描述 bug、让助手改代码）。',
  '参考他自己写错过的例子模仿他的用词习惯，但不要照抄原句。',
  '只输出 JSON 数组，不加代码围栏，每项 {"sentence": 含错句, "answer": 改好的整句, "hint": 一句中文提示，点出往哪想，不给答案}。',
].join('\n');

const GRADE_SYSTEM = [
  '你是英文写作老师，给改错题判分。输入是 JSON 数组，每项 {"i","sentence": 原错句, "answer": 参考改法, "response": 学生改法}。',
  '学生改法只要把那处错误改对、且没引入新错误就算对，不必和参考改法一字不差；没改或改错算错。',
  '先写点评再判对错，判定必须和点评一致：点评说改对了，correct 就是 true。',
  '只输出 JSON 数组，不加代码围栏，每项 {"i": 同一编号, "feedback": 一句中文点评，错了说清错在哪, "correct": true 或 false}。',
].join('\n');

function sliceJsonArray(text: string): unknown {
  return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export async function generateExercises(
  complete: Complete,
  category: Category,
  material: ReturnType<typeof collectMaterial>,
): Promise<Exercise[]> {
  const user = JSON.stringify({
    category: CATEGORY_SCOPE[category],
    examples: material.examples,
    rules: material.rules,
  });
  const text = await complete(GENERATE_SYSTEM, user, 1500, AbortSignal.timeout(45_000));
  let parsed: unknown;
  try {
    parsed = sliceJsonArray(text);
  } catch {
    throw new Error('出题失败：模型没返回合法 JSON，再试一次');
  }
  const exercises = (Array.isArray(parsed) ? parsed : [])
    .map((item) => item as Record<string, unknown>)
    .filter((item) => isText(item.sentence) && isText(item.answer))
    .map((item) => ({
      sentence: (item.sentence as string).trim(),
      answer: (item.answer as string).trim(),
      hint: isText(item.hint) ? item.hint.trim() : '',
    }))
    .slice(0, EXERCISES_PER_ROUND);
  if (exercises.length === 0) {
    throw new Error('出题失败：模型返回的题目字段不全，再试一次');
  }
  return exercises;
}

/** 校验页面交回来的题目与作答；题目来自本服务出的题，但经过浏览器，仍按不可信输入处理。 */
export function cleanAnswers(body: unknown): {
  category: Category;
  items: (Exercise & { response: string })[];
} {
  const { category, items } = (body ?? {}) as { category?: unknown; items?: unknown };
  const valid = toCategory(category);
  if (valid === null) {
    throw new Error('category 不在可练习的分类里');
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > EXERCISES_PER_ROUND) {
    throw new Error(`items 必须是 1–${EXERCISES_PER_ROUND} 道题`);
  }
  return {
    category: valid,
    items: items.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      if (!isText(item.sentence) || !isText(item.answer) || typeof item.response !== 'string') {
        throw new Error('每道题都要有 sentence / answer / response');
      }
      return {
        sentence: item.sentence,
        answer: item.answer,
        hint: isText(item.hint) ? item.hint : '',
        response: item.response.trim().slice(0, MAX_RESPONSE),
      };
    }),
  };
}

const isSameText = (a: string, b: string): boolean =>
  a.replaceAll(/\s+/g, ' ').trim() === b.replaceAll(/\s+/g, ' ').trim();

/** 空作答或原句没动直接判错不问模型（框里预填了原句，原样交上来 = 没改）；其余一次发给模型，按编号对回。
 *  任一题没拿到布尔判定就整轮报错不落盘：漏判按错计会把答对的题记成错，污染正确率。 */
export async function gradeAnswers(
  complete: Complete,
  items: (Exercise & { response: string })[],
): Promise<GradedItem[]> {
  const asked = items
    .map((item, index) => ({ i: index, ...item }))
    .filter((item) => item.response !== '' && !isSameText(item.response, item.sentence));
  const byIndex = new Map<unknown, Record<string, unknown>>();
  if (asked.length > 0) {
    const payload = asked.map(({ i, sentence, answer, response }) => ({
      i,
      sentence,
      answer,
      response,
    }));
    const text = await complete(
      GRADE_SYSTEM,
      JSON.stringify(payload),
      1200,
      AbortSignal.timeout(45_000),
    );
    try {
      const parsed = sliceJsonArray(text);
      const grades = Array.isArray(parsed) ? parsed : [];
      for (const g of grades) {
        const grade = (g ?? {}) as Record<string, unknown>;
        if (typeof grade.correct === 'boolean') {
          byIndex.set(grade.i, grade);
        }
      }
    } catch {
      throw new Error('判分失败：模型没返回合法 JSON，再交一次');
    }
    if (asked.some(({ i }) => !byIndex.has(i))) {
      throw new Error('判分失败：模型漏判了题目，这轮没记成绩，再交一次');
    }
  }
  return items.map((item, index) => {
    if (item.response === '') {
      return { ...item, correct: false, feedback: '没有作答' };
    }
    if (isSameText(item.response, item.sentence)) {
      return { ...item, correct: false, feedback: '原句没有改动' };
    }
    const g = byIndex.get(index) ?? {};
    return { ...item, correct: g.correct === true, feedback: isText(g.feedback) ? g.feedback : '' };
  });
}

export async function appendSession(
  dataDirectory: string,
  session: PracticeSession,
): Promise<void> {
  const directory = practiceDirectory(dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = nodePath.join(directory, `${localDay(new Date(session.ts))}.jsonl`);
  await appendFile(file, `${JSON.stringify(session)}\n`, { mode: 0o600 });
}

export interface CategoryScore {
  category: Category;
  rounds: number;
  items: number;
  correct: number;
  last: string; // 最近一轮的时间
}

function isSession(value: unknown): value is PracticeSession {
  const s = (value ?? {}) as Record<string, unknown>;
  return (
    toCategory(s.category) !== null &&
    typeof s.ts === 'string' &&
    Array.isArray(s.items) &&
    s.items.every((item) => typeof (item as { correct?: unknown } | null)?.correct === 'boolean')
  );
}

/** 读全部练习记录，按分类汇总正确率；坏行跳过。 */
export async function readScores(dataDirectory: string): Promise<CategoryScore[]> {
  let names: string[] = [];
  try {
    const entries = await readdir(practiceDirectory(dataDirectory));
    names = entries.filter((f) => f.endsWith('.jsonl'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const scores = new Map<Category, CategoryScore>();
  for (const name of names) {
    const text = await readFile(nodePath.join(practiceDirectory(dataDirectory), name), 'utf8');
    for (const line of text.split('\n')) {
      let session: PracticeSession;
      try {
        session = JSON.parse(line) as PracticeSession;
      } catch {
        continue;
      }
      if (!isSession(session)) {
        continue; // 合法 JSON 但结构不对（null、{}、items 里有 null）：同样当坏行
      }
      const s = scores.get(session.category) ?? {
        category: session.category,
        rounds: 0,
        items: 0,
        correct: 0,
        last: '',
      };
      s.rounds++;
      s.items += session.items.length;
      s.correct += session.items.filter((item) => item.correct).length;
      if (session.ts > s.last) {
        s.last = session.ts;
      }
      scores.set(session.category, s);
    }
  }
  return scores
    .values()
    .toArray()
    .toSorted((a, b) => b.last.localeCompare(a.last));
}
