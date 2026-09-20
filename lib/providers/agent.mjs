/**
 * @module providers/agent
 * provider：agent —— 「当前 Agent 的模型」。
 *
 * 这是本技能在 DSH 里**默认**的工作方式，也是最省事、最透明的一种：
 *
 *   技能负责出题、校验、算概率；**正在和你对话的那个模型**负责判断。
 *   它不需要 API key，不需要联网（用不上），判断依据（basis）直接落在产物里可审。
 *
 * 代价是「判断」这一步要由 Agent 显式交一份 `judgment.json`，所以流程是两拍的：
 *
 *   1. `jev decide --questions q.json --emit-prompt` → 写出 `judgment-prompt.md` 与 `judgment.template.json`
 *   2. Agent（或人）读提示、填好 `judgment.json`
 *   3. `jev decide --questions q.json --judgment judgment.json` → 产出固定 JSON
 *
 * 为什么要两拍而不是一步到位：一步到位意味着技能要在内部再调一次模型，
 * 那样「谁做的判断」就变得不可见了——而这恰恰是 Jev 这类决策层最需要能追溯的东西。
 *
 * ## 多次采样（一致性测量）
 *
 * Agent 也能做一致性测量，但方式不同：它得**独立填 N 份判断表**，而不是重复调用同一段代码。
 * 所以 `judgment.json` 允许写成 `{schema, samples: [judgment1, judgment2, …]}`。
 * 若传了 `--samples N`（N>1）却没给 `samples` 数组，**这里直接报错而不是静默退化成 1 次采样**——
 * 静默退化会让 `consistency` 空着，而调用方以为做过一致性检查，那比没做更糟。
 */

export const agentProvider = {
  id: 'agent',
  name: '当前 Agent 的模型',
  description: '由当前对话中的模型（如 deepseek-v4-flash）填写判断表，本技能负责校验与换算。不需要 API key。',
  needs_judgment: true,
  needs_key: false,
  offline: true,

  /**
   * @param {{judgment:object|{samples:object[]}, model?:string, samples?:number}} args
   */
  async run({ judgment, model = 'agent', samples = 1 }) {
    if (!judgment) {
      throw new Error('provider=agent 需要 --judgment <file>；先用 --emit-prompt 拿到要填的提示与模板。');
    }

    const bundled = Array.isArray(judgment.samples) ? judgment.samples : null;
    const notes = ['判断由当前 Agent 提供，未经过网络调用：usage 为 0 是正常的，不代表没做事。'];

    if (bundled) {
      if (bundled.length < 2) {
        throw new Error(`judgment.samples 只有 ${bundled.length} 条：做一致性测量至少要 2 条，否则删掉 samples 字段直接给单条判断。`);
      }
      notes.push(`使用 judgment.samples 里的 ${bundled.length} 份判断做一致性测量（由 Agent 独立填写的多份判断表）。`);
      return {
        judgments: bundled,
        model: `jev-agent/${model}`,
        usage: { input_tokens: 0, output_tokens: 0 },
        notes,
      };
    }

    if (samples > 1) {
      throw new Error(
        `provider=agent 无法自行重复采样（--samples ${samples}）。两种做法：\n` +
          '  ① 测一致性：在 judgment.json 里写 {schema, samples: [判断1, 判断2, …]}，由你独立填多份判断表；\n' +
          '  ② 让技能自己重复调用：改用 --provider deepseek（需要 DEEPSEEK_API_KEY）。',
      );
    }

    return {
      judgments: [judgment],
      model: `jev-agent/${model}`,
      usage: { input_tokens: 0, output_tokens: 0 },
      notes,
    };
  },
};
