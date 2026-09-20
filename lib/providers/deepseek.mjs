/**
 * @module providers/deepseek
 * provider：deepseek —— 直接调用 DeepSeek 的对话 API 做判断。
 *
 * 与 agent provider 的区别只有一个：判断这一步由技能自己去问模型，
 * 因此可以脚本化、可以批量、可以跑 `--samples N` 做一致性（self-consistency）测量。
 * 剩下的流程（校验、softmax、置信度、固定 JSON）与 agent 完全共用同一条代码路径。
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY（或 JEV_DEEPSEEK_API_KEY）  —— 必填
 *   JEV_DEEPSEEK_BASE_URL                        —— 可选，默认 https://api.deepseek.com
 *   JEV_DEEPSEEK_MODEL                           —— 可选，默认 deepseek-chat
 *
 * 只依赖 Node 内置的 fetch（Node ≥18），不引入任何 npm 包。
 */

import { buildJudgePrompt, normalizeJudgment, parseJudgmentText } from '../judge.mjs';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);

function resolveConfig(env = process.env) {
  const apiKey = env.JEV_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '';
  const baseUrl = (env.JEV_DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.JEV_DEEPSEEK_MODEL || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
}

async function postJson(url, body, { apiKey, timeoutMs = 120000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const retriable = RETRY_STATUS.has(res.status);
        lastError = new Error(`DeepSeek 返回 ${res.status}：${text.slice(0, 400)}`);
        if (retriable && attempt < retries) {
          await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
          continue;
        }
        throw lastError;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`DeepSeek 返回的不是 JSON：${text.slice(0, 200)}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries && (error.name === 'AbortError' || /ECONN|fetch failed|network/i.test(error.message))) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export const deepseekProvider = {
  id: 'deepseek',
  name: 'DeepSeek 对话模型',
  description: '由本技能直接调用 DeepSeek API 完成判断；支持 --samples 做一致性测量。需要 DEEPSEEK_API_KEY。',
  needs_judgment: false,
  needs_key: true,
  offline: false,

  /**
   * @param {{state:string, questions:object[], domain:object, model?:string,
   *          temperature?:number, samples?:number, apiKey?:string, baseUrl?:string, timeoutMs?:number}} args
   */
  async run({
    state,
    questions,
    domain,
    model,
    temperature = 0.7,
    samples = 1,
    apiKey,
    baseUrl,
    timeoutMs,
  }) {
    const cfg = resolveConfig();
    const key = apiKey || cfg.apiKey;
    if (!key) {
      throw new Error(
        'provider=deepseek 需要 API key：请设置环境变量 DEEPSEEK_API_KEY（或 JEV_DEEPSEEK_API_KEY）。\n' +
          '若不想用 API key，改用默认的 provider=agent：由当前 Agent 填写 --judgment。',
      );
    }
    const url = `${(baseUrl || cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const useModel = model || cfg.model;

    const judgeHints = domain?.judgeHints || [];
    const prompt = buildJudgePrompt({ state, questions, domain, judgeHints });

    const judgments = [];
    const notes = [];
    let inputTokens = 0;
    let outputTokens = 0;

    for (let i = 0; i < Math.max(1, samples); i++) {
      const data = await postJson(
        url,
        {
          model: useModel,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          // 采样一致性测量需要非零温度；单次判断时也用同一温度，保证两种模式可比
          temperature,
          stream: false,
        },
        { apiKey: key, timeoutMs },
      );
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`DeepSeek 响应里没有 content：${JSON.stringify(data).slice(0, 300)}`);
      const parsed = parseJudgmentText(content);
      const { judgment, notes: fixNotes } = normalizeJudgment(parsed, questions);
      judgments.push(judgment);
      notes.push(...fixNotes);
      inputTokens += data?.usage?.prompt_tokens ?? 0;
      outputTokens += data?.usage?.completion_tokens ?? 0;
    }

    if (samples > 1) {
      notes.push(`已采样 ${samples} 次：answers 由多次采样的概率分布取平均得到，一致性见 provenance.consistency。`);
    }

    return {
      judgments,
      model: `deepseek/${useModel}`,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      notes,
      prompt,
    };
  },
};

export { resolveConfig as resolveDeepseekConfig };
