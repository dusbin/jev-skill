import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brierScore,
  bucketIndex,
  expectedCalibrationError,
  multiclassBrier,
  reliabilityTable,
  summarize,
  wilsonInterval,
} from '../lib/calibration.mjs';
import { recordsFromDecision } from '../scripts/jev-calibrate.mjs';

test('bucketIndex：边界与越界', () => {
  assert.equal(bucketIndex(0), 0);
  assert.equal(bucketIndex(0.0999), 0);
  assert.equal(bucketIndex(0.1), 1);
  assert.equal(bucketIndex(0.999), 9);
  assert.equal(bucketIndex(1), 9, '1.0 落在最后一箱，不越界');
  assert.equal(bucketIndex(NaN), 0);
});

test('brierScore：完美预测为 0，反向预测为 1', () => {
  assert.equal(brierScore([{ p: 1, y: 1 }, { p: 0, y: 0 }]), 0);
  assert.equal(brierScore([{ p: 1, y: 0 }, { p: 0, y: 1 }]), 1);
  assert.equal(brierScore([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.25);
  assert.equal(brierScore([]), 0);
});

test('multiclassBrier：one-hot 平方和', () => {
  const perfect = multiclassBrier([{ probabilities: [1, 0, 0], correctIndex: 0 }]);
  assert.equal(perfect, 0);
  const uniform = multiclassBrier([{ probabilities: [1 / 3, 1 / 3, 1 / 3], correctIndex: 0 }]);
  assert.ok(Math.abs(uniform - (4 / 9 + 1 / 9 + 1 / 9)) < 1e-4);
});

test('expectedCalibrationError：完美校准为 0', () => {
  // 每一箱里正确率都等于该箱的平均置信度
  const pairs = [
    ...Array.from({ length: 10 }, () => ({ p: 0.95, y: 1 })),
    ...Array.from({ length: 10 }, () => ({ p: 0.15, y: 0 })),
  ];
  assert.equal(expectedCalibrationError(pairs), 0.1, '箱内偏差 0.05，两箱各占一半 → 0.05');
});

test('expectedCalibrationError：全错且高置信时接近 1', () => {
  const pairs = Array.from({ length: 20 }, () => ({ p: 0.95, y: 0 }));
  assert.ok(expectedCalibrationError(pairs) > 0.9);
});

test('reliabilityTable：空箱不出现在表里', () => {
  const rows = reliabilityTable([{ p: 0.05, y: 1 }, { p: 0.95, y: 0 }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.bin), [0, 9]);
  assert.equal(rows[0].accuracy, 1);
  assert.equal(rows[0].gap, 0.95);
});

test('wilsonInterval：样本少时区间宽，且永远落在 [0,1]', () => {
  const small = wilsonInterval(3, 4);
  const big = wilsonInterval(750, 1000);
  assert.ok(small.high - small.low > big.high - big.low, '样本少时区间应更宽');
  assert.ok(small.low >= 0 && small.high <= 1);
  assert.equal(small.point, 0.75);
  const zero = wilsonInterval(0, 0);
  assert.deepEqual(zero, { point: 0, low: 0, high: 1 });
});

test('summarize：同时给出两个口径，并在样本不足时明确警告', () => {
  const records = Array.from({ length: 12 }, (_, i) => ({
    confidence: i < 6 ? 0.9 : 0.2,
    winning_probability: i < 6 ? 0.8 : 0.25,
    correct: i < 6 ? 1 : 0,
  }));
  const s = summarize(records, { minSamples: 30 });
  assert.equal(s.n, 12);
  assert.equal(s.accuracy, 0.5);
  assert.ok(s.confidence && s.winning_probability);
  assert.ok(s.confidence.reliability.length >= 2);
  assert.ok(s.warnings.some((w) => w.includes('样本只有 12 条')));
  assert.ok(s.accuracy_ci.low < 0.5 && s.accuracy_ci.high > 0.5);
});

test('summarize：过度自信会被点出来', () => {
  const records = Array.from({ length: 40 }, (_, i) => ({
    confidence: 0.95,
    winning_probability: 0.9,
    correct: i < 10 ? 1 : 0, // 实际只有 25% 正确
  }));
  const s = summarize(records, { minSamples: 30 });
  assert.ok(s.warnings.some((w) => w.includes('过度自信')));
  assert.ok(s.confidence.ece > 0.5);
});

test('summarize：过度保守也会被点出来', () => {
  const records = Array.from({ length: 40 }, () => ({
    confidence: 0.2,
    winning_probability: 0.3,
    correct: 1, // 实际全对
  }));
  const s = summarize(records, { minSamples: 30 });
  assert.ok(s.warnings.some((w) => w.includes('过度保守')));
});

/* ---------------------- 从决策产物推导记录 ---------------------- */

function fakeDecision() {
  return {
    schema: 'jev/decision@1',
    questions: [
      { id: 'q-choice', type: 'choice', instructions: '选', criteria: { A: '甲', B: '乙' } },
      { id: 'q-score', type: 'score', instructions: '难度', criteria: ['低', '中', '高'] },
      { id: 'q-noul', type: 'noul', instructions: '成立吗？' },
    ],
    response: {
      model: 'm',
      answers: {
        'q-choice': { type: 'choice', choice: 'B', probabilities: { A: 0.3, B: 0.7 }, confidence: 0.6 },
        'q-score': { type: 'score', score: 2, legend: { 0: '低', 1: '中', 2: '高' }, probabilities: { 0: 0, 1: 0.2, 2: 0.8 }, confidence: 0.7 },
        'q-noul': { type: 'noul', noul: 0.9 },
      },
      usage: {},
    },
  };
}

test('recordsFromDecision：三种题型都能推导出记录', () => {
  const recs = recordsFromDecision(fakeDecision(), { 'q-choice': 'B', 'q-score': 2, 'q-noul': 1 });
  assert.equal(recs.length, 3);
  const [c, s, n] = recs;
  assert.equal(c.correct, 1);
  assert.equal(c.winning_probability, 0.7, '应为被选中项的自身概率');
  assert.equal(s.correct, 1);
  assert.equal(s.winning_probability, 0.8);
  assert.equal(n.correct, 1);
  assert.equal(n.winning_probability, 0.9, 'noul 取命题为真的那一侧概率');
});

test('recordsFromDecision：答错时记录为 0，并用标准答案那侧的概率', () => {
  const recs = recordsFromDecision(fakeDecision(), { 'q-choice': 'A', 'q-noul': 0 });
  const c = recs.find((r) => r.question === 'q-choice');
  const n = recs.find((r) => r.question === 'q-noul');
  assert.equal(c.correct, 0);
  assert.equal(c.winning_probability, 0.3, '标准答案是 A，应取 A 的概率');
  assert.equal(n.correct, 0);
  assert.equal(n.winning_probability, 0.1, '标准答案为「不成立」时应取 1−0.9');
});

test('recordsFromDecision：没标注的题直接跳过，不猜', () => {
  const recs = recordsFromDecision(fakeDecision(), { 'q-choice': 'B' });
  assert.equal(recs.length, 1);
});

test('recordsFromDecision：标注了不存在的选项时跳过而不是算错', () => {
  const recs = recordsFromDecision(fakeDecision(), { 'q-choice': 'Z' });
  assert.equal(recs.length, 0);
});

test('recordsFromDecision → summarize 能串起来', () => {
  const recs = recordsFromDecision(fakeDecision(), { 'q-choice': 'B', 'q-score': 2, 'q-noul': 1 });
  const s = summarize(recs, { minSamples: 1 });
  assert.equal(s.n, 3);
  assert.equal(s.accuracy, 1);
  assert.equal(s.warnings.some((w) => w.includes('样本只有')), false, '样本足够时不该有样本量警告');
  // 三条全对、平均置信度只有 0.65 → 会被判为过度保守，这是对的（校准是分组性质）
  assert.ok(s.warnings.some((w) => w.includes('过度保守')));
});
