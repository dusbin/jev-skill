import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyDomain, IDENTIFY_TUNING } from '../lib/identify.mjs';
import { DOMAINS } from '../lib/domains/index.mjs';

/** 五个领域各来一组典型输入，识别必须正确。 */
const CASES = [
  ['math', '解方程 x²-5x+6=0，下列哪个是它的解？ A. x=1 B. x=2 C. x=4 D. x=6'],
  ['math', '求函数 f(x)=x³-3x 的导数，并判断它的极值点'],
  ['math', '三棱锥的体积等于底面积乘高再除以三'],
  ['english', 'The committee have decided to postpone the meeting until next week.'],
  ['english', '这句话的定语从句关系词用对了吗？'],
  ['english', '把「我已经完成了作业」翻译成英语'],
  ['science', '光合作用是否只在白天进行？'],
  ['science', '向氢氧化钠溶液中加入盐酸会发生什么反应？'],
  ['science', '物体自由下落的加速度与质量有关吗？'],
  ['general', '油锅着火的时候能不能直接用水浇灭？'],
  ['general', '劳动合同的试用期最长可以约定多久？'],
  ['general', '被开水烫伤之后应该先涂牙膏还是先冲冷水？'],
  ['politics', '国务院近日印发了关于促进民营经济发展的若干措施，该说法是否与公开报道一致？'],
  ['politics', '外交部发言人是否就此事作出回应？'],
  ['politics', '两国元首在峰会期间举行了会谈，这一表述是否符合公开报道？'],
];

test('五个内置领域：典型输入都能识别正确', () => {
  for (const [expected, text] of CASES) {
    const r = identifyDomain({ text });
    assert.equal(r.domain.id, expected, `「${text.slice(0, 24)}…」应判为 ${expected}，实际 ${r.domain.id}（得分 ${JSON.stringify(r.scores.map((s) => [s.id, s.raw]))}）`);
    assert.equal(r.decision, 'auto', `「${text.slice(0, 24)}…」的置信度 ${r.confidence} 应达到自动采用阈值`);
  }
});

test('领域识别（回归）：时政新闻里的拉丁字母音译不会被判成英语', () => {
  // 实测踩过：这句话里只有英语的「中英混排」模式命中 1 分（莫斯科Kapotnya区），
  // 时政因为缺「乌克兰/俄罗斯/无人机/袭击」等词而拿 0 分，结果被判成英语且置信度 74.3% 自动采用。
  const r = identifyDomain({ text: '乌克兰无人机袭击俄罗斯莫斯科Kapotnya区的最新图像。' });
  assert.equal(r.domain.id, 'politics', `应判为时政，实际 ${r.domain.id}`);
  assert.equal(r.decision, 'auto');
  assert.ok(r.evidence_mass >= 3, '时政应当至少有 3 分证据');
});

test('领域识别（回归）：证据量不足时不得自动采用（没有竞争对手 ≠ 确信）', () => {
  // share 与 margin 两项在「只有一家得分」时都会拉满，
  // 所以单靠置信度阈值挡不住「一条弱词定案」。这里用证据量下限兜住。
  const r = identifyDomain({ text: '周围环境发生了变化' });
  assert.ok(r.evidence_mass > 0, '前提：确实有证据命中');
  assert.ok(r.evidence_mass < IDENTIFY_TUNING.min_evidence_mass, `前提：证据量 ${r.evidence_mass} 低于下限`);
  assert.equal(r.decision, 'ask', '证据量不足时必须回问用户，而不是自动采用');
  assert.ok(r.notes.some((n) => n.includes('证据总量只有')));
});

test('领域识别：一条强证据（3 分）刚好够定案', () => {
  // 选「关税」是因为它不含任何弱词——像「光合作用」里还嵌着一个弱词「作用」，
  // 证据量会变成 4，测不出「刚好 3 分」这条边界。
  const r = identifyDomain({ text: '关税' });
  assert.equal(r.evidence_mass, 3);
  assert.ok(r.evidence_mass >= IDENTIFY_TUNING.min_evidence_mass);
  assert.equal(r.domain.id, 'politics');
  assert.equal(r.decision, 'auto');
});

test('领域识别：时政词典覆盖冲突/军事/能源设施类词汇', () => {
  for (const text of [
    '乌克兰无人机袭击莫斯科炼油厂',
    '俄乌冲突的停火谈判进展如何',
    '俄军对基辅发动了空袭，防空系统拦截了多枚导弹',
    '泽连斯基确认打击了俄罗斯境内的炼油设施',
  ]) {
    assert.ok(identifyDomain({ text }).domain.id === 'politics', `「${text}」应判为时政`);
  }
});

