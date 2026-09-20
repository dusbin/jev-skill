/**
 * @module calibration
 * 校准统计：把「用过一段时间之后的决策记录」变成可判断可信度的数字。
 *
 * ## 为什么这件事必须做，而且必须说清口径
 *
 * TypeSafe 自己的文档反复强调两件事，本模块严格照办：
 *
 *  1. **校准是分组性质，不是单条保证**：「Calibration is measured across groups of predictions;
 *     it does not guarantee that an individual answer is correct.」所以这里输出的每一个数字
 *     都带样本量，样本太小时明确拒答，而不是给一个看起来很精确的数。
 *  2. **不要盲目用 confidence 做阈值**：「Choice/Score confidence summarizes distribution
 *     concentration, not overall workflow correctness.」所以这里**同时**算两个口径：
 *
 *     - `ece_of_confidence`        —— 我们的 confidence 统计量是否真的追踪正确率；
 *     - `ece_of_winning_probability` —— 被选中那一项的概率是否真的等于正确率（ML 里通常说的那个）。
 *
 *     两者差别很大时，说明该用哪一个是有讲究的：要卡阈值就该用后者。
 *
 * ## 三个指标
 *
 *  - **Brier**：`(p − y)²` 的均值（多分类时按 one-hot 求平方和）。越小越好，0 为完美。
 *  - **ECE**：按置信度分箱，`Σ (n_b/N)·|acc_b − conf_b|`。越小越好。
 *  - **可靠性表**：每箱的样本数、平均置信度、实际正确率。理想情况下两者相等（对角线上）。
 */

import { round } from './util.mjs';

/** 分箱：默认 10 箱。返回箱序号。 */
export function bucketIndex(p, bins = 10) {
  if (!Number.isFinite(p)) return 0;
  const idx = Math.floor(p * bins);
  return Math.max(0, Math.min(bins - 1, idx));
}

/**
 * 可靠性表。
 * @param {Array<{p:number, y:0|1}>} pairs
 */
export function reliabilityTable(pairs, bins = 10) {
  const rows = [];
  for (let b = 0; b < bins; b++) {
    const inBin = pairs.filter((x) => bucketIndex(x.p, bins) === b);
    if (inBin.length === 0) continue;
    const meanP = inBin.reduce((a, x) => a + x.p, 0) / inBin.length;
    const acc = inBin.reduce((a, x) => a + x.y, 0) / inBin.length;
    rows.push({
      bin: b,
      range: [round(b / bins, 4), round((b + 1) / bins, 4)],
      n: inBin.length,
      mean_confidence: round(meanP, 4),
      accuracy: round(acc, 4),
      gap: round(acc - meanP, 4),
    });
  }
  return rows;
}

/** Expected Calibration Error：`Σ (n_b/N)·|acc_b − conf_b|`。 */
export function expectedCalibrationError(pairs, bins = 10) {
  if (pairs.length === 0) return 0;
  const rows = reliabilityTable(pairs, bins);
  return round(rows.reduce((acc, r) => acc + (r.n / pairs.length) * Math.abs(r.accuracy - r.mean_confidence), 0), 4);
}

/** 二分类 Brier 分数：`mean((p − y)²)`。 */
export function brierScore(pairs) {
  if (pairs.length === 0) return 0;
  return round(pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / pairs.length, 4);
}

/**
 * 多分类 Brier：每条记录 `Σ_k (p_k − y_k)²` 的均值。
 * @param {Array<{probabilities:number[], correctIndex:number}>} records
 */
export function multiclassBrier(records) {
  if (records.length === 0) return 0;
  const total = records.reduce((acc, r) => {
    const s = r.probabilities.reduce((a, p, i) => a + (p - (i === r.correctIndex ? 1 : 0)) ** 2, 0);
    return acc + s;
  }, 0);
  return round(total / records.length, 4);
}

/** 频率派的 Wilson 区间：样本少时比「正确数/总数」诚实得多。 */
export function wilsonInterval(successes, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 1, point: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    point: round(p, 4),
    low: round(Math.max(0, center - half), 4),
    high: round(Math.min(1, center + half), 4),
  };
}

/**
 * 汇总一批标注记录。
 *
 * @param {Array<object>} records 每条至少要有 `correct`(0|1) 与一个概率来源：
 *        `confidence`（本技能的置信度）或 `winning_probability`（被选项自身的概率）
 * @param {{bins?:number, minSamples?:number}} [opts]
 */
export function summarize(records, { bins = 10, minSamples = 30 } = {}) {
  const withConf = records.filter((r) => typeof r.confidence === 'number');
  const withWin = records.filter((r) => typeof r.winning_probability === 'number');
  const out = {
    n: records.length,
    accuracy: records.length ? round(records.reduce((a, r) => a + r.correct, 0) / records.length, 4) : 0,
    accuracy_ci: wilsonInterval(records.reduce((a, r) => a + r.correct, 0), records.length),
    min_samples: minSamples,
  };

  if (withConf.length) {
    const pairs = withConf.map((r) => ({ p: r.confidence, y: r.correct }));
    out.confidence = {
      n: withConf.length,
      ece: expectedCalibrationError(pairs, bins),
      brier: brierScore(pairs),
      mean_confidence: round(pairs.reduce((a, x) => a + x.p, 0) / pairs.length, 4),
      reliability: reliabilityTable(pairs, bins),
      definition: '本技能的 confidence 统计量（0.75·归一化优势 + 0.25·(1−归一化熵)）',
    };
  }

  if (withWin.length) {
    const pairs = withWin.map((r) => ({ p: r.winning_probability, y: r.correct }));
    out.winning_probability = {
      n: withWin.length,
      ece: expectedCalibrationError(pairs, bins),
      brier: brierScore(pairs),
      mean_confidence: round(pairs.reduce((a, x) => a + x.p, 0) / pairs.length, 4),
      reliability: reliabilityTable(pairs, bins),
      definition: '被选中那一项的 probabilities 值（要卡阈值应该用这个）',
    };
  }

  const warnings = [];
  if (records.length < minSamples) {
    warnings.push(
      `样本只有 ${records.length} 条，少于 ${minSamples} 条：上面的 ECE/Brier 只能当趋势看，不能当结论。` +
        '校准是分组性质，样本不足时它测的是噪声。',
    );
  }
  const over = [];
  for (const key of ['confidence', 'winning_probability']) {
    const m = out[key];
    if (!m) continue;
    if (m.mean_confidence - out.accuracy > 0.15) over.push(`${key} 平均 ${m.mean_confidence} 而实际正确率只有 ${out.accuracy}：明显过度自信`);
    if (out.accuracy - m.mean_confidence > 0.15) over.push(`${key} 平均 ${m.mean_confidence} 而实际正确率有 ${out.accuracy}：明显过度保守`);
  }
  warnings.push(...over);
  out.warnings = warnings;
  return out;
}
