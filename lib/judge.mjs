/**
 * @module judge
 * 第三步的前半段：把 state + 问题编译成「判断提示」，并把模型交回的判断解析成结构化对象。
 *
 * 这里是**本技能的提示词工程核心**，设计要点有三条，都来自真实 Jev 的失败模式
 * （见 docs/JEV-COMPAT.md 的「官方承认的失败模式」一节）：
 *
 *  1. **只让模型给支持度，不给概率**。实测让 LLM 输出概率会得到假均匀或假自信；
 *     让它输出「相对支持度」则稳定得多，剩下的归一化由引擎做。
 *  2. **要求引用 state 原文**。Jev 的失败模式第一条是「字面理解 + 答案取决于用词」，
 *     所以提示里强制 basis 摘录原文，把「我印象里」挡在外面。
 *  3. **明确禁止引入外部具体事实**。数字、日期、人名是最容易编的部分，
 *     也是本技能最不该编的部分；宁可让概率拉平。
 */

import { squeeze } from './util.mjs';
import { JUDGMENT_SCHEMA } from './schema.mjs';

/** 提示里对每个问题的描述块。 */
function describeQuestion(spec, index) {
  const lines = [`### ${index + 1}. ${spec.id}（${spec.type}）`];
  lines.push(`- instructions：${typeof spec.instructions === 'string' ? spec.instructions : JSON.stringify(spec.instructions)}`);
  if (spec.type === 'choice') {
    lines.push('- criteria（选项 → 描述）：');
    for (const [k, v] of Object.entries(spec.criteria || {})) {
      lines.push(`  - ${k}${v ? `：${v}` : '（无描述）'}`);
    }
    lines.push(`- 请为每个选项给出支持度，键必须正好是：${Object.keys(spec.criteria || {}).join(' / ')}`);
  } else if (spec.type === 'score') {
    lines.push('- criteria（有序等级，从低到高）：');
    (spec.criteria || []).forEach((lv, i) => lines.push(`  - [${i}] ${lv}`));
    lines.push('- 请为每个等级给出支持度，键必须正好是：' + (spec.criteria || []).map((_, i) => String(i)).join(' / '));
  } else {
    lines.push('- 请给出命题为真的概率 p（0–1 之间的小数）。');
    if (spec.criteria?.true) lines.push(`  - true 的含义：${spec.criteria.true}`);
    if (spec.criteria?.false) lines.push(`  - false 的含义：${spec.criteria.false}`);
  }
  if (spec.why) lines.push(`- 这道题为什么这样问：${spec.why}`);
  return lines.join('\n');
}

/** 生成给模型看的输出骨架（既是指示，也是可以直接改的模板）。 */
export function judgmentSkeleton(questions) {
  const answers = {};
  for (const spec of questions) {
    if (spec.type === 'choice') {
      answers[spec.id] = {
        type: 'choice',
        scores: Object.fromEntries(Object.keys(spec.criteria || {}).map((k) => [k, 0])),
        basis: ['支持 <选项>：<state 中的原文摘录> → <为什么这支持它>'],
      };
    } else if (spec.type === 'score') {
      answers[spec.id] = {
        type: 'score',
        scores: Object.fromEntries((spec.criteria || []).map((_, i) => [String(i), 0])),
        basis: ['该状态落在第 <i> 档：<原文摘录> → <判据>'],
      };
    } else {
      answers[spec.id] = {
        type: 'noul',
        p: 0.5,
        basis: ['<支持或不支持该命题的原文摘录与推理>'],
      };
    }
  }
  return { schema: JUDGMENT_SCHEMA, answers };
}

/**
 * 构造判断提示。
 *
 * @param {{state:string, questions:object[], domain:object, judgeHints?:string[], extra?:string}} args
 */