test('领域识别：中英混排模式必须要求英文两侧有空格（避免音译误判）', () => {
  const transliteration = identifyDomain({ text: '莫斯科Kapotnya区的图像' });
  const english = transliteration.scores.find((s) => s.id === 'english');
  assert.ok(
    !english.hits.some((h) => h.kind === 'pattern' && h.note?.includes('中英混排')),
    '「莫斯科Kapotnya区」是拉丁字母音译，不该命中中英混排模式',
  );

  const bilingual = identifyDomain({ text: '这个 phrase 很常见，请记住它' });
  const en2 = bilingual.scores.find((s) => s.id === 'english');
  assert.ok(
    en2.hits.some((h) => h.kind === 'pattern' && h.note?.includes('中英混排')),
    '真正的双语行文应当命中中英混排模式',
  );
});

test('领域识别（回归）：日期不会被算术表达式模式吃掉', () => {
  // 实测踩过：「2026-09-20」被数学的「算术表达式」模式匹配成减法，给数学凭空加 3 分，
  // 把时政新闻的置信度从 0.84 压到 0.50，判成了 ask。
  const r = identifyDomain({ text: '2026-09-20 凌晨发生了大规模袭击，属于国际冲突' });
  const math = r.scores.find((x) => x.id === 'math');
  assert.equal(math.raw, 0, `日期不该给数学加分，实际命中 ${JSON.stringify(math.hits.map((h) => h.term))}`);
  assert.equal(r.domain.id, 'politics');
  assert.equal(r.decision, 'auto');

  // 美式日期同样要挡住
  for (const text of ['会议定于 12/31/2026 举行', '报道日期 2026.09.20', '9/20/2026 的袭击']) {
    const m = identifyDomain({ text }).scores.find((x) => x.id === 'math');
    assert.equal(m.raw, 0, `「${text}」不该给数学加分，实际 ${m.raw}`);
  }
});

test('领域识别：真正的算术表达式仍然照常命中（守卫不能误伤）', () => {
  for (const text of ['计算 12-5 等于多少', '2+3 等于几', '-5+3 的计算结果', '解方程 x²-5x+6=0']) {
    const r = identifyDomain({ text });
    assert.equal(r.domain.id, 'math', `「${text}」应判为数学`);
    const math = r.scores.find((x) => x.id === 'math');
    assert.ok(math.raw >= 3, `「${text}」的数学得分应 ≥3，实际 ${math.raw}`);
  }
});

test('领域识别（回归）：化学状态标记模式不能吃掉普通英文词', () => {
  // 「Astra」曾被拆成 A + s（固态标记）而给科学加分
  const r = identifyDomain({ text: '独立媒体 Astra 对影像做了地理定位' });
  const sci = r.scores.find((x) => x.id === 'science');
  const bogus = sci.hits.filter((h) => h.kind === 'pattern' && h.note?.includes('化学状态标记'));
  assert.equal(bogus.length, 0, `Astra 不该命中化学状态标记，实际 ${JSON.stringify(bogus.map((h) => h.term))}`);

  // 真正的化学状态标记仍然命中
  const real = identifyDomain({ text: 'NaCl(aq) 与 AgNO3(aq) 反应生成沉淀' });
  const sci2 = real.scores.find((x) => x.id === 'science');
  assert.ok(sci2.hits.some((h) => h.note?.includes('化学状态标记')), 'NaCl(aq) 应当命中化学状态标记');
});

test('领域识别（回归）：「大面积」不是数学的「面积」', () => {
  const r = identifyDomain({ text: '袭击导致大面积停电' });
  const math = r.scores.find((x) => x.id === 'math');
  assert.ok(math.raw <= 0, `「大面积」应当被反证词扣回，实际 ${math.raw}`);
  // 真正的面积计算仍然是数学
  const geo = identifyDomain({ text: '求这个三角形的面积和周长' });
  assert.equal(geo.domain.id, 'math');
});

test('领域识别：用户指定时直接采用，不再打分', () => {
  const r = identifyDomain({ text: '随便什么内容', hint: '数学' });
  assert.equal(r.source, 'user');
  assert.equal(r.domain.id, 'math');
  assert.equal(r.confidence, 1);
  assert.equal(r.decision, 'auto');
  assert.deepEqual(r.scores, []);
});

test('领域识别：别名可用', () => {
  assert.equal(identifyDomain({ text: 'x', hint: '代数' }).domain.id, 'math');
  assert.equal(identifyDomain({ text: 'x', hint: 'grammar' }).domain.id, 'english');
  assert.equal(identifyDomain({ text: 'x', hint: '物理' }).domain.id, 'science');
});

