import test from 'node:test';
import assert from 'node:assert/strict';
import { countKeyword, entropy, parseArgs, round, stableId, clamp } from '../lib/util.mjs';

test('parseArgs 支持 --k v / --k=v / 裸 flag', () => {
  const { flags, positional } = parseArgs(['--a', '1', '--b=2', '--c', 'pos', '--d']);
  assert.equal(flags.a, '1');
  assert.equal(flags.b, '2');
  assert.equal(flags.c, 'pos', '--c 后的非 -- 开头的 token 会被当作它的值');
  assert.equal(flags.d, true, '--d 后面没有 token，按裸 flag 处理');
  assert.deepEqual(positional, []);
});

test('parseArgs：值取走之后，后面的 token 回到 positional', () => {
  const { flags, positional } = parseArgs(['--domain', '数学', '解方程 x²-5x+6=0']);
  assert.equal(flags.domain, '数学');
  assert.deepEqual(positional, ['解方程 x²-5x+6=0']);
});

test('parseArgs 的值里可以有换行与等号', () => {
  const { flags } = parseArgs(['--input', 'line1\nA. x=1\nB. x=2', '--eq', 'a=b=c']);
  assert.match(flags.input, /A\. x=1/);
  assert.equal(flags.eq, 'a=b=c');
});

test('countKeyword：英文走词边界，中文走包含', () => {
  assert.equal(countKeyword('this is interesting', 'in'), 0, 'in 不应命中 interesting');
  assert.equal(countKeyword('in the box, in it', 'in'), 2);
  assert.equal(countKeyword('解方程与方程的解', '方程'), 2);
  assert.equal(countKeyword('', 'x'), 0);
});

test('entropy：均匀分布为 ln(n)，确定分布为 0', () => {
  assert.equal(round(entropy([1]), 6), 0);
  assert.equal(round(entropy([0.5, 0.5]), 6), round(Math.log(2), 6));
  assert.equal(round(entropy([1 / 4, 1 / 4, 1 / 4, 1 / 4]), 6), round(Math.log(4), 6));
  assert.equal(entropy([0, 1, 0]), 0, '0·ln0 记 0');
});

test('stableId 可复现、不同输入不同', () => {
  assert.equal(stableId('q', 'abc'), stableId('q', 'abc'));
  assert.notEqual(stableId('q', 'abc'), stableId('q', 'abd'));
  assert.match(stableId('q', 'abc'), /^q-[0-9a-f]{8}$/);
});

test('round 处理二进制误差', () => {
  assert.equal(round(0.145, 2), 0.15);
  assert.equal(round(1.005, 2), 1.01);
});

test('clamp', () => {
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
});
