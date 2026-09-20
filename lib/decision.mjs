/**
 * @module decision
 * 第三步的核心：把「判断」换算成 Jev 意义上的**答案**。
 *
 * ## 为什么概率不由模型直接给
 *
 * 现实里让 LLM「直接输出四个选项的概率」会得到两种坏结果：一是四舍五入到 `0.25/0.25/0.25/0.25`
 * 的假均匀，二是 `0.99/0.005/0.003/0.002` 的假自信。两种都不是校准，只是把模型的口头自信
 * 装扮成了数字。
 *
 * 所以本技能把职责切开：
 *
 *  - **模型只提供支持度（support）**：每个选项/等级一个任意实数，表示「这条证据有多支持它」。
 *    这是模型真正擅长的事——比较、排序、指出依据。
 *  - **引擎做所有数学**：softmax 归一、置信度、概率加权期望值、以及全部结构校验。
 *    这些是确定性计算，可复现、可测试、可解释。
 *
 * 一个副作用是好的：模型给 `3/1/1` 与给 `300/100/100` 得到完全相同的结果，
 * 因为 softmax 只在乎差值。模型不需要「会调温度」。
 *
 * ## 关于 confidence
 *
 * TypeSafe 的 `confidence` 是**未公开的统计量**（他们自家文档明说「you are never locked into
 * our definition」）。实测它也不是 max-prob、不是归一化熵、不是前二名差——官方公布的两组
 * 近似分布 `{0,0.16,0.84}→0.76` 与 `{0.001,0.159,0.84}→0.596` 就自相矛盾。
 * 因此本技能**定义自己的 confidence 并公开公式**（见 `confidenceOf`），
 * 在 docs/DESIGN.md 里给出与官方公布样例的对照表。知道公式比拿到一个不可解释的数字更有用。
 */

import { clamp, entropy, round } from './util.mjs';
import { ENGINE_TUNING } from './schema.mjs';

/** 数值稳定的 softmax；temperature 越大越平（越保守）。 */
export function softmax(scores, temperature = ENGINE_TUNING.softmax_temperature) {
  const t = temperature > 0 ? temperature : 1;
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / t));
  const total = exps.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    const u = 1 / scores.length;
    return scores.map(() => u);
  }
  return exps.map((e) => e / total);
}

/** sigmoid：把对数几率转成 0–1 的概率。 */
export function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * 分布的描述统计。`confidence` 就是由这里的量算出来的，一律公开。
 */
export function distributionStats(probabilities) {
  const n = probabilities.length;
  const sorted = [...probabilities].sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const runnerUp = n > 1 ? sorted[1] : 0;
  const h = entropy(probabilities);
  const hMax = n > 1 ? Math.log(n) : 0;
  const normalizedEntropy = hMax > 0 ? h / hMax : 0;
  // 归一化优势：在与次优选项的二元对比里胜出多少。n=1 时视为完全确定。
  const normalizedMargin = n > 1 ? (top - runnerUp) / (1 - runnerUp || 1) : 1;
  return {
    n,
    top: round(top, 6),
    runner_up: round(runnerUp, 6),
    entropy: round(h, 6),
    normalized_entropy: round(normalizedEntropy, 6),
    normalized_margin: round(normalizedMargin, 6),
  };
}

/**
 * **本技能对 confidence 的定义**（公开、可复现、可替换）：
 *
 * ```
 * confidence = w · 归一化优势 + (1 − w) · (1 − 归一化熵)
 * 归一化优势 = (p₁ − p₂) / (1 − p₂)          // 与次优的差距，扣掉「已经分给次优的质量」
 * 归一化熵   = H(p) / ln(n)                   // 0 = 完全集中，1 = 完全平均
 * w = ENGINE_TUNING.confidence_margin_weight  // 默认 0.75
 * ```
 *
 * 为什么两项都要：只看优势会被「一个次优 + 一堆长尾」骗过去（长尾分掉的概率不影响 p₁−p₂）；
 * 只看熵会被「两个几乎并列、其余都是 0」骗过去。两项一起才同时惩罚这两种形状。
 *
 * @returns {{confidence:number, stats:object}}
 */
export function confidenceOf(probabilities, weight = ENGINE_TUNING.confidence_margin_weight) {
  const stats = distributionStats(probabilities);
  const w = clamp(weight, 0, 1);
  const c = w * stats.normalized_margin + (1 - w) * (1 - stats.normalized_entropy);
  return {
    confidence: round(clamp(c, 0, 1), ENGINE_TUNING.confidence_digits),
    stats,
  };
}

