/**
 * @module schema
 * 数据契约：固定 JSON 格式的常量、构造器与校验器。
 *
 * 本模块是整个技能的「唯一真相」。任何产物在写出前都必须过一遍 `validate*`，
 * 任何消费者都可以用 `jev verify <file>` 复现同一套检查。
 *
 * 契约分两层：
 *  1. **Jev 兼容层**（`request` / `response`）——与 TypeSafe Jev 的 HTTP 契约逐字段一致，
 *     见 docs/JEV-COMPAT.md。这一层不允许加字段，否则就不再是 Jev。
 *  2. **信封层**（`schema` / `domain` / `questions` / `judgment` / `provenance`）——本技能自有，
 *     记录「是谁、依据什么、按什么公式」算出这个答案，用于审计与复用。
 */

export const SCHEMA_ID = 'jev/decision@1';
export const QUESTION_SET_SCHEMA = 'jev/questions@1';
export const JUDGMENT_SCHEMA = 'jev/judgment@1';
export const DOMAIN_SCHEMA = 'jev/domain@1';
export const KIND = 'decision';

/** 三种题型，与 Jev 的 `type` 取值一一对应。 */
export const QUESTION_TYPES = ['choice', 'score', 'noul'];

/**
 * 硬限制。
 *
 * ⚠️ `choice.max` 是本技能的规格（4），**不是** Jev 的限制——Jev 官方文档写的是最多 255 个选项
 * （见 docs/JEV-COMPAT.md）。放宽用 `--max-options`，放宽后产物里会记录实际用的上限。
 */
export const LIMITS = Object.freeze({
  choice: Object.freeze({ min: 2, max: 4 }),
  score: Object.freeze({ min: 2, max: 10 }),
  noul: Object.freeze({ min: 0, max: 0 }),
});

export const GENERATOR = Object.freeze({
  name: 'jev-skill',
  version: '0.1.0',
});

/** 引擎参数：改这些数会改变松紧，必须同步 docs/DESIGN.md 与测试。 */
export const ENGINE_TUNING = Object.freeze({
  /** softmax 温度：>1 更平（更保守），<1 更尖（更自信）。 */
  softmax_temperature: 1,
  /** 置信度权重：confidence = marginWeight·归一化优势 + (1-marginWeight)·(1-归一化熵) */
  confidence_margin_weight: 0.75,
  /** 概率四舍五入到几位小数；Jev 官方示例给到 2 位。 */
  probability_digits: 4,
  confidence_digits: 4,
  score_digits: 4,
});

export class SchemaError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'SchemaError';
    this.issues = issues;
  }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/* ------------------------------------------------------------------ *
 * 题型级校验
 * ------------------------------------------------------------------ */

/**
 * 校验一个题目规格（信封层 `questions[]` 的元素，同时也是 Jev `questions` 的值 + 少量元数据）。
 *
 * 规则分两级：
 *  - `errors`   → 违反 Jev 契约或数学上不可能（如 5 个选项超出上限、score 只有 1 档），必须修。
 *  - `warnings` → 会让模型判错但不会崩（如选项描述缺失、等级不可比、一个题里问了两个问题）。
 *
 * @param {object} q 题目规格
 * @param {{maxOptions?: number, knownTypes?: string[]}} [opts]
 */
