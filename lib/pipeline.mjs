/**
 * @module pipeline
 * 三步流水线的编排层：把 identify / questions / decision / providers 串起来，
 * 并保证每一步的产物都是**带 schema 的纯 JSON**，可以单独落盘、人工修改、再喂回下游。
 *
 * ```
 *  ① jev identify   文本 ──────────────→ domain.json   （领域识别，含证据与置信度）
 *  ② jev ask        领域 + 输入 ───────→ questions.json（问题集 = 一份合法的 Jev 请求）
 *  ③ jev decide     问题集 + 判断 ─────→ decision.json （固定 JSON，含 Jev 原生答案）
 * ```
 *
 * 编排层不做判断、也不做数学，只负责：取领域、编译请求、调 provider、校验、组装信封。
 */

import { nowIso, stableId } from './util.mjs';
import { ENGINE_TUNING, LIMITS, makeEnvelope, QUESTION_SET_SCHEMA, validateDecision, validateJevResponse, validateQuestionSet } from './schema.mjs';
import { requireDomain } from './domains/index.mjs';
import { identifyDomain } from './identify.mjs';
import { checkInjection, makeQuestionSet, planQuestions, toJevRequest, DEFAULT_MODEL } from './questions.mjs';
import { judgmentToResponse } from './decision.mjs';
import { resolveProvider } from './providers/index.mjs';

/* ------------------------------------------------------------------ *
 * 第一步
 * ------------------------------------------------------------------ */

/** 第一步：领域识别。返回带 `schema: jev/domain@1` 的纯 JSON。 */
export function runIdentify({ text = '', hint = '' } = {}) {
  const result = identifyDomain({ text, hint });
  if (text) result.state_injection = checkInjection(text);
  return result;
}

/* ------------------------------------------------------------------ *
 * 第二步
 * ------------------------------------------------------------------ */

/**
 * 第二步：生成候选问题；若给定 `pick`（1 起的序号）或 `custom`（自定义问题文本），
 * 则直接产出可用的 `questions.json`。
 *
 * @param {{domainKey:string, input:string, userQuestion?:string, types?:string[],
 *          maxOptions?:number, pick?:number, custom?:string, model?:string}} args
 */