/**
 * score 的取值：**概率加权期望**（Jev 的定义，可以为小数、可以落在两档之间）。
 *
 * ⚠️ TypeSafe 官方明确警告：不要用 score 去推算两档之间的精确数值——
 * 他们自己的评分等级「weak in numerical calibration」。所以这里的 score 适合排序与阈值，
 * 不适合当测量值。`--round-score` 可以改取「概率最大的档位」用于离散判决。
 */
export function expectedScore(probabilities) {
  return round(probabilities.reduce((acc, p, i) => acc + i * p, 0), ENGINE_TUNING.score_digits);
}

/** 概率最大者的下标（并列时取下标最小的）。 */
export function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/** 四舍五入到固定位数，并把舍入误差补到最大项，保证概率和恰好为 1。 */
export function normalizeProbabilities(entries, probs) {
  const rounded = Object.fromEntries(
    entries.map((k, i) => [k, round(probs[i], ENGINE_TUNING.probability_digits)]),
  );
  const drift = 1 - Object.values(rounded).reduce((a, b) => a + b, 0);
  if (Math.abs(drift) > 0) {
    const keys = Object.keys(rounded);
    const biggest = keys.reduce((a, b) => (rounded[a] >= rounded[b] ? a : b), keys[0]);
    rounded[biggest] = round(rounded[biggest] + drift, ENGINE_TUNING.probability_digits);
  }
  return rounded;
}

/** 题目规格 → 有序的键列表（choice 用选项名，score 用 "0"/"1"/…）。 */
export function entriesOf(spec) {
  return spec.type === 'choice'
    ? Object.keys(spec.criteria || {})
    : (spec.criteria || []).map((_, i) => String(i));
}

/**
 * 由**已经归一化的概率**直接构造答案。多条路径共用：
 *  - 单次判断（softmax 之后）
 *  - 多次采样（各次概率取平均之后）
 *  - 人工直接给概率（`--judgment` 里写 probabilities，用于复现他人的结果）
 */
export function buildAnswer(spec, probabilities, { roundScore = false, method = '', extra = {} } = {}) {
  const entries = entriesOf(spec);
  const probs = entries.map((k) => probabilities[k] ?? 0);
  const normalized = normalizeProbabilities(entries, probs);
  const { confidence, stats } = confidenceOf(probs);
  const bestIdx = argmax(probs);
  const derivation = {
    kind: spec.type,
    method,
    probabilities: normalized,
    stats,
    ...extra,
  };

  if (spec.type === 'choice') {
    return {
      answer: { type: 'choice', choice: entries[bestIdx], probabilities: normalized, confidence },
      derivation,
    };
  }

  const continuous = expectedScore(probs);
  const score = roundScore ? bestIdx : continuous;
  return {
    answer: {
      type: 'score',
      score,
      legend: Object.fromEntries(entries.map((k, i) => [k, spec.criteria[i]])),
      probabilities: normalized,
      confidence,
    },
    derivation: {
      ...derivation,
      expected_score: continuous,
      rounded_score: bestIdx,
      method: roundScore ? `${method}；score 按 --round-score 取概率最大的档位` : method,
    },
  };
}

/**
 * 把一条判断换算成 Jev 答案对象。
 *
 * @param {object} spec      题目规格（信封层 questions[] 的元素）
 * @param {object} judgment  模型给出的判断（{scores|p|support, basis, ...}）
 * @param {{temperature?:number, roundScore?:boolean}} [opts]
 * @returns {{answer:object, derivation:object}}
 */
export function judgmentToAnswer(spec, judgment, opts = {}) {
  const temperature = opts.temperature ?? ENGINE_TUNING.softmax_temperature;

  if (spec.type === 'noul') {
    let p;
    let how;
    if (typeof judgment.p === 'number') {
      p = clamp(judgment.p, 0, 1);
      how = '模型直接给出命题为真的概率，未做变换（引擎只做范围裁剪）。';
    } else if (typeof judgment.support === 'number') {
      p = sigmoid(judgment.support);
      how = `以对数几率 support=${judgment.support} 经 sigmoid 得到 p=${round(p, 6)}。`;
    } else {
      throw new Error(`判断缺少 noul 所需的 p 或 support：${spec.id}`);
    }
    return {
      answer: { type: 'noul', noul: round(p, ENGINE_TUNING.probability_digits) },
      derivation: { kind: 'noul', method: how, support: judgment.support ?? null },
    };
  }

  const entries = entriesOf(spec);
  const scores = entries.map((k) => {
    const v = judgment.scores?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });

  return buildAnswer(spec, Object.fromEntries(entries.map((k, i) => [k, softmax(scores, temperature)[i]])), {
    roundScore: opts.roundScore,
    method: `softmax(scores / ${temperature})，再按 ${ENGINE_TUNING.probability_digits} 位归一`,
    extra: {
      scores: Object.fromEntries(entries.map((k, i) => [k, scores[i]])),
      temperature,
    },
  });
}

