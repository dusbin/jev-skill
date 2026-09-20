/**
 * @module render
 * 终端渲染：把 JSON 产物变成人一眼能看懂的东西。
 *
 * 这一层**只读不写**：它从不修改数据，也从不产出文件（JSON 才是产物，终端只是提示）。
 * 这么分是为了让「看清」与「产出」解耦——用户可以在终端里看到一个漂亮的条形图，
 * 而拿去做下游消费的始终是那份固定的 JSON。
 */

import { ellipsis } from './util.mjs';

const BAR = '█';
const EMPTY = '·';

function bar(p, width = 20) {
  const filled = Math.round(p * width);
  return BAR.repeat(filled) + EMPTY.repeat(Math.max(0, width - filled));
}

const pct = (p) => `${(p * 100).toFixed(1)}%`.padStart(6);

/* ------------------------------------------------------------------ *
 * 第一步
 * ------------------------------------------------------------------ */

export function renderDomain(doc) {
  const lines = [];
  lines.push(`输入：${ellipsis(doc.input, 90) || '（空）'}`);
  lines.push('');
  if (doc.source === 'user') {
    lines.push(`领域：${doc.domain.name}（由用户指定）`);
  } else {
    lines.push(`领域：${doc.decision === 'auto' ? doc.decided_domain.name : '不确定'}　` +
      `置信度 ${(doc.confidence * 100).toFixed(1)}%　判定 ${doc.decision === 'auto' ? '自动采用' : '需要用户确认'}`);
    lines.push('');
    lines.push('候选领域得分：');
    for (const s of doc.scores) {
      const name = s.name.padEnd(4, '　');
      lines.push(`  ${name} ${bar(s.share)} ${String(s.raw).padStart(4)} 分（占比 ${(s.share * 100).toFixed(0)}%）`);
      if (s.hits.length) {
        const top = s.hits.slice(0, 4).map((h) => `${h.term}${h.kind === 'exclude' ? '(反证)' : ''}`);
        lines.push(`        命中：${top.join('、')}${s.hits.length > 4 ? ` 等 ${s.hits.length} 条` : ''}`);
      }
    }
  }
  if (doc.notes?.length) {
    lines.push('');
    for (const n of doc.notes) lines.push(`  · ${n}`);
  }
  if (doc.state_injection?.suspicious) {
    lines.push('');
    lines.push(`  ⚠ state 里有 ${doc.state_injection.findings.length} 处可能操纵判断的内容：`);
    for (const f of doc.state_injection.findings) lines.push(`      - ${f.pattern}：「${f.excerpt}」`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 第二步
 * ------------------------------------------------------------------ */

const TYPE_LABEL = { choice: '单选题 choice', score: '打分题 score', noul: '判断题 noul' };

export function renderCandidates(plan) {
  const lines = [];
  lines.push(`领域：${plan.domain.name}　state：${ellipsis(plan.state, 70) || '（空）'}`);
  if (plan.detected_options.length) {
    lines.push(`从输入里抽到 ${plan.detected_options.length} 个选项：` +
      plan.detected_options.map((o) => `${o.label}. ${ellipsis(o.text, 18)}`).join('　'));
  }
  if (plan.inferred_type) lines.push(`输入本身更像：${TYPE_LABEL[plan.inferred_type]}`);

  if (plan.truth_apt && plan.truth_apt.ok === false) {
    lines.push('');
    lines.push('  ⚠ 用户问题不是「有真值」的问题，Jev 给不出有意义的概率：');
    for (const r of plan.truth_apt.reasons) lines.push(`      - ${r}`);
    for (const r of plan.truth_apt.reformulations) lines.push(`      → 建议改写：${r}`);
  }

  lines.push('');
  lines.push(`候选问题（${plan.candidates.length} 条）：`);
  plan.candidates.forEach((q, i) => {
    const v = plan.validation[i];
    lines.push('');
    lines.push(`  ${String(i + 1).padStart(2)}. [${TYPE_LABEL[q.type]}] ${q.label}`);
    lines.push(`      问题：${ellipsis(String(q.instructions), 72)}`);
    if (q.type === 'choice') {
      const items = Object.entries(q.criteria || {});
      for (const [k, val] of items) lines.push(`        ${k}. ${ellipsis(val || '（无描述）', 60)}`);
    } else if (q.type === 'score') {
      (q.criteria || []).forEach((lv, j) => lines.push(`        [${j}] ${ellipsis(lv, 60)}`));
      if (q.score_set) lines.push(`        （等级集：${q.score_set}，${(q.criteria || []).length} 档）`);
    }
    if (q.why) lines.push(`      为什么：${ellipsis(q.why, 76)}`);
    for (const w of v?.warnings || []) lines.push(`      ⚠ ${w}`);
    for (const e of v?.errors || []) lines.push(`      ✗ ${e}`);
  });

  if (plan.notes?.length) {
    lines.push('');
    for (const n of plan.notes) lines.push(`  · ${n}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 第三步
 * ------------------------------------------------------------------ */

function confidenceAdvice(type, answer) {
  if (type === 'noul') {
    const p = answer.noul;
    if (p >= 0.7) return '倾向于「成立」';
    if (p <= 0.3) return '倾向于「不成立」';
    return '命题真假不明：Jev 的判断题里 0.5 附近表示「同真同假」，不是「中等强度」';
  }
  const c = answer.confidence;
  if (c >= 0.8) return '分布集中，可据此直接分支';
  if (c >= 0.5) return '分布较集中，但建议对高代价动作加确认';
  return '分布分散：这条结论不适合用于自动决策，建议补充 state 或改问法';
}

export function renderDecision(doc, { showJudgment = false } = {}) {
  const lines = [];
  const d = doc.domain;
  const SOURCE_LABEL = { user: '用户指定', rule: '规则识别', model: '模型复核' };
  lines.push(`领域：${d.name}（${SOURCE_LABEL[d.source] || d.source}）　provider：${doc.provenance.provider_name}　model：${doc.provenance.model}`);
  lines.push(`state：${ellipsis(doc.request.state, 80)}`);
  lines.push('');

  for (const spec of doc.questions) {
    const ans = doc.response.answers[spec.id];
    lines.push(`【${TYPE_LABEL[spec.type]}】${ellipsis(String(spec.instructions), 76)}`);
    lines.push('');

    if (spec.type === 'noul') {
      lines.push(`  命题为真的概率：${ans.noul.toFixed(4)}　（${confidenceAdvice('noul', ans)}）`);
      lines.push(`  ${bar(ans.noul, 30)} ${pct(ans.noul)}`);
    } else {
      const entries = Object.entries(ans.probabilities);
      // 高亮必须用 **概率最大** 的档位，不能用 Math.round(score)。
      // score 是概率加权期望，可以落在两档之间：0.50 四舍五入是 1，但概率最大的可能是 0——
      // 用 round(score) 会出现「箭头指 1、最高柱是 0」这种自相矛盾的渲染，读者会照着箭头走。
      const best = spec.type === 'choice'
        ? ans.choice
        : entries.reduce((a, [k, v]) => (v > (ans.probabilities[a] ?? -1) ? k : a), entries[0][0]);
      for (const [k, p] of entries) {
        const mark = k === best ? '←' : ' ';
        const label = k.padStart(2);
        lines.push(`  ${label} ${bar(p)} ${pct(p)} ${mark}`);
      }
      lines.push('');
      if (spec.type === 'choice') {
        lines.push(`  选中：${ans.choice}　置信度 ${ans.confidence.toFixed(4)}`);
      } else {
        const rounded = Math.round(ans.score);
        const differs = String(rounded) !== best;
        lines.push(
          `  score：${ans.score.toFixed(4)}（概率加权期望，落在档位之间是正常的）　置信度 ${ans.confidence.toFixed(4)}`,
        );
        const legendEntry = ans.legend?.[best];
        if (legendEntry) lines.push(`  概率最大的档位：第 ${best} 档 —— ${ellipsis(legendEntry, 60)}`);
        if (differs) {
          lines.push(
            `  注意：加权期望四舍五入到第 ${rounded} 档，但概率最大的档位是第 ${best} 档。` +
              '需要离散判决时用 --round-score 明确取整档，不要自行四舍五入。',
          );
        }
      }
      lines.push(`  ${confidenceAdvice(spec.type, ans)}`);
    }

    const der = doc.derivation?.[spec.id];
    if (der?.stats) {
      lines.push(
        `  分布：归一化优势 ${der.stats.normalized_margin}　归一化熵 ${der.stats.normalized_entropy}　` +
          `→ confidence = ${doc.provenance.engine.confidence_formula.replace('confidence = ', '')}`,
      );
    }
    const c = doc.consistency?.[spec.id];
    if (c) {
      lines.push(
        `  一致性：${c.samples} 次采样中 ${(c.agreement * 100).toFixed(0)}% 选择同一结果` +
          `${c.agreement < 1 ? `（翻转 ${c.flips ?? c.samples - Math.round(c.agreement * c.samples)} 次，这条结论不稳定）` : ''}`,
      );
    }

    if (showJudgment && doc.judgment?.answers?.[spec.id]) {
      const j = doc.judgment.answers[spec.id];
      if (j.scores) lines.push(`  支持度：${Object.entries(j.scores).map(([k, v]) => `${k}=${v}`).join('　')}`);
      if (typeof j.p === 'number') lines.push(`  模型给的 p：${j.p}`);
      for (const b of j.basis || []) lines.push(`  依据：${ellipsis(String(b), 90)}`);
    }
    lines.push('');
  }

  if (doc.provenance.state_injection?.suspicious) {
    lines.push(`  ⚠ state 里有 ${doc.provenance.state_injection.findings.length} 处可能操纵判断的内容，判断可能已被影响：`);
    for (const f of doc.provenance.state_injection.findings) lines.push(`      - ${f.pattern}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderProviders(list) {
  const lines = [];
  for (const p of list) {
    lines.push(`  ${p.id.padEnd(10)} ${p.name}${p.needs_key ? '（需要 API key）' : ''}`);
    lines.push(`             ${p.description}`);
  }
  return lines.join('\n');
}

export function renderDomains(list) {
  const lines = [];
  for (const d of list) {
    lines.push(`  ${d.id.padEnd(10)} ${d.name}　${d.category}`);
    lines.push(`             ${d.description}`);
    lines.push(`             等级集：${d.scoreSets.join('、') || '（无）'}　模板：${d.templateCount} 个`);
  }
  return lines.join('\n');
}