export function runAsk({
  domainKey = '',
  input = '',
  userQuestion = '',
  types = null,
  maxOptions = LIMITS.choice.max,
  pick = null,
  custom = '',
  model = DEFAULT_MODEL,
} = {}) {
  const plan = planQuestions({ domainKey, input, userQuestion: custom || userQuestion, types, maxOptions });

  if (pick === null && !custom) {
    return { ...plan, picked: null, question_set: null };
  }

  const chosenList = [];

  // 自定义问题与预定义问题**可以同时选**：「我自己加了一个问题，另外把第 2 条也一起问了」
  // 是很自然的用法，而 Jev 的设计本来就支持一次请求问多个问题。
  //
  // `custom` 可以是**数组**——这是为了「一句话里有两件事」的场景（如「重大：A。此外，B。」）。
  // 技能第二步的 truth-apt 检查会指出这类输入在问多件事，但**拆分只能由调用方做**
  // （只有人和模型知道该在哪里切开），所以这里要能一次接收多条自定义问题。
  const customList = (Array.isArray(custom) ? custom : [custom]).filter((c) => typeof c === 'string' && c.trim());
  if (customList.length) {
    const userCandidates = plan.candidates.filter((c) => c.origin === 'user');
    if (userCandidates.length < customList.length) {
      return {
        ...plan,
        picked: null,
        question_set: null,
        error: `给了 ${customList.length} 条自定义问题，但只有 ${userCandidates.length} 条通过了编译；见 plan.notes。`,
      };
    }
    chosenList.push(...userCandidates);
  }

  if (pick !== null && pick !== undefined) {
    // `pick` 支持单个序号或序号数组。多选是**推荐用法**：Jev 的核心工程建议就是
    // 「同一 state 的所有问题放在一次请求里」，因为它们并行评估、互相看不见答案，
    // 批量比逐条问便宜也更快（官方 cookbook 实测 13 个问题便宜 11.5 倍、快 9.6 倍）。
    const raw = Array.isArray(pick) ? pick : [pick];
    const idxs = raw.map((p) => Number(p) - 1);
    const bad = idxs.find((i) => !Number.isInteger(i) || i < 0 || i >= plan.candidates.length);
    if (bad !== undefined) {
      return {
        ...plan,
        picked: null,
        question_set: null,
        error: `--pick ${raw.join(',')} 超出候选范围（1–${plan.candidates.length}）`,
      };
    }
    for (const i of idxs) chosenList.push(plan.candidates[i]);
  }

  // 去重：同一个序号写两遍、或自定义问题与某条候选恰好等价时，不该出现两道一样的题
  const seen = new Set();
  const unique = chosenList.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  if (unique.length === 0) {
    return { ...plan, picked: null, question_set: null, error: '没有选中任何题目：用 --pick 选候选，或用 --custom 给出自己的问题。' };
  }

  const domain = requireDomain(domainKey);
  const set = makeQuestionSet({
    domain,
    state: plan.state,
    questions: unique,
    maxOptions,
    model: model || DEFAULT_MODEL,
    notes: [
      `题目来源：${unique.map((c) => (c.origin === 'user' ? '用户自定义' : `领域模板 ${c.template}`)).join('、')}`,
      unique.length > 1
        ? `一次请求问了 ${unique.length} 个问题（Jev 的推荐用法：同一 state 的问题并行评估、互相看不见答案）。`
        : '',
    ].filter(Boolean),
  });
  if (plan.state_injection?.suspicious) set.notes.push(plan.state_injection.advice);

  return {
    ...plan,
    picked: unique.map((c) => c.id),
    question_set: {
      ...set,
      injection: plan.state_injection || undefined,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 第三步
 * ------------------------------------------------------------------ */

/**
 * 第三步：执行决策，产出**固定 JSON**。
 *
 * @param {{questionSet:object, providerName?:string, judgment?:object|null, model?:string,
 *          samples?:number, temperature?:number, roundScore?:boolean, extraNotes?:string[]}} args
 */
export async function runDecide({
  questionSet,
  providerName = 'agent',
  judgment = null,
  model = null,
  samples = 1,
  temperature,
  roundScore = false,
  extraNotes = [],
}) {
  const setCheck = validateQuestionSet(questionSet, { maxOptions: questionSet.max_options ?? LIMITS.choice.max });
  if (!setCheck.ok) {
    throw new Error(`第二步产物不合法，无法进入第三步：\n  - ${setCheck.errors.join('\n  - ')}`);
  }

  const domain = requireDomain(questionSet.domain?.id || 'other');
  const specs = questionSet.questions;
  const state = questionSet.state;
  const provider = resolveProvider(providerName);

  const run = await provider.run({
    state,
    questions: specs,
    domain,
    judgment,
    model: model || undefined,
    samples,
    temperature: temperature ?? (provider.id === 'agent' ? 1 : 0.7),
  });

  const { response, derivations, consistency } = judgmentToResponse({
    questions: specs,
    judgments: run.judgments,
    model: run.model,
    usage: run.usage,
    temperature,
    roundScore,
  });

  const respCheck = validateJevResponse(response, Object.fromEntries(specs.map((s) => [s.id, s])));
  if (!respCheck.ok) {
    throw new Error(`换算出的答案不合法（这是引擎的 bug，请提 issue）：\n  - ${respCheck.errors.join('\n  - ')}`);
  }

  const request = questionSet.request || toJevRequest(specs, state, model || DEFAULT_MODEL);

  const envelope = makeEnvelope({
    generatedAt: nowIso(),
    domain: {
      id: domain.id,
      name: domain.name,
      category: domain.category,
      source: questionSet.domain?.source || 'user',
    },
    questions: specs.map((s) => ({
      id: s.id,
      type: s.type,
      instructions: s.instructions,
      criteria: s.criteria ?? null,
      origin: s.origin || 'predefined',
      template: s.template ?? null,
      kind: s.kind ?? 'answer',
      score_set: s.score_set ?? null,
      why: s.why ?? null,
    })),
    request,
    response,
    judgment: run.judgments.length === 1
      ? run.judgments[0]
      : { schema: 'jev/judgment@1', samples: run.judgments, note: `共 ${run.judgments.length} 次采样` },
    derivation: derivations,
    consistency: Object.keys(consistency).length ? consistency : null,
    provenance: {
      provider: provider.id,
      provider_name: provider.name,
      model: run.model,
      samples: run.judgments.length,
      state_injection: checkInjection(state),
      engine: {
        softmax_temperature: temperature ?? ENGINE_TUNING.softmax_temperature,
        confidence_margin_weight: ENGINE_TUNING.confidence_margin_weight,
        confidence_formula: `confidence = ${ENGINE_TUNING.confidence_margin_weight}·(p₁−p₂)/(1−p₂) + ${(1 - ENGINE_TUNING.confidence_margin_weight).toFixed(2)}·(1 − H(p)/ln n)`,
        score_rule: roundScore ? 'argmax（离散档位）' : 'Σ i·pᵢ（概率加权期望，Jev 原生定义）',
        probability_digits: ENGINE_TUNING.probability_digits,
      },
      limits: {
        choice_max_options: questionSet.max_options ?? LIMITS.choice.max,
        choice_max_options_note: '这是本技能的规格；TypeSafe Jev 自身支持最多 255 个选项。',
        score_levels: [LIMITS.score.min, LIMITS.score.max],
      },
      deterministic: provider.id === 'agent',
      notes: [...(extraNotes || []), ...(run.notes || [])],
    },
  });

  const finalCheck = validateDecision(envelope);
  return { envelope, validation: finalCheck };
}

/* ------------------------------------------------------------------ *
 * 一步到底
 * ------------------------------------------------------------------ */

/**
 * 便捷入口：给定领域/输入/问题，直接把判断换成固定 JSON。
 * CLI 的 `jev run` 用它；分步流程仍推荐逐条跑，便于人工核对中间产物。
 */
export async function runAll({
  domainKey = '',
  input = '',
  userQuestion = '',
  types = null,
  maxOptions = LIMITS.choice.max,
  providerName = 'agent',
  judgment = null,
  model = null,
  samples = 1,
  temperature,
  roundScore = false,
}) {
  const ask = runAsk({ domainKey, input, userQuestion, types, maxOptions, pick: 1, model });
  if (!ask.question_set) {
    throw new Error(`第二步没有产出可用问题：${ask.error || (ask.notes || []).join('；')}`);
  }
  return runDecide({ questionSet: ask.question_set, providerName, judgment, model, samples, temperature, roundScore });
}

/** 产物文件名前缀：领域 + 输入摘要哈希，保证同名输入得到同名文件。 */
export function artifactName(domain, seedText, suffix = 'decision') {
  return `${domain.name}-${suffix}-${stableId('x', seedText).slice(2, 8)}`;
}

export { QUESTION_SET_SCHEMA };
