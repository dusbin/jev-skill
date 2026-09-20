#!/usr/bin/env node
/**
 * jev-decide — 第三步：执行决策，输出**固定 JSON**。
 *
 * 两种工作方式：
 *
 *  ① provider=agent（默认）——由当前 Agent 填写判断表。两拍：
 *       node scripts/jev-decide.mjs --questions out/questions.json --emit-prompt
 *       # → 写出 judgment-prompt.md 与 judgment.template.json
 *       # 读提示、填好 judgment.json
 *       node scripts/jev-decide.mjs --questions out/questions.json --judgment judgment.json
 *
 *  ② provider=deepseek ——由本技能直接调用 DeepSeek API：
 *       DEEPSEEK_API_KEY=sk-... node scripts/jev-decide.mjs --questions out/questions.json --provider deepseek
 *       node scripts/jev-decide.mjs --questions out/questions.json --provider deepseek --samples 5
 *
 * 参数：
 *   --questions <json>   第二步产物（必需）
 *   --judgment <json>    provider=agent 时的判断表
 *   --provider <名字>    agent（默认）| deepseek
 *   --samples <n>        采样次数（>1 时做一致性测量，仅 deepseek 有意义）默认 1
 *   --temperature <n>    softmax 温度（>1 更平更保守），默认 1
 *   --round-score        score 取概率最大的档位而不是概率加权期望
 *   --emit-prompt        只写提示与模板，不做决策
 *   --emit-judgment      把换算结果连同原始判断一起写出来（默认就带）
 *   --out <目录>         输出目录（默认 out）
 *   --name <前缀>        产物文件名前缀
 *   --quiet              只输出产物路径
 *
 * 退出码：0 正常；1 产物未通过校验；2 参数/文件/网络错误。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { banner, commonArgs, fail, nextStep, readJson, reportValidation, writeJson, writeText } from '../lib/cli.mjs';
import { runDecide } from '../lib/pipeline.mjs';
import { buildJudgePrompt, judgmentSkeleton } from '../lib/judge.mjs';
import { renderDecision } from '../lib/render.mjs';
import { requireDomain } from '../lib/domains/index.mjs';
import { validateDecision } from '../lib/schema.mjs';
import { flagBool, flagNum, stableId } from '../lib/util.mjs';
import { listProviders } from '../lib/providers/index.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { flags, quiet } = commonArgs(argv);

  if (!flags.questions) {
    fail('缺少 --questions', '先跑第二步：node scripts/jev-ask.mjs --domain <领域> --input "…" --pick 1');
  }
  const questionSet = await readJson(String(flags.questions), '第二步产物');

  const providerName = String(flags.provider || 'agent');
  const temperature = flags.temperature !== undefined ? flagNum(flags.temperature, undefined) : undefined;
  const roundScore = flagBool(flags['round-score'], false);

  // ---- provider=agent 的第一拍：只出提示与模板 ----
  if (flagBool(flags['emit-prompt'], false)) {
    const domain = requireDomain(questionSet.domain?.id || 'other');
    const prompt = buildJudgePrompt({
      state: questionSet.state,
      questions: questionSet.questions,
      domain,
      judgeHints: domain.judgeHints || [],
    });
    const template = judgmentSkeleton(questionSet.questions);
    const name = String(flags.name || `${domain.name}-judgment-${stableId('x', questionSet.state).slice(2, 8)}`);
    const dir = String(flags.out || 'out');
    const promptFile = await writeText(path.join(dir, `${name}.prompt.md`), prompt);
    const tplFile = await writeJson(path.join(dir, `${name}.template.json`), template);
    if (quiet) {
      console.log(tplFile);
    } else {
      banner('判断提示已生成', 'provider=agent：由当前 Agent 填写判断表');
      console.log(`  提示：${promptFile}`);
      console.log(`  模板：${tplFile}`);
      nextStep([
        '读上面的提示，按模板把每个选项的支持度与依据填进 judgment.json（可以只在模板上改数字与 basis）。',
        `node scripts/jev-decide.mjs --questions ${path.resolve(String(flags.questions))} --judgment ${tplFile}`,
      ]);
    }
    return { prompt: promptFile, template: tplFile };
  }

  // ---- 执行决策 ----
  let judgment = null;
  if (flags.judgment) {
    judgment = await readJson(String(flags.judgment), 'judgment 文件');
  } else if (providerName === 'agent' || providerName === 'current' || providerName === 'self') {
    fail(
      'provider=agent 需要 --judgment',
      '两拍流程：先 --emit-prompt 拿到提示与模板，填好后再带 --judgment 重跑；或改用 --provider deepseek。',
    );
  }

  const samples = flagNum(flags.samples, 1);
  let result;
  try {
    result = await runDecide({
      questionSet,
      providerName,
      judgment,
      model: flags.model ? String(flags.model) : null,
      samples,
      temperature,
      roundScore,
    });
  } catch (error) {
    fail(`决策失败：${error.message}`, error.stack?.split('\n').slice(1, 3).join('\n') || '');
  }

  const { envelope, validation } = result;
  reportValidation(validation, { quiet });

  const domainName = envelope.domain.name;
  const name = String(flags.name || `${domainName}-decision-${stableId('x', questionSet.state).slice(2, 8)}`);
  const written = await writeJson(path.join(String(flags.out || 'out'), `${name}.json`), envelope);

  if (!quiet) {
    banner('第三步 · 决策结果', `${envelope.domain.name}｜provider=${envelope.provenance.provider}`);
    console.log(renderDecision(envelope, { showJudgment: flagBool(flags['show-judgment'], true) }));
    console.log('固定 JSON（答案部分，与真实 Jev 逐字段一致）：');
    console.log(JSON.stringify(envelope.response, null, 2));
    nextStep([
      `产物：${written}`,
      '需要用真实 TypeSafe Jev 复核时，把产物里的 request 原样 POST 到 https://api.typesafe.ai/v1/systemone 即可（契约一致）。',
      `校验产物：node scripts/jev-verify.mjs ${written}`,
    ]);
  } else {
    console.log(written);
  }

  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`\n✗ ${error.message}`);
    console.error(`  可用 provider：${listProviders().map((p) => p.id).join(' / ')}`);
    process.exit(2);
  }
}
