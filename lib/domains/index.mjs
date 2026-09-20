/**
 * @module domains
 * 领域注册表。五个内置领域 + 一个「其他」兜底，每个领域自带：
 *
 *  - `lexicon`      —— 识别用的加权词典与正则模式（**识别靠证据，不靠感觉**）
 *  - `questionFits` —— 三种题型在该领域的适配度与理由（决定第二步优先出什么题）
 *  - `scoreSets`    —— 该领域常用的**有序等级集**（打分题的 criteria 直接取用）
 *  - `templates`    —— 预定义问题模板（确定性生成，不依赖模型）
 *  - `judgeHints`   —— 判题要点，会写进给模型/Agent 的判定提示里
 *
 * 新增领域：在本目录放一个 `xxx.mjs`，导出与 `math.mjs` 同形状的默认对象，
 * 然后在下面的 `BUILTIN` 数组里加一行即可。**不需要改任何其他代码**。
 */

import politics from './politics.mjs';
import math from './math.mjs';
import science from './science.mjs';
import general from './general.mjs';
import english from './english.mjs';

const BUILTIN = [politics, math, science, general, english];

/** 兜底领域：证据不足、或用户明确说「不确定」时使用。 */
export const FALLBACK_DOMAIN = Object.freeze({
  id: 'other',
  name: '其他',
  category: '自定领域',
  aliases: ['其他', '其它', '通用', 'other', 'misc'],
  description: '没有足够证据归入任何内置领域。此时问题类型与等级集都需要用户明确指定。',
  lexicon: { strong: [], medium: [], weak: [], patterns: [], excludes: [] },
  questionFits: {
    choice: { fit: 0.5, why: '选项由用户给出时可用。' },
    score: { fit: 0.5, why: '等级集必须由用户给出，否则无法确定序。' },
    noul: { fit: 0.7, why: '判断题不依赖领域知识，是兜底时最稳的题型。' },
  },
  scoreSets: {},
  templates: [],
  judgeHints: ['领域未知：只依据 state 中的字面信息判断，不要引入外部常识，并在 basis 里说明依据来源。'],
});

const REGISTRY = new Map();
for (const d of [...BUILTIN, FALLBACK_DOMAIN]) {
  REGISTRY.set(d.id, d);
  for (const alias of d.aliases || []) {
    const key = String(alias).trim().toLowerCase();
    if (key && !REGISTRY.has(key)) REGISTRY.set(key, d);
  }
}

/** 全部内置领域（不含兜底），供识别时打分。 */
export const DOMAINS = BUILTIN;

/** 识别时参与打分的候选领域（兜底领域不参与竞争）。 */
export const SCORABLE_DOMAINS = BUILTIN;

/** 按 id/名称/别名取领域；取不到返回 null。 */
export function getDomain(key) {
  if (!key) return null;
  return REGISTRY.get(String(key).trim().toLowerCase()) || null;
}

/** 取领域，取不到就抛错（CLI 用，避免静默降级）。 */
export function requireDomain(key) {
  const d = getDomain(key);
  if (!d) {
    const names = BUILTIN.map((x) => x.name).join(' / ');
    throw new Error(`未知领域：${key}（可用：${names}；查看全部用 \`jev domains\`）`);
  }
  return d;
}

/** 列出全部领域（含兜底）的摘要，供 `jev domains` 输出。 */
export function listDomains() {
  return [...BUILTIN, FALLBACK_DOMAIN].map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    aliases: d.aliases || [],
    description: d.description,
    scoreSets: Object.keys(d.scoreSets || {}),
    templateCount: (d.templates || []).length,
    questionFits: d.questionFits,
  }));
}

/**
 * 该领域默认的等级集。
 * @param {object} domain
 * @param {string} [name] 不传则取该领域第一个等级集
 */
export function getScoreSet(domain, name) {
  const sets = domain?.scoreSets || {};
  const keys = Object.keys(sets);
  if (keys.length === 0) return null;
  const key = name && sets[name] ? name : keys[0];
  return { name: key, levels: sets[key] };
}