export function validateQuestion(q, opts = {}) {
  const maxOptions = opts.maxOptions ?? LIMITS.choice.max;
  const errors = [];
  const warnings = [];

  if (!isPlainObject(q)) {
    return { ok: false, errors: ['题目必须是对象'], warnings };
  }
  if (!isNonEmptyString(q.id)) errors.push('缺少 id');
  if (!QUESTION_TYPES.includes(q.type)) {
    errors.push(`type 必须是 ${QUESTION_TYPES.join(' / ')} 之一，收到 ${JSON.stringify(q.type)}`);
    return { ok: false, errors, warnings };
  }
  if (!isNonEmptyString(q.instructions) && !isPlainObject(q.instructions) && !Array.isArray(q.instructions)) {
    errors.push('缺少 instructions');
  }

  if (q.type === 'choice') {
    const criteria = q.criteria;
    if (!isPlainObject(criteria)) {
      errors.push('choice 必须有 criteria 对象（选项名 → 选项描述）');
    } else {
      const names = Object.keys(criteria);
      if (names.length < LIMITS.choice.min) errors.push(`choice 至少 ${LIMITS.choice.min} 个选项，收到 ${names.length}`);
      if (names.length > maxOptions) errors.push(`choice 最多 ${maxOptions} 个选项，收到 ${names.length}（--max-options 可放宽）`);
      const seen = new Set();
      for (const name of names) {
        const key = name.trim().toLowerCase();
        if (seen.has(key)) warnings.push(`选项名重复（忽略大小写）：${name}`);
        seen.add(key);
        const desc = criteria[name];
        if (desc !== undefined && desc !== null && typeof desc !== 'string') {
          warnings.push(`选项 ${name} 的描述不是字符串，Jev 会原样发送，请确认是有意为之`);
        }
        if (desc === null || desc === undefined) {
          warnings.push(`选项 ${name} 没有描述：Jev 官方建议「描述性 criteria 比光秃秃的标签要好判」，标签本身够清楚时才可以省`);
        }
      }
      const lowered = names.map((n) => n.toLowerCase());
      const hasOther = lowered.some((n) => /other|none of the above|其他|以上都不是|都不对/.test(n));
      // 「其他」这条只对**归类型**题目成立：数学/英语的答案型四选一里，「其他」是错误选项。
      // 所以靠题目自带的 kind 标记（模板给的）来区分，而不是靠猜选项文字。
      if (!hasOther && q.kind === 'classify') {
        warnings.push('归类型题目里没有「其他 / 以上都不是」：模型遇到集合之外的类别时没有退路，只能硬选一个错的');
      }
    }
  }

  if (q.type === 'score') {
    const levels = q.criteria;
    if (!Array.isArray(levels)) {
      errors.push('score 必须有 criteria 数组（有序等级，从低到高）');
    } else {
      if (levels.length < LIMITS.score.min) errors.push(`score 至少 ${LIMITS.score.min} 个等级，收到 ${levels.length}`);
      if (levels.length > LIMITS.score.max) errors.push(`score 最多 ${LIMITS.score.max} 个等级，收到 ${levels.length}`);
      levels.forEach((lv, i) => {
        if (!isNonEmptyString(lv)) errors.push(`第 ${i} 个等级不是非空字符串`);
      });
      for (let i = 1; i < levels.length; i++) {
        if (isNonEmptyString(levels[i]) && levels[i] === levels[i - 1]) {
          errors.push(`第 ${i - 1} 与第 ${i} 个等级文字完全相同，等级必须互斥`);
        }
      }
      if (levels.length >= 3) {
        const bare = levels.filter((lv) => typeof lv === 'string' && lv.trim().length <= 2).length;
        if (bare > 0) {
          warnings.push(`有 ${bare} 个等级只有 1–2 个字：等级太短时模型分不清相邻档，建议写成「程度词 + 判据」`);
        }
      }
    }
  }

  if (q.type === 'noul') {
    const criteria = q.criteria;
    if (criteria !== undefined && criteria !== null) {
      if (!isPlainObject(criteria)) {
        errors.push('noul 的 criteria 若存在，必须是对象');
      } else {
        for (const key of Object.keys(criteria)) {
          if (key !== 'true' && key !== 'false') {
            errors.push(`noul 的 criteria 只允许 true / false 两个键，收到 ${JSON.stringify(key)}`);
          }
        }
      }
    }
    // 判断题最容易犯的错：把「和/或」写进命题 → 一个题里其实问了 N 个问题。
    if (typeof q.instructions === 'string') {
      const compound = q.instructions.match(/(并且|同时|而且|以及|和|且|或者|或是|还是|and|or)\s*[^\s，。？?]/g);
      if (compound && compound.length > 0 && /？|\?/.test(q.instructions)) {
        warnings.push('判断题里出现「和/以及/或」这类连接词：Jev 的建议是一个调用一个问题，「A 和 B 都成立吗」应拆成两个 noul');
      }
    }
  }

  if (typeof q.instructions === 'string') {
    const marks = (q.instructions.match(/[？?]/g) || []).length;
    if (marks > 1) warnings.push('instructions 里有多个问号：一个题只问一件事');
    if (/(说明理由|解释|为什么|并给出|请分析|理由是)/.test(q.instructions)) {
      warnings.push('instructions 里要求解释或给理由：Jev 不返回文本，只返回概率，这类要求会被忽略（理由应写在 state 或 basis 里）');
    }
    if (/(正确|错误|对的|不对)\s*[的是]?\s*[:：]/.test(q.instructions)) {
      warnings.push('instructions 里可能泄漏了答案（出现「正确的是：」这类字样），会把题变成抄写题');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ *
 * Jev 兼容层校验
 * ------------------------------------------------------------------ */

/** 校验一个 Jev 请求体：{ model, state, questions } */
export function validateJevRequest(body, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(body)) return { ok: false, errors: ['请求体必须是对象'], warnings };
  if (!isNonEmptyString(body.model)) errors.push('请求体缺少 model');
  if (body.state === undefined || body.state === null) errors.push('请求体缺少 state');
  if (!isPlainObject(body.questions)) {
    errors.push('请求体缺少 questions 对象');
    return { ok: false, errors, warnings };
  }
  const keys = Object.keys(body.questions);
  if (keys.length === 0) errors.push('questions 不能为空');
  for (const key of keys) {
    const r = validateQuestion({ ...body.questions[key], id: key }, opts);
    errors.push(...r.errors.map((e) => `questions.${key}: ${e}`));
    warnings.push(...r.warnings.map((w) => `questions.${key}: ${w}`));
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 校验一个 Jev 答案对象。这是**唯一允许出现的三种形状**：
 *
 * ```json
 * { "type": "noul",   "noul": 0.93 }
 * { "type": "choice", "choice": "returns", "confidence": 0.42, "probabilities": {"returns": 0.61, ...} }
 * { "type": "score",  "score": 1.43, "confidence": 0.35, "legend": {"0": "…"}, "probabilities": {"0": 0.0, ...} }
 * ```
 *
 * 与 TypeSafe 官方文档逐字段对齐；概率之和必须为 1（容差 1e-6）。
 */
export function validateJevAnswer(answer, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(answer)) return { ok: false, errors: ['答案必须是对象'], warnings };
  if (!QUESTION_TYPES.includes(answer.type)) {
    return { ok: false, errors: [`答案 type 非法：${JSON.stringify(answer.type)}`], warnings };
  }

  const checkProbabilities = (probs, expectedKeys, label) => {
    if (!isPlainObject(probs)) {
      errors.push(`${label} 必须是对象`);
      return;
    }
    const keys = Object.keys(probs);
    if (expectedKeys && keys.length !== expectedKeys.length) {
      errors.push(`${label} 的键数 ${keys.length} 与题目选项数 ${expectedKeys.length} 不一致`);
    }
    for (const k of keys) {
      const v = probs[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        errors.push(`${label}.${k} 必须是 0–1 之间的数，收到 ${JSON.stringify(v)}`);
      }
    }
    const total = Object.values(probs).reduce((a, b) => a + (Number(b) || 0), 0);
    if (Math.abs(total - 1) > 1e-6) errors.push(`${label} 之和为 ${total}，必须等于 1`);
  };

  if (answer.type === 'noul') {
    const extra = Object.keys(answer).filter((k) => !['type', 'noul'].includes(k));
    if (extra.length) warnings.push(`noul 答案不应携带额外字段（Jev 里 noul 没有 confidence）：${extra.join(', ')}`);
    if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      errors.push(`noul 必须是 0–1 之间的数，收到 ${JSON.stringify(answer.noul)}`);
    }
  }

  if (answer.type === 'choice') {
    if (!isNonEmptyString(answer.choice)) errors.push('choice 答案缺少 choice');
    if (typeof answer.confidence !== 'number' || answer.confidence < 0 || answer.confidence > 1) {
      errors.push(`choice 答案的 confidence 必须是 0–1 之间的数，收到 ${JSON.stringify(answer.confidence)}`);
    }
    checkProbabilities(answer.probabilities, opts.options, 'choice 的 probabilities');
    if (isPlainObject(answer.probabilities) && isNonEmptyString(answer.choice)) {
      const keys = Object.keys(answer.probabilities);
      const best = keys.reduce((a, b) => (answer.probabilities[a] >= answer.probabilities[b] ? a : b), keys[0]);
      if (best !== answer.choice) errors.push(`choice=${answer.choice} 不是概率最大的选项（最大是 ${best}）`);
    }
    if (opts.options && isPlainObject(answer.probabilities)) {
      for (const opt of opts.options) {
        if (!(opt in answer.probabilities)) errors.push(`choice 的 probabilities 缺少选项 ${opt}`);
      }
    }
  }

  if (answer.type === 'score') {
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) {
      errors.push('score 答案缺少数值型 score');
    }
    if (typeof answer.confidence !== 'number' || answer.confidence < 0 || answer.confidence > 1) {
      errors.push(`score 答案的 confidence 必须是 0–1 之间的数，收到 ${JSON.stringify(answer.confidence)}`);
    }
    checkProbabilities(answer.probabilities, opts.levels, 'score 的 probabilities');
    if (!isPlainObject(answer.legend)) {
      errors.push('score 答案缺少 legend（等级序号 → 等级描述）');
    } else if (opts.levels) {
      for (let i = 0; i < opts.levels.length; i++) {
        if (answer.legend[String(i)] !== opts.levels[i]) {
          errors.push(`legend["${i}"] 应为 ${JSON.stringify(opts.levels[i])}，收到 ${JSON.stringify(answer.legend[String(i)])}`);
        }
      }
    }
    if (isPlainObject(answer.probabilities) && typeof answer.score === 'number') {
      const expect = Object.entries(answer.probabilities).reduce((acc, [k, p]) => acc + Number(k) * p, 0);
      if (Math.abs(expect - answer.score) > 0.011) {
        errors.push(`score=${answer.score} 与概率加权期望 ${expect.toFixed(4)} 不符（Jev 的 score 是概率加权值）`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验一个 Jev 响应体：{ model, answers, usage } */
export function validateJevResponse(resp, questionSpecs = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(resp)) return { ok: false, errors: ['响应必须是对象'], warnings };
  for (const key of ['model', 'answers', 'usage']) {
    if (!(key in resp)) errors.push(`响应缺少 ${key}`);
  }
  if (!isPlainObject(resp.answers)) {
    errors.push('响应缺少 answers 对象');
    return { ok: false, errors, warnings };
  }
  for (const [id, answer] of Object.entries(resp.answers)) {
    const spec = questionSpecs[id];
    if (spec && spec.type && answer?.type && spec.type !== answer.type) {
      errors.push(`answers.${id}: 答案 type 是 ${answer.type}，但题目是 ${spec.type}`);
    }
    const opts = spec?.type === 'choice'
      ? { options: Object.keys(spec.criteria || {}) }
      : spec?.type === 'score'
        ? { levels: spec.criteria || [] }
        : {};
    const r = validateJevAnswer(answer, opts);
    errors.push(...r.errors.map((e) => `answers.${id}: ${e}`));
    warnings.push(...r.warnings.map((w) => `answers.${id}: ${w}`));
  }
  for (const id of Object.keys(questionSpecs)) {
    if (!(id in resp.answers)) errors.push(`answers 缺少题目 ${id}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ *
 * 信封层
 * ------------------------------------------------------------------ */

/**
 * 构造固定的决策信封。缺字段直接抛错，避免「静默产出半成品」。
 *
 * 字段固定为十个，顺序也固定（便于 diff）：
 * `schema / kind / generated_at / generator / domain / questions / request / response /
 *  judgment / derivation / consistency / provenance`
 */
export function makeEnvelope({
  generatedAt,
  domain,
  questions,
  request,
  response,
  judgment,
  derivation = null,
  consistency = null,
  provenance,
}) {
  const doc = {
    schema: SCHEMA_ID,
    kind: KIND,
    generated_at: generatedAt,
    generator: { ...GENERATOR },
    domain,
    questions,
    request,
    response,
    judgment,
    derivation,
    consistency,
    provenance,
  };
  const r = validateDecision(doc);
  if (!r.ok) throw new SchemaError(`决策信封未通过校验：\n  - ${r.errors.join('\n  - ')}`, r.errors);
  return doc;
}

/** 校验完整的决策信封（`jev verify` 用的就是它）。 */
export function validateDecision(doc) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(doc)) return { ok: false, errors: ['产物必须是对象'], warnings };

  if (doc.schema !== SCHEMA_ID) errors.push(`schema 必须是 ${SCHEMA_ID}，收到 ${JSON.stringify(doc.schema)}`);
  if (doc.kind !== KIND) errors.push(`kind 必须是 ${KIND}，收到 ${JSON.stringify(doc.kind)}`);
  if (typeof doc.generated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(doc.generated_at)) {
    errors.push('generated_at 必须是 ISO 时间戳');
  }
  if (!isPlainObject(doc.generator) || !isNonEmptyString(doc.generator.name)) errors.push('缺少 generator.name');
  if (!isPlainObject(doc.domain) || !isNonEmptyString(doc.domain.id)) errors.push('缺少 domain.id');
  if (!Array.isArray(doc.questions) || doc.questions.length === 0) {
    errors.push('questions 必须是非空数组');
  } else {
    doc.questions.forEach((q, i) => {
      const r = validateQuestion(q);
      errors.push(...r.errors.map((e) => `questions[${i}]: ${e}`));
      warnings.push(...r.warnings.map((w) => `questions[${i}]: ${w}`));
    });
  }

  const specs = Object.fromEntries(
    (doc.questions || []).filter((q) => isNonEmptyString(q?.id)).map((q) => [q.id, q]),
  );

  if (!isPlainObject(doc.request)) errors.push('缺少 request');
  else {
    const r = validateJevRequest(doc.request);
    errors.push(...r.errors.map((e) => `request: ${e}`));
  }

  if (!isPlainObject(doc.response)) errors.push('缺少 response');
  else {
    const r = validateJevResponse(doc.response, specs);
    errors.push(...r.errors.map((e) => `response: ${e}`));
    warnings.push(...r.warnings.map((w) => `response: ${w}`));
  }

  if (!isPlainObject(doc.provenance)) errors.push('缺少 provenance');
  else {
    if (!isNonEmptyString(doc.provenance.provider)) errors.push('provenance.provider 缺失');
    if (!isPlainObject(doc.provenance.engine)) warnings.push('provenance.engine 缺失：无法复现概率是怎么算出来的');
  }

  if (doc.derivation !== null && doc.derivation !== undefined && !isPlainObject(doc.derivation)) {
    errors.push('derivation 必须是对象或 null');
  }
  if (doc.consistency !== null && doc.consistency !== undefined && !isPlainObject(doc.consistency)) {
    errors.push('consistency 必须是对象或 null');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验第二步产物（问题集）：{ schema, state, questions, ... } */
export function validateQuestionSet(doc, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(doc)) return { ok: false, errors: ['问题集必须是对象'], warnings };
  if (doc.schema !== QUESTION_SET_SCHEMA) errors.push(`schema 必须是 ${QUESTION_SET_SCHEMA}`);
  if (typeof doc.state !== 'string' || !doc.state.trim()) errors.push('state 不能为空');
  if (!Array.isArray(doc.questions) || doc.questions.length === 0) errors.push('questions 必须是非空数组');
  else {
    doc.questions.forEach((q, i) => {
      const r = validateQuestion(q, opts);
      errors.push(...r.errors.map((e) => `questions[${i}]: ${e}`));
      warnings.push(...r.warnings.map((w) => `questions[${i}]: ${w}`));
    });
    const ids = doc.questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) errors.push('questions 的 id 有重复');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验第三步的原始判断（模型交回来的证据表）。 */
export function validateJudgment(doc, specs = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(doc)) return { ok: false, errors: ['judgment 必须是对象'], warnings };
  if (doc.schema !== undefined && doc.schema !== JUDGMENT_SCHEMA) {
    errors.push(`judgment.schema 必须是 ${JUDGMENT_SCHEMA}`);
  }
  if (!isPlainObject(doc.answers)) {
    errors.push('judgment 缺少 answers 对象');
    return { ok: false, errors, warnings };
  }
  for (const [id, j] of Object.entries(doc.answers)) {
    const spec = specs[id];
    const at = `answers.${id}`;
    if (!spec) warnings.push(`${at}: 判断里出现了问题集之外的 id`);
    if (!isPlainObject(j)) {
      errors.push(`${at}: 必须是对象`);
      continue;
    }
    const type = j.type ?? spec?.type;
    if (!QUESTION_TYPES.includes(type)) {
      errors.push(`${at}: type 非法`);
      continue;
    }
    if (type === 'noul') {
      const hasP = typeof j.p === 'number';
      const hasSupport = typeof j.support === 'number';
      if (!hasP && !hasSupport) errors.push(`${at}: noul 需要 p（0–1）或 support（对数几率）`);
      if (hasP && (j.p < 0 || j.p > 1)) errors.push(`${at}: p 必须在 0–1 之间`);
    } else {
      if (!isPlainObject(j.scores)) errors.push(`${at}: ${type} 需要 scores 对象（选项/等级 → 支持度实数）`);
      else if (spec) {
        const expect = type === 'choice' ? Object.keys(spec.criteria || {}) : (spec.criteria || []).map((_, i) => String(i));
        const got = Object.keys(j.scores);
        const missing = expect.filter((k) => !(k in j.scores));
        const extraKeys = got.filter((k) => !expect.includes(k));
        if (missing.length) errors.push(`${at}: scores 缺少 ${missing.join(', ')}`);
        if (extraKeys.length) errors.push(`${at}: scores 多出 ${extraKeys.join(', ')}`);
        for (const k of got) {
          if (typeof j.scores[k] !== 'number' || !Number.isFinite(j.scores[k])) {
            errors.push(`${at}: scores.${k} 必须是有限实数`);
          }
        }
      }
    }
    if (j.basis !== undefined && !Array.isArray(j.basis)) warnings.push(`${at}: basis 建议是数组（每条依据一句）`);
  }
  for (const id of Object.keys(specs)) {
    if (!(id in doc.answers)) warnings.push(`judgment 没有覆盖题目 ${id}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
