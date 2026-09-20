/**
 * @module providers
 * provider 注册表：决定第三步「谁来做出判断」。
 *
 * 两个 provider 的差别只在**判断这一步由谁执行**：
 *
 *   agent    —— 当前 Agent（DSH 里正在和你对话的模型）填 `judgment.json`，无需 key，离线可用，默认。
 *   deepseek —— 本技能直接调 DeepSeek API，可脚本化、可 `--samples N` 测一致性，需要 key。
 *
 * 两者之后的路径完全一致：同一份 judge 提示、同一套校验、同一个 softmax 与置信度公式。
 * 所以切换 provider **不会改变 JSON 的格式，只会改变判断的来源**（记录在 provenance.provider）。
 */

import { agentProvider } from './agent.mjs';
import { deepseekProvider } from './deepseek.mjs';

export const PROVIDERS = [agentProvider, deepseekProvider];

const REGISTRY = new Map();
for (const p of PROVIDERS) {
  REGISTRY.set(p.id, p);
  for (const alias of p.aliases || []) REGISTRY.set(alias, p);
}
// 便于人肉输入的别名
REGISTRY.set('current', agentProvider);
REGISTRY.set('self', agentProvider);
REGISTRY.set('ds', deepseekProvider);

export const DEFAULT_PROVIDER = 'agent';

/** 取 provider；未知名字直接报错并列出可用项（不静默降级）。 */
export function resolveProvider(name) {
  const key = String(name || DEFAULT_PROVIDER).trim().toLowerCase();
  const p = REGISTRY.get(key);
  if (!p) {
    throw new Error(`未知 provider：${name}（可用：${PROVIDERS.map((x) => x.id).join(' / ')}）`);
  }
  return p;
}

export function listProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    needs_key: p.needs_key,
    offline: p.offline,
  }));
}
