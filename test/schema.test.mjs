import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_TUNING,
  GENERATOR,
  LIMITS,
  SCHEMA_ID,
  SchemaError,
  makeEnvelope,
  validateDecision,
  validateJevAnswer,
  validateJevRequest,
  validateJevResponse,
  validateJudgment,
} from '../lib/schema.mjs';

/* ---------------------------- Jev 答案 ---------------------------- */

test('validateJevAnswer：三种合法形状', () => {
  assert.equal(validateJevAnswer({ type: 'noul', noul: 0.93 }).ok, true);
  assert.equal(
    validateJevAnswer(
      { type: 'choice', choice: 'B', probabilities: { A: 0.4, B: 0.6 }, confidence: 0.5 },
      { options: ['A', 'B'] },
    ).ok,
    true,
  );
  assert.equal(
    validateJevAnswer(
      {
        type: 'score', score: 0.5, legend: { 0: '低', 1: '高' },
        probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.1,
      },
      { levels: ['低', '高'] },
    ).ok,
    true,
  );
});

test('validateJevAnswer：noul 不许带 confidence（Jev 的 noul 没有这个字段）', () => {
  const r = validateJevAnswer({ type: 'noul', noul: 0.5, confidence: 0.9 });
  assert.ok(r.warnings.some((w) => w.includes('额外字段')));
});

test('validateJevAnswer：概率和必须为 1', () => {
  const r = validateJevAnswer({ type: 'choice', choice: 'A', probabilities: { A: 0.5, B: 0.4 }, confidence: 0.3 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('之和')));
});

test('validateJevAnswer：choice 必须是 argmax', () => {
  const r = validateJevAnswer({ type: 'choice', choice: 'A', probabilities: { A: 0.4, B: 0.6 }, confidence: 0.2 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('不是概率最大的选项')));
});

test('validateJevAnswer：概率键必须覆盖全部选项', () => {
  const r = validateJevAnswer(
    { type: 'choice', choice: 'A', probabilities: { A: 1 }, confidence: 1 },
    { options: ['A', 'B'] },
  );
  assert.equal(r.ok, false);
});

test('validateJevAnswer：score 必须与概率加权期望一致（Jev 的定义）', () => {
  const bad = validateJevAnswer(
    {
      type: 'score', score: 0.1, legend: { 0: '低', 1: '高' },
      probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.1,
    },
    { levels: ['低', '高'] },
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('概率加权期望')));

  const good = validateJevAnswer(
    {
      type: 'score', score: 0.5, legend: { 0: '低', 1: '高' },
      probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.1,
    },
    { levels: ['低', '高'] },
  );
  assert.equal(good.ok, true);
});

test('validateJevAnswer：legend 必须逐档对上 criteria', () => {
  const r = validateJevAnswer(
    {
      type: 'score', score: 1, legend: { 0: '低', 1: '错的高' },
      probabilities: { 0: 0, 1: 1 }, confidence: 1,
    },
    { levels: ['低', '高'] },
  );
  assert.equal(r.ok, false);
});

test('validateJevAnswer：未知 type 直接拒绝', () => {
  assert.equal(validateJevAnswer({ type: 'completion', text: 'hi' }).ok, false);
});

/* ---------------------------- Jev 请求/响应 ---------------------------- */

test('validateJevRequest：合法请求通过，缺字段报错', () => {
  const ok = validateJevRequest({
    model: 'jev-latest',
    state: '一句话',
    questions: { q1: { type: 'noul', instructions: '成立吗？' } },
  });
  assert.equal(ok.ok, true);

  assert.equal(validateJevRequest({ state: 'x', questions: {} }).ok, false);
  assert.equal(validateJevRequest({ model: 'x', state: 'x', questions: {} }).ok, false);
  assert.equal(validateJevRequest({ model: 'x', state: 'x' }).ok, false);
});

test('validateJevRequest：请求里也必须遵守选项上限', () => {
  const five = { type: 'choice', instructions: '选', criteria: { A: '1', B: '2', C: '3', D: '4', E: '5' } };
  assert.equal(validateJevRequest({ model: 'x', state: 's', questions: { q: five } }).ok, false);
  assert.equal(validateJevRequest({ model: 'x', state: 's', questions: { q: five } }, { maxOptions: 5 }).ok, true);
});

test('validateJevResponse：答案齐全且合法才通过', () => {
  const questions = { q1: { type: 'choice', instructions: '选', criteria: { A: '甲', B: '乙' } } };
  const ok = validateJevResponse(
    { model: 'm', answers: { q1: { type: 'choice', choice: 'A', probabilities: { A: 0.7, B: 0.3 }, confidence: 0.4 } }, usage: {} },
    questions,
  );
  assert.equal(ok.ok, true);

  const missing = validateJevResponse({ model: 'm', answers: {}, usage: {} }, questions);
  assert.equal(missing.ok, false);

  const wrongType = validateJevResponse(
    { model: 'm', answers: { q1: { type: 'noul', noul: 0.5 } }, usage: {} },
    questions,
  );
  assert.equal(wrongType.ok, false);
});

/* ---------------------------- 信封 ---------------------------- */

