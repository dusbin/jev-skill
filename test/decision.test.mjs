import test from 'node:test';
import assert from 'node:assert/strict';
import {
  argmax,
  averageJudgments,
  buildAnswer,
  confidenceOf,
  distributionStats,
  expectedScore,
  judgmentToAnswer,
  judgmentToResponse,
  normalizeProbabilities,
  sigmoid,
  softmax,
} from '../lib/decision.mjs';
import { ENGINE_TUNING } from '../lib/schema.mjs';

/* ---------------------------- softmax ---------------------------- */

test('softmax：和为 1，且保序', () => {
  const p = softmax([1, 2, 3]);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(p[0] < p[1] && p[1] < p[2]);
});

test('softmax：相等的支持度 → 均匀分布', () => {
  assert.deepEqual(softmax([0, 0, 0, 0]).map((x) => Math.round(x * 1e6) / 1e6), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(softmax([7, 7]), [0.5, 0.5]);
});

test('softmax：平移不变——只在乎差值，不在乎绝对大小（模型不需要会调温）', () => {
  const a = softmax([3, 1, 1]);
  const b = softmax([13, 11, 11]);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-12, `第 ${i} 项应相同`);
});

test('softmax：差距极大时趋近 one-hot（这是正常行为，不是溢出）', () => {
  const p = softmax([300, 100, 100]);
  assert.ok(p[0] > 0.9999);
  assert.ok(p.slice(1).every((x) => x < 1e-6));
  assert.equal(p.reduce((a, b) => a + b, 0), 1);
});

