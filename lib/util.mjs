/**
 * @module util
 * 零依赖工具：CLI 参数解析、ID/日期、数值与文本处理。
 */

import { createHash } from 'node:crypto';

/** 解析 `--key value` / `--flag` / `--key=value` 形式的参数。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[a.slice(2)] = true;
        } else {
          flags[a.slice(2)] = next;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/** 布尔型 flag 归一：'false'/'0'/'no'/'off'/'' 视为 false */
export function flagBool(v, dflt = false) {
  if (v === undefined) return dflt;
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return true;
}

/** 数值型 flag 归一；无法解析时返回默认值 */
export function flagNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/** 四舍五入到指定小数位（先加 EPSILON，避免 0.145 → 0.14 这类二进制误差）。 */
export function round(v, digits = 4) {
  const p = 10 ** digits;
  return Math.round((Number(v) + Number.EPSILON) * p) / p;
}

export const sum = (arr) => arr.reduce((a, b) => a + b, 0);

/**
 * 稳定 ID：前缀 + 内容短哈希。
 * 同样的输入永远得到同样的 ID，便于重跑与 diff（本技能全程不引入随机源）。
 */
export function stableId(prefix, seed) {
  const h = createHash('sha1').update(String(seed)).digest('hex').slice(0, 8);
  return `${prefix}-${h}`;
}

/** ISO 时间戳（秒精度，去掉毫秒便于 diff） */
export function nowIso(date = new Date()) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 折叠空白并 trim */
export function squeeze(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 截断到 n 个字符（用于终端展示，不用于数据） */
export function ellipsis(text, n = 60) {
  const s = squeeze(text);
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * 香农熵（自然对数）。p 中允许出现 0（0·ln0 记为 0）。
 */
export function entropy(ps) {
  let h = 0;
  for (const p of ps) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

/**
 * 关键词计数：返回命中位置与次数。
 * 中文没有词边界，所以用「包含」判断；英文/数字用词边界，避免 "in" 命中 "interesting"。
 */
export function countKeyword(text, keyword) {
  const t = String(text ?? '');
  const k = String(keyword ?? '');
  if (!k) return 0;
  if (/^[a-zA-Z0-9 _'-]+$/.test(k)) {
    const re = new RegExp(`(^|[^a-zA-Z0-9])${escapeRe(k.trim())}([^a-zA-Z0-9]|$)`, 'gi');
    return (t.match(re) || []).length;
  }
  let count = 0;
  let idx = 0;
  while (true) {
    const at = t.indexOf(k, idx);
    if (at === -1) break;
    count++;
    idx = at + k.length;
  }
  return count;
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉 Markdown 装饰与多余符号，得到可读纯文本 */
export function plainText(text) {
  return squeeze(
    String(text ?? '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_>#]/g, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1'),
  );
}