function goodEnvelope() {
  return makeEnvelope({
    generatedAt: '2026-03-02T10:00:00Z',
    domain: { id: 'math', name: '数学', category: '学科类', source: 'user' },
    questions: [
      { id: 'q1', type: 'choice', instructions: '选一个', criteria: { A: '甲', B: '乙' }, origin: 'predefined', template: 't', kind: 'answer', score_set: null, why: 'w' },
    ],
    request: { model: 'jev-latest', state: 's', questions: { q1: { type: 'choice', instructions: '选一个', criteria: { A: '甲', B: '乙' } } } },
    response: { model: 'm', answers: { q1: { type: 'choice', choice: 'A', probabilities: { A: 0.7, B: 0.3 }, confidence: 0.4 } }, usage: { input_tokens: 1, output_tokens: 1 } },
    judgment: { schema: 'jev/judgment@1', answers: { q1: { type: 'choice', scores: { A: 1, B: 0 } } } },
    derivation: { q1: { kind: 'choice', method: 'softmax' } },
    consistency: null,
    provenance: { provider: 'agent', engine: {}, limits: {} },
  });
}

test('makeEnvelope：字段顺序与数量固定', () => {
  const doc = goodEnvelope();
  assert.deepEqual(Object.keys(doc), [
    'schema', 'kind', 'generated_at', 'generator', 'domain', 'questions',
    'request', 'response', 'judgment', 'derivation', 'consistency', 'provenance',
  ]);
  assert.equal(doc.schema, SCHEMA_ID);
  assert.equal(doc.kind, 'decision');
  assert.deepEqual(doc.generator, { ...GENERATOR });
});

test('makeEnvelope：不合法直接抛 SchemaError，不产出半成品', () => {
  assert.throws(
    () => makeEnvelope({
      generatedAt: '2026-03-02T10:00:00Z',
      domain: { id: 'math', name: '数学', category: '学科类' },
      questions: [{ id: 'q1', type: 'choice', instructions: '选', criteria: { A: '1', B: '2' }, origin: 'predefined' }],
      request: { model: 'm', state: 's', questions: { q1: { type: 'choice', instructions: '选', criteria: { A: '1', B: '2' } } } },
      // response 里 confidence 缺失 → 必须抛错
      response: { model: 'm', answers: { q1: { type: 'choice', choice: 'A', probabilities: { A: 0.6, B: 0.4 } } }, usage: {} },
      judgment: {},
      provenance: { provider: 'agent', engine: {} },
    }),
    SchemaError,
  );
});

test('validateDecision：能指出具体是哪个字段坏了', () => {
  const doc = goodEnvelope();
  doc.response.answers.q1.confidence = 2;
  const r = validateDecision(doc);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('answers.q1')));
});

test('validateDecision：缺少 provenance 的 engine 会警告（无法复现）', () => {
  const doc = goodEnvelope();
  delete doc.provenance.engine;
  const r = validateDecision(doc);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('engine')));
});

/* ---------------------------- 判断表 ---------------------------- */

test('validateJudgment：缺选项的支持度要报错，而不是补 0', () => {
  const specs = { q1: { type: 'choice', instructions: '选', criteria: { A: '甲', B: '乙' } } };
  const r = validateJudgment({ schema: 'jev/judgment@1', answers: { q1: { type: 'choice', scores: { A: 1 } } } }, specs);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('缺少 B')));
});

test('validateJudgment：多出未知键要报错（说明模型串了题）', () => {
  const specs = { q1: { type: 'choice', instructions: '选', criteria: { A: '甲', B: '乙' } } };
  const r = validateJudgment({ answers: { q1: { scores: { A: 1, B: 1, C: 1 } } } }, specs);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('多出 C')));
});

test('validateJudgment：noul 的 p 范围检查', () => {
  const specs = { q1: { type: 'noul', instructions: '成立吗？' } };
  assert.equal(validateJudgment({ answers: { q1: { p: 1.2 } } }, specs).ok, false);
  assert.equal(validateJudgment({ answers: { q1: { p: 0.2 } } }, specs).ok, true);
  assert.equal(validateJudgment({ answers: { q1: { support: 2.5 } } }, specs).ok, true);
});

test('validateJudgment：没覆盖到的问题给警告而不是错误', () => {
  const specs = { q1: { type: 'noul', instructions: 'a 成立吗？' }, q2: { type: 'noul', instructions: 'b 成立吗？' } };
  const r = validateJudgment({ answers: { q1: { p: 0.5 } } }, specs);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('q2')));
});

/* ---------------------------- 限制 ---------------------------- */

test('LIMITS：choice ≤4（本技能规格）、score 2–10（与 Jev 一致）', () => {
  assert.equal(LIMITS.choice.max, 4);
  assert.equal(LIMITS.score.min, 2);
  assert.equal(LIMITS.score.max, 10);
});

test('ENGINE_TUNING 是可复现的常量（不是从环境或随机数来的）', () => {
  assert.equal(ENGINE_TUNING.softmax_temperature, 1);
  assert.equal(ENGINE_TUNING.confidence_margin_weight, 0.75);
});