test('softmax：数值稳定——大数不溢出为 NaN', () => {
  const p = softmax([1000, 999, 998]);
  assert.ok(p.every((x) => Number.isFinite(x)));
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('softmax：温度越大越平（越保守）', () => {
  const sharp = softmax([4, 0, 0], 0.5);
  const flat = softmax([4, 0, 0], 4);
  assert.ok(sharp[0] > flat[0], '低温更尖');
  assert.ok(flat[0] < 0.9, '高温应显著拉平');
});

test('sigmoid：0.5 对称，边界饱和', () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(Math.abs(sigmoid(1) + sigmoid(-1) - 1) < 1e-12);
  assert.ok(sigmoid(50) > 0.999);
  assert.ok(sigmoid(-50) < 0.001);
  assert.ok(Number.isFinite(sigmoid(-1000)), '大负数不能算出 NaN');
});

/* ---------------------------- 置信度 ---------------------------- */

test('confidenceOf：确定分布为 1，均匀分布为 0', () => {
  assert.equal(confidenceOf([1, 0, 0]).confidence, 1);
  assert.equal(confidenceOf([0.25, 0.25, 0.25, 0.25]).confidence, 0);
  assert.equal(confidenceOf([1, 0]).confidence, 1);
});

test('confidenceOf：公布公式可复算', () => {
  const p = [0.04, 0.35, 0.61];
  const stats = distributionStats(p);
  const expect = 0.75 * stats.normalized_margin + 0.25 * (1 - stats.normalized_entropy);
  assert.equal(confidenceOf(p).confidence, Math.round(expect * 1e4) / 1e4);
});

test('confidenceOf：惩罚两种坏形状', () => {
  // 「一个次优 + 长尾」与「两个并列」，单看优势或单看熵都会被其中之一骗过
  const longTail = confidenceOf([0.5, 0.25, 0.125, 0.125]).confidence;
  const twoWay = confidenceOf([0.45, 0.44, 0.10, 0.01]).confidence;
  assert.ok(longTail > twoWay, '并列的两个人应当比「次优 + 长尾」更不确定');
  assert.ok(twoWay < 0.35, '近乎并列时置信度必须很低');
});

test('confidenceOf：与 TypeSafe 官方公布样例的对照（不是同一个统计量，方向一致）', () => {
  // 官方公布值见 docs/JEV-COMPAT.md。TypeSafe 的 confidence 是未公开的私有统计量，
  // 且它自己公布的两组近似分布给出的值自相矛盾（0.76 vs 0.596），所以这里只要求**方向一致、误差可控**。
  const samples = [
    { p: [0, 0.02, 0.98], official: 0.97 },
    { p: [0, 0.16, 0.84], official: 0.76 },
    { p: [0.04, 0.35, 0.61], official: 0.42 },
    { p: [0.02, 0.24, 0.34, 0.4], official: 0.2 },
  ];
  let sumAbs = 0;
  for (const s of samples) {
    const ours = confidenceOf(s.p).confidence;
    sumAbs += Math.abs(ours - s.official);
    assert.ok(Math.abs(ours - s.official) < 0.2, `分布 ${JSON.stringify(s.p)}：本技能 ${ours} vs 官方 ${s.official} 相差过大`);
  }
  assert.ok(sumAbs / samples.length < 0.12, `平均绝对误差 ${(sumAbs / samples.length).toFixed(3)} 应小于 0.12`);
});

test('distributionStats：描述量自洽', () => {
  const s = distributionStats([0.5, 0.5]);
  assert.equal(s.n, 2);
  assert.equal(s.top, 0.5);
  assert.equal(s.runner_up, 0.5);
  assert.equal(s.normalized_margin, 0);
  assert.equal(s.normalized_entropy, 1);
});

/* ---------------------------- score ---------------------------- */

test('expectedScore：概率加权期望，可以落在档位之间', () => {
  assert.equal(expectedScore([1, 0, 0]), 0);
  assert.equal(expectedScore([0, 1, 0]), 1);
  assert.equal(expectedScore([0, 0.5, 0.5]), 1.5);
  assert.equal(expectedScore([0.2, 0.3, 0.5]), 1.3);
});

test('buildAnswer：score 答案带 legend，且 score 与概率自洽', () => {
  const spec = { type: 'score', instructions: '难度？', criteria: ['低', '中', '高'] };
  const { answer } = buildAnswer(spec, { 0: 0.2, 1: 0.3, 2: 0.5 }, { method: 'test' });
  assert.deepEqual(answer.legend, { 0: '低', 1: '中', 2: '高' });
  assert.equal(answer.score, 1.3);
  assert.equal(answer.type, 'score');
  assert.ok(Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('buildAnswer：--round-score 取 argmax', () => {
  const spec = { type: 'score', instructions: '难度？', criteria: ['低', '中', '高'] };
  const { answer, derivation } = buildAnswer(spec, { 0: 0.2, 1: 0.3, 2: 0.5 }, { roundScore: true, method: 'test' });
  assert.equal(answer.score, 2);
  assert.equal(derivation.expected_score, 1.3);
  assert.equal(derivation.rounded_score, 2);
});

test('normalizeProbabilities：四舍五入后和恰好为 1', () => {
  const p = normalizeProbabilities(['a', 'b', 'c'], [1 / 3, 1 / 3, 1 / 3]);
  assert.equal(Object.values(p).reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(p, { a: 0.3334, b: 0.3333, c: 0.3333 });
});

test('argmax：并列时取下标最小的', () => {
  assert.equal(argmax([0.5, 0.5]), 0);
  assert.equal(argmax([0.1, 0.6, 0.6]), 1);
});

/* ---------------------------- 判断 → 答案 ---------------------------- */

test('judgmentToAnswer：noul 支持两种输入（p 直接用，support 走 sigmoid）', () => {
  const spec = { type: 'noul', instructions: '成立吗？' };
  assert.equal(judgmentToAnswer(spec, { p: 0.93 }).answer.noul, 0.93);
  assert.equal(judgmentToAnswer(spec, { p: 3 }).answer.noul, 1, 'p 会被裁剪到 0–1');
  const viaSupport = judgmentToAnswer(spec, { support: 0 });
  assert.equal(viaSupport.answer.noul, 0.5);
  assert.deepEqual(Object.keys(viaSupport.answer), ['type', 'noul'], 'noul 答案不得带 confidence 等额外字段');
});

test('judgmentToAnswer：缺 p/support 时报错而不是给个默认值', () => {
  assert.throws(() => judgmentToAnswer({ type: 'noul', instructions: 'x' }, {}), /缺少 noul 所需的 p 或 support/);
});

test('judgmentToAnswer：choice 的 choice 字段就是 argmax', () => {
  const spec = { type: 'choice', instructions: '选一个', criteria: { A: '甲', B: '乙', C: '丙' } };
  const { answer } = judgmentToAnswer(spec, { scores: { A: 0, B: 2, C: 0.5 } });
  assert.equal(answer.choice, 'B');
  assert.deepEqual(Object.keys(answer).sort(), ['choice', 'confidence', 'probabilities', 'type']);
  assert.equal(Object.keys(answer.probabilities).sort().join(','), 'A,B,C');
});

test('judgmentToAnswer：缺选项时按 0 处理（等价于「无证据」），不漏掉概率键', () => {
  const spec = { type: 'choice', instructions: '选一个', criteria: { A: '甲', B: '乙' } };
  const { answer } = judgmentToAnswer(spec, { scores: { A: 1 } });
  assert.deepEqual(Object.keys(answer.probabilities).sort(), ['A', 'B']);
  assert.equal(answer.choice, 'A');
});

test('judgmentToResponse：多题共用一次响应，结构与 Jev 一致', () => {
  const questions = [
    { id: 'q1', type: 'choice', instructions: '选', criteria: { A: '甲', B: '乙' } },
    { id: 'q2', type: 'noul', instructions: '成立吗？' },
    { id: 'q3', type: 'score', instructions: '难度？', criteria: ['低', '高'] },
  ];
  const judgment = {
    answers: {
      q1: { scores: { A: 2, B: 1 } },
      q2: { p: 0.2 },
      q3: { scores: { 0: 0, 1: 3 } },
    },
  };
  const { response } = judgmentToResponse({ questions, judgments: judgment, model: 'test-model' });
  assert.equal(response.model, 'test-model');
  assert.deepEqual(Object.keys(response.answers), ['q1', 'q2', 'q3']);
  assert.equal(response.answers.q1.type, 'choice');
  assert.equal(response.answers.q2.type, 'noul');
  assert.equal(response.answers.q3.type, 'score');
  assert.deepEqual(response.usage, { input_tokens: 0, output_tokens: 0 });
});

test('judgmentToResponse：缺某题答案时抛错（不静默跳过）', () => {
  const questions = [{ id: 'q1', type: 'noul', instructions: 'x 成立吗？' }];
  assert.throws(() => judgmentToResponse({ questions, judgments: { answers: {} } }), /缺少题目 q1/);
});

/* ---------------------------- 多采样一致性 ---------------------------- */

test('averageJudgments：多次采样的分布取平均，并给出一致率', () => {
  const spec = { type: 'choice', instructions: '选', criteria: { A: '甲', B: '乙' } };
  const samples = [
    { scores: { A: 4, B: 0 } },
    { scores: { A: 4, B: 0 } },
    { scores: { A: 0, B: 4 } },
  ];
  const { answer, consistency } = averageJudgments(spec, samples);
  assert.equal(consistency.samples, 3);
  assert.equal(consistency.agreement, 0.6667);
  assert.equal(consistency.flips, 1);
  assert.equal(answer.choice, 'A', '多数采样支持 A');
  assert.ok(answer.probabilities.A > 0.6 && answer.probabilities.A < 0.95, '平均后的分布应被「翻转的那次」拉平');
});

test('averageJudgments：全一致时一致率为 1，分布与单次相同', () => {
  const spec = { type: 'choice', instructions: '选', criteria: { A: '甲', B: '乙' } };
  const s = { scores: { A: 3, B: 1 } };
  const { answer, consistency } = averageJudgments(spec, [s, s, s]);
  assert.equal(consistency.agreement, 1);
  assert.equal(consistency.flips, 0);
  const single = judgmentToAnswer(spec, s).answer;
  assert.equal(answer.choice, single.choice);
  assert.ok(Math.abs(answer.probabilities.A - single.probabilities.A) < 0.01);
});

test('averageJudgments：noul 的一致性按 0.5 两侧归类', () => {
  const spec = { type: 'noul', instructions: '成立吗？' };
  const { answer, consistency } = averageJudgments(spec, [{ p: 0.9 }, { p: 0.8 }, { p: 0.2 }]);
  assert.equal(consistency.samples, 3);
  assert.equal(consistency.agreement, 0.6667);
  assert.equal(answer.noul, Math.round(((0.9 + 0.8 + 0.2) / 3) * 1e4) / 1e4);
});

/* ---------------------------- 引擎参数 ---------------------------- */

test('引擎参数集中在 ENGINE_TUNING，改动会同时影响公式与文档', () => {
  assert.equal(typeof ENGINE_TUNING.softmax_temperature, 'number');
  assert.equal(ENGINE_TUNING.confidence_margin_weight, 0.75);
  assert.ok(ENGINE_TUNING.probability_digits >= 2, '概率位数不能少于 Jev 官方示例的 2 位');
});