export function buildJudgePrompt({ state, questions, domain, judgeHints = [], extra = '' }) {
  const skeleton = judgmentSkeleton(questions);
  const hints = judgeHints.length
    ? judgeHints.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : '（该领域没有额外判题要点，按上述通用纪律判断。）';

  return `你是「jev」决策引擎的判断层。你的输出不是文章，而是一张**支持度表**，供引擎换算成概率。

## 你要做什么

读下面的 state，针对每个问题，给出**每个选项 / 每个等级 / 命题为真**的「支持度」。

支持度是任意实数，只表达**相对大小**，不要求加起来等于任何值：
- 给 \`3 / 1 / 1\` 表示第一个选项明显更可能；
- 给 \`0 / 0 / 0\` 表示三者无法区分（引擎会算出均匀分布）；
- 给 \`5 / 4.5\` 表示两者非常接近，只差一点。

引擎会对支持度做 softmax。所以**不要为了让答案显得确定而人为拉开没有依据的差距**——
你拉开多少，概率分布就尖多少，而那个「尖」会被写进结果的置信度里，最终被人当成把握程度使用。

## 判断纪律

1. **先找 state 里的直接证据**：原文的句子、数字、条件、限定词。只有当 state 本身不足以判断时，
   才引入该领域的通行知识，并在 basis 里说明「依据的是领域常识而非 state 原文」。
2. **每条依据都要写进 basis**，格式固定为：\`支持 <对象>：<state 中的原文摘录> → <为什么这支持它>\`。
   摘录必须真的出现在 state 里。写不出摘录的依据，就不要写。
3. **矛盾不要拉平了事**：state 里有互相冲突的信息时，分别给出支持度，让分布体现出这种分裂，
   并在 basis 里把冲突写出来。拉平会掩盖最值得注意的信息。
4. **不要引入 state 之外的具体事实**（人名、日期、数字、条款编号）。这些最容易编，
   一旦编错整个结论就是错的。确实需要但拿不准时，把支持度拉平，并在 basis 里写明「无法从 state 确认 X」。
5. **只判不问**：不要要求追问、不要输出建议、不要解释你的方法论，也不要复述题目。
6. **严格输出 JSON**：不要 Markdown 代码块、不要注释、不要任何 JSON 之外的文字。
   不要输出 \`score\`、\`probabilities\`、\`confidence\`——那些是引擎算的，你给了也会被忽略。

## 领域判题要点（${domain?.name || '未知领域'}）

${hints}
${extra ? `\n${extra}\n` : ''}
## 输出格式（严格照此形状）

\`\`\`json
${JSON.stringify(skeleton, null, 2)}
\`\`\`

注意：上面每个分数字段都是占位符，全部由你按判断填写；\`basis\` 里的文字也要换成真实依据。
choice / score 的键绝对不能增删，必须与问题里的选项/等级完全一致。

## state（要被判断的内容）

<state>
${squeeze(state)}
</state>

## 问题

${questions.map((q, i) => describeQuestion(q, i)).join('\n\n')}

现在输出 JSON。`;
}

/** 从模型回复里抠出 JSON：容忍代码块、前后寒暄、且能从第一个 `{` 开始做括号配对。 */
export function parseJudgmentText(text) {
  const raw = String(text ?? '');
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{');
  if (start === -1) throw new Error('模型回复里找不到 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = body.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (error) {
          throw new Error(`模型输出的 JSON 解析失败：${error.message}`);
        }
      }
    }
  }
  throw new Error('模型输出的 JSON 括号不配对（可能被截断）');
}

/**
 * 判断合规性修正：把模型偶发的形状偏差拉回契约。
 *
 * 只做**安全**的修正（缺 schema、字符串数字、题 id 拼错大小写），
 * 不做会改变语义的修正（缺选项一律报错而不是补 0，否则会把模型的遗漏悄悄变成均匀分布）。
 */
export function normalizeJudgment(parsed, questions) {
  const out = { schema: parsed.schema || JUDGMENT_SCHEMA, answers: {} };
  const notes = [];
  const src = parsed.answers || {};
  const byId = new Map(questions.map((q) => [q.id, q]));
  const lowerIndex = new Map(questions.map((q) => [q.id.toLowerCase(), q]));

  for (const [key, value] of Object.entries(src)) {
    let spec = byId.get(key);
    if (!spec) {
      spec = lowerIndex.get(key.toLowerCase());
      if (spec) notes.push(`题 id「${key}」大小写不匹配，已按「${spec.id}」归位。`);
    }
    if (!spec) {
      notes.push(`忽略未知题 id「${key}」。`);
      continue;
    }
    const v = { ...value };
    v.type = v.type || spec.type;
    if (v.scores && typeof v.scores === 'object') {
      const fixed = {};
      for (const [k, s] of Object.entries(v.scores)) {
        const num = typeof s === 'number' ? s : Number(String(s).trim());
        if (Number.isFinite(num)) fixed[k] = num;
      }
      v.scores = fixed;
    }
    if (v.p !== undefined && typeof v.p !== 'number') {
      const num = Number(String(v.p).trim());
      if (Number.isFinite(num)) v.p = num;
    }
    if (typeof v.basis === 'string') v.basis = [v.basis];
    out.answers[spec.id] = v;
  }

  for (const q of questions) {
    if (!(q.id in out.answers)) notes.push(`模型没有回答题目 ${q.id}。`);
  }
  return { judgment: out, notes };
}