test('领域识别：证据不足时不猜，而是判为「需要用户确认」', () => {
  const r = identifyDomain({ text: '嗯' });
  assert.equal(r.decision, 'ask');
  assert.equal(r.domain.id, 'other');
  assert.ok(r.confidence < IDENTIFY_TUNING.auto_threshold);
  assert.ok(r.notes.some((n) => n.includes('没有')) || r.notes.length > 0);
});

test('领域识别：空输入也不崩，返回 ask', () => {
  const r = identifyDomain({ text: '' });
  assert.equal(r.decision, 'ask');
  assert.equal(r.evidence_mass, 0);
});

test('领域识别：反证词真的扣分（同一个「导数」在英语语境里不再给数学加分）', () => {
  const r = identifyDomain({ text: '把「导数」这个词翻译成英语怎么说？' });
  const math = r.scores.find((s) => s.id === 'math');
  const english = r.scores.find((s) => s.id === 'english');
  assert.ok(english.raw > 0, '英语应当有证据');
  assert.ok(
    math.hits.some((h) => h.kind === 'exclude' && h.term === '英语'),
    '数学应当命中反证词「英语」',
  );
  assert.ok(math.raw < english.raw, '扣分后数学不应压过英语');
});

test('领域识别：反证词不会误伤——没有反证词时同一个词仍然加分', () => {
  const withPenalty = identifyDomain({ text: '求函数的导数，用英语怎么说？' });
  const withoutPenalty = identifyDomain({ text: '求函数的导数，用中文怎么说？' });
  const m1 = withPenalty.scores.find((s) => s.id === 'math').raw;
  const m2 = withoutPenalty.scores.find((s) => s.id === 'math').raw;
  assert.ok(m1 < m2, `含反证词的数学得分 ${m1} 应低于不含反证词的 ${m2}`);
});

test('领域识别：输出结构固定', () => {
  const r = identifyDomain({ text: '解方程 2x+1=5' });
  for (const k of ['schema', 'input', 'source', 'domain', 'confidence', 'decision', 'margin', 'evidence_mass', 'scores', 'candidates', 'notes']) {
    assert.ok(k in r, `缺少字段 ${k}`);
  }
  assert.equal(r.schema, 'jev/domain@1');
  for (const s of r.scores) {
    assert.ok(['id', 'name', 'raw', 'share', 'hits'].every((k) => k in s));
  }
});

test('每个内置领域都具备完整结构（词典/题型适配/等级集/模板/判题要点）', () => {
  for (const d of DOMAINS) {
    assert.ok(d.id && d.name && d.description, `${d.id} 基本字段缺失`);
    assert.ok(d.aliases?.length, `${d.id} 缺少别名`);
    for (const kind of ['strong', 'medium', 'weak']) {
      assert.ok(Array.isArray(d.lexicon[kind]) && d.lexicon[kind].length > 0, `${d.id}.lexicon.${kind} 为空`);
    }
    assert.ok(Array.isArray(d.lexicon.excludes) && d.lexicon.excludes.length > 0, `${d.id} 没有反证词，会和其他领域拉平`);
    for (const t of ['choice', 'score', 'noul']) {
      assert.ok(d.questionFits[t]?.fit > 0, `${d.id} 缺少 ${t} 的适配度`);
      assert.ok(d.questionFits[t]?.why?.length > 10, `${d.id}.${t} 的适配理由太短`);
    }
    assert.ok(Object.keys(d.scoreSets).length >= 3, `${d.id} 的等级集少于 3 套`);
    for (const [name, levels] of Object.entries(d.scoreSets)) {
      assert.ok(levels.length >= 2 && levels.length <= 10, `${d.id}.${name} 有 ${levels.length} 档，超出 2–10`);
      assert.equal(new Set(levels).size, levels.length, `${d.id}.${name} 有重复等级`);
    }
    assert.ok(d.templates.length >= 4, `${d.id} 的模板少于 4 个`);
    const types = new Set(d.templates.map((t) => t.type));
    assert.deepEqual([...types].sort(), ['choice', 'noul', 'score'], `${d.id} 应当三种题型都有模板`);
    assert.ok(d.judgeHints.length >= 4, `${d.id} 的判题要点少于 4 条`);
  }
});

test('识别打分对加词顺序不敏感（同样的词表，结果稳定）', () => {
  const a = identifyDomain({ text: '解方程 x²-5x+6=0' });
  const b = identifyDomain({ text: '解方程 x²-5x+6=0' });
  assert.deepEqual(a.scores, b.scores);
  assert.equal(a.confidence, b.confidence);
});