/**
 * 多次采样的判断 → 单条答案，并给出**一致性**指标。
 *
 * 这不是花架子：TypeSafe 自己的 cookbook 就是靠「同一套题跑 15 次、看标签一致率」来评估稳定性，
 * 并公布了它的模型在 8 个问题上有 2 个会翻转。本技能把这个测量内建到流程里：
 * `--samples N` 之后，`provenance.consistency` 会给出每个问题的一致率，
 * **一致率低的问题应当被当作「这条结论不可用于自动决策」**，而不是照旧使用。
 */
export function averageJudgments(spec, judgments, opts = {}) {
  const entries = entriesOf(spec);
  const temperature = opts.temperature ?? ENGINE_TUNING.softmax_temperature;

  if (spec.type === 'noul') {
    const ps = judgments.map((j) => {
      if (typeof j.p === 'number') return clamp(j.p, 0, 1);
      if (typeof j.support === 'number') return sigmoid(j.support);
      return 0.5;
    });
    const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
    const labels = ps.map((p) => (p >= 0.5 ? 1 : 0));
    const majority = labels.filter((l) => l === (mean >= 0.5 ? 1 : 0)).length;
    return {
      answer: { type: 'noul', noul: round(mean, ENGINE_TUNING.probability_digits) },
      derivation: {
        kind: 'noul',
        method: `${ps.length} 次采样的概率取平均`,
        per_sample: ps.map((p) => round(p, 6)),
      },
      consistency: {
        samples: ps.length,
        agreement: round(majority / ps.length, 4),
        mean: round(mean, 6),
        spread: round(Math.max(...ps) - Math.min(...ps), 6),
      },
    };
  }

  const perSample = judgments.map((j) => {
    const scores = entries.map((k) => {
      const v = j.scores?.[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    });
    return softmax(scores, temperature);
  });
  const mean = entries.map((_, i) => perSample.reduce((a, ps) => a + ps[i], 0) / perSample.length);
  const { answer, derivation } = buildAnswer(
    spec,
    Object.fromEntries(entries.map((k, i) => [k, mean[i]])),
    {
      roundScore: opts.roundScore,
      method: `${perSample.length} 次采样的 softmax 分布取平均（每次 temperature=${temperature}）`,
      extra: { per_sample_probabilities: perSample.map((ps) => Object.fromEntries(entries.map((k, i) => [k, round(ps[i], 6)]))) },
    },
  );
  const finalIdx = argmax(mean);
  const agree = perSample.filter((ps) => argmax(ps) === finalIdx).length;
  return {
    answer,
    derivation,
    consistency: {
      samples: perSample.length,
      agreement: round(agree / perSample.length, 4),
      flips: perSample.length - agree,
      label_distribution: entries.reduce((acc, k, i) => {
        acc[k] = perSample.filter((ps) => argmax(ps) === i).length;
        return acc;
      }, {}),
    },
  };
}

/**
 * 判断 → 完整 Jev 响应。
 *
 * `judgments` 可以是单条（长度 1）或多条（多采样）。`answers` 的结构与 Jev 完全一致。
 */
export function judgmentToResponse({
  questions,
  judgments,
  model = 'jev-latest',
  usage = null,
  temperature,
  roundScore = false,
}) {
  const list = Array.isArray(judgments) ? judgments : [judgments];
  const answers = {};
  const derivations = {};
  const consistency = {};

  for (const spec of questions) {
    const perSpec = list.map((j) => j.answers?.[spec.id]).filter(Boolean);
    if (perSpec.length === 0) throw new Error(`判断里缺少题目 ${spec.id} 的答案`);
    if (perSpec.length === 1) {
      const { answer, derivation } = judgmentToAnswer(spec, perSpec[0], { temperature, roundScore });
      answers[spec.id] = answer;
      derivations[spec.id] = derivation;
    } else {
      const { answer, derivation, consistency: c } = averageJudgments(spec, perSpec, { temperature, roundScore });
      answers[spec.id] = answer;
      derivations[spec.id] = derivation;
      consistency[spec.id] = c;
    }
  }

  return {
    response: {
      model,
      answers,
      usage: usage || { input_tokens: 0, output_tokens: 0 },
    },
    derivations,
    consistency,
  };
}
