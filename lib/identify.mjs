/**
 * @module identify
 * 第一步：领域识别。
 *
 * 设计取舍（为什么不用「让模型直接说出领域」）：
 *
 *  - **可复现**：同一个输入永远得到同一份打分，包含命中了哪些词、每个词贡献多少分。
 *    模型直接给结论则无法 diff，也无法解释「为什么判成数学」。
 *  - **可校准阈值**：置信度是一个由证据量、优势占比、领先幅度三项算出的数，
 *    低于阈值就**不猜**，而是把候选领域抛回给用户确认——这正是第一步该做的事。
 *  - **模型仍有位置**：用户明确指定领域时直接用（source=user）；规则识别低置信时，
 *    调用方（Agent）可以复核 `candidates` 后传入 `--domain` 覆盖。
 *
 * 词表分强/中/弱三档（权重 3/2/1），另有正则模式与**反证词**。
 * 反证词很关键：没有它，「求导数的英语表达」会被英语和数学同时命中而拉平。
 */

import { clamp, countKeyword, squeeze } from './util.mjs';
import { SCORABLE_DOMAINS, requireDomain } from './domains/index.mjs';

const WEIGHT = { strong: 3, medium: 2, weak: 1 };

/** 引擎可调参数：改这里会改变识别松紧，必须同步 docs/DESIGN.md 与测试。 */
export const IDENTIFY_TUNING = Object.freeze({
  /** 证据量饱和系数：mass_sat = mass / (mass + K) */
  mass_saturation: 6,
  /** 置信度三项权重：优势占比 / 领先幅度 / 证据量 */
  weights: Object.freeze({ share: 0.35, margin: 0.35, mass: 0.3 }),
  /** 置信度低于此值时判为「不确定」，应回问用户 */
  auto_threshold: 0.55,
  /** 前两名原始分之差小于此比例时，提示易混淆 */
  tie_ratio: 0.15,
});

/**
 * 对单个领域打分。
 * @returns {{raw:number, hits:Array<{term:string,weight:number,count:number,kind:string}>}}
 */
function scoreDomain(domain, text) {
  const hits = [];
  let raw = 0;

  for (const kind of ['strong', 'medium', 'weak']) {
    for (const term of domain.lexicon?.[kind] || []) {
      const count = countKeyword(text, term);
      if (count > 0) {
        const weight = WEIGHT[kind];
        // 同一个词出现多次只加成到 3 次：再多的重复不再提供新证据
        const effective = weight * Math.min(count, 3);
        raw += effective;
        hits.push({ term, weight, count, kind, score: effective });
      }
    }
  }

  for (const entry of domain.lexicon?.patterns || []) {
    const [re, weight, note] = entry;
    const m = String(text).match(re);
    if (m) {
      raw += weight;
      hits.push({ term: m[0].slice(0, 40), weight, count: 1, kind: 'pattern', note, score: weight });
    }
  }

  for (const [term, penalty] of domain.lexicon?.excludes || []) {
    if (countKeyword(text, term) > 0) {
      raw -= penalty;
      hits.push({ term, weight: -penalty, count: 1, kind: 'exclude', score: -penalty });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return { raw, hits };
}

/**
 * 识别领域。
 *
 * @param {{text:string, hint?:string}} args
 *   - `text`：用户输入（问题、题干、一段描述都可能）
 *   - `hint`：用户或上游已经指定的领域（优先，直接采用）
 */
export function identifyDomain({ text = '', hint = '' } = {}) {
  const input = squeeze(text);

  if (hint) {
    const d = requireDomain(hint);
    return {
      schema: 'jev/domain@1',
      input,
      source: 'user',
      domain: { id: d.id, name: d.name, category: d.category },
      confidence: 1,
      decision: 'auto',
      margin: 1,
      evidence_mass: 0,
      scores: [],
      candidates: [],
      notes: ['领域由用户直接指定，未做规则识别。'],
    };
  }

  const scored = SCORABLE_DOMAINS.map((d) => {
    const { raw, hits } = scoreDomain(d, input);
    return { id: d.id, name: d.name, category: d.category, raw, hits };
  });

  const positive = scored.map((s) => Math.max(s.raw, 0));
  const mass = positive.reduce((a, b) => a + b, 0);
  const n = scored.length;
  const ranked = [...scored].sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id));
  const top = ranked[0];
  const second = ranked[1];

  const share = mass > 0 ? Math.max(top.raw, 0) / mass : 0;
  const flat = 1 / n;
  const shareNorm = n > 1 ? clamp((share - flat) / (1 - flat), 0, 1) : share;
  const marginNorm = top.raw > 0 ? clamp((top.raw - Math.max(second.raw, 0)) / top.raw, 0, 1) : 0;
  const massSat = mass / (mass + IDENTIFY_TUNING.mass_saturation);
  const w = IDENTIFY_TUNING.weights;
  const confidence = clamp(w.share * shareNorm + w.margin * marginNorm + w.mass * massSat, 0, 1);

  const scores = scored
    .map((s) => ({
      ...s,
      share: mass > 0 ? Math.max(s.raw, 0) / mass : 0,
    }))
    .sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id));

  const notes = [];
  let decision = 'auto';

  if (mass <= 0) {
    decision = 'ask';
    notes.push('没有任何领域词命中：输入太短或过于抽象，请用户指明领域。');
  } else if (confidence < IDENTIFY_TUNING.auto_threshold) {
    decision = 'ask';
    notes.push(
      `识别置信度 ${confidence.toFixed(2)} 低于阈值 ${IDENTIFY_TUNING.auto_threshold}：证据不足，应让用户在候选中确认而不是替用户决定。`,
    );
  }
  if (
    second.raw > 0 &&
    (top.raw - second.raw) / top.raw < IDENTIFY_TUNING.tie_ratio
  ) {
    notes.push(
      `「${top.name}」与「${second.name}」得分接近（${top.raw} vs ${second.raw}）：` +
        '若两者边界模糊（如常识与科学、科学与数学），建议用户确认。',
    );
  }
  if (top.raw > 0) {
    notes.push(
      `判定依据：「${top.hits.slice(0, 5).map((h) => h.term).join('」「') || '（无）'}」等 ${top.hits.length} 条证据。`,
    );
  }

  const domain = decision === 'auto'
    ? { id: top.id, name: top.name, category: top.category }
    : { id: 'other', name: '其他', category: '自定领域' };

  return {
    schema: 'jev/domain@1',
    input,
    source: 'rule',
    domain,
    decided_domain: { id: top.id, name: top.name, category: top.category },
    confidence: Number(confidence.toFixed(4)),
    decision,
    margin: Number(marginNorm.toFixed(4)),
    evidence_mass: mass,
    scores: scores.map((s) => ({
      id: s.id,
      name: s.name,
      raw: s.raw,
      share: Number(s.share.toFixed(4)),
      hits: s.hits.slice(0, 8),
    })),
    candidates: ranked.slice(0, 3).map((s) => ({ id: s.id, name: s.name, raw: s.raw })),
    notes,
  };
}
