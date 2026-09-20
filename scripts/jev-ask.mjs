#!/usr/bin/env node
/**
 * jev-ask — 第二步：生成预定义问题，并把用户选中的那一条编译成一份合法的 Jev 请求。
 *
 * 用法：
 *   # 只出候选（不动手写产物），把菜单打出来给人看
 *   node scripts/jev-ask.mjs --domain 数学 --input "解方程 x²-5x+6=0"
 *
 *   # 用户选了第 2 条 → 直接产出 questions.json
 *   node scripts/jev-ask.mjs --domain 数学 --input "…" --pick 2 --out out
 *
 *   # 用户自己写问题
 *   node scripts/jev-ask.mjs --domain 英语 --input "…" --custom "这句话的语法是否正确？"
 *
 *   # 只要某种题型
 *   node scripts/jev-ask.mjs --domain 科学 --input "…" --types noul,score
 *
 * 参数：
 *   --domain <领域>      必填（第一步的产出；也可用领域名/别名）
 *   --input <文本>       要被判断的内容（会作为 Jev 的 state）
 *   --in <文件>          从文件读 input
 *   --question <文本>    用户自带的完整问题（与 --custom 等价，保留 --custom 是为了语义清楚）
 *   --pick <序号>        选定第 N 条候选（1 起）；多选用逗号：--pick 1,3
 *   --types <列表>       只保留这些题型：choice,score,noul
 *   --max-options <n>    choice 选项上限，默认 4
 *   --model <名字>       写进请求体的 model 字段，默认 jev-latest
 *   --out <目录>         输出目录（默认 out）
 *   --quiet              只输出产物路径
 *
 * 退出码：0 正常；1 产出的问题集未通过校验；2 参数错误。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { banner, commonArgs, fail, nextStep, parseTypes, readJson, reportValidation, writeJson } from '../lib/cli.mjs';
import { runAsk } from '../lib/pipeline.mjs';
import { renderCandidates } from '../lib/render.mjs';
import { validateQuestionSet } from '../lib/schema.mjs';
import { requireDomain } from '../lib/domains/index.mjs';
import { flagNum, stableId } from '../lib/util.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional, quiet, repeated } = commonArgs(argv);

  if (!flags.domain && !flags.prev) {
    fail('缺少 --domain', '先跑第一步，或直接指定领域（时政/数学/科学/常识/英语）。可用 `jev domains` 查看全部。');
  }

  let domainKey = flags.domain ? String(flags.domain) : '';
  let input = flags.input ? String(flags.input) : flags.text ? String(flags.text) : positional.join(' ');
  let stateOverride = '';

  if (flags.prev) {
    const prev = await readJson(String(flags.prev), '第一步产物');
    if (!domainKey) domainKey = prev.domain?.id || '';
    if (!input) {
      input = prev.input || (prev.state ? String(prev.state) : '');
      if (prev.state) stateOverride = String(prev.state);
    }
  }

  if (flags.in) {
    try {
      input = await readFile(path.resolve(String(flags.in)), 'utf8');
    } catch (error) {
      fail(`无法读取 --in 文件：${flags.in}`, error.message);
    }
  }

  if (!input.trim()) fail('缺少 --input', '--input 是「要被判断的内容」，会作为 Jev 的 state 原样发出。');

  const domain = requireDomain(domainKey);
  domainKey = domain.id;
  const types = parseTypes(flags);
  const maxOptions = flagNum(flags['max-options'], 4);
  // --custom 可重复：一句输入里有两件事时，拆成两条各自独立的问题（一个调用一个问题），
  // 再放进同一个请求并行判断。单条时行为不变。
  const customRaw = [...(repeated?.custom || []), ...(repeated?.question || [])]
    .map((x) => (typeof x === 'string' ? x : ''))
    .filter((x) => x.trim());
  const custom = customRaw.length === 0 ? '' : customRaw.length === 1 ? customRaw[0] : customRaw;
  // --pick 1 / --pick 1,2 / --pick 1,2,3 —— 多选即「一次请求问多个问题」，Jev 的推荐用法
  const pick = flags.pick !== undefined
    ? String(flags.pick).split(/[,，\s]+/).map((x) => Number(x.trim())).filter((x) => Number.isFinite(x))
    : null;

  const result = runAsk({
    domainKey,
    input: stateOverride || input,
    types,
    maxOptions,
    pick: pick && pick.length ? (pick.length === 1 ? pick[0] : pick) : null,
    custom,
    model: flags.model ? String(flags.model) : undefined,
  });

  if (!quiet) {
    banner('第二步 · 预定义问题', `${domain.name}｜${result.candidates.length} 条候选`);
    console.log(renderCandidates(result));
  }

  let written = null;
  if (result.question_set) {
    const set = result.question_set;
    const check = validateQuestionSet(set, { maxOptions });
    reportValidation(check, { strict: flags.strict === true, quiet });

    const name = String(flags.name || `${domain.name}-questions-${stableId('x', set.state).slice(2, 8)}`);
    written = await writeJson(path.join(String(flags.out || 'out'), `${name}.json`), set);

    if (quiet) console.log(written);
    else {
      banner('已选定的问题（已编译成 Jev 请求）');
      console.log(JSON.stringify(set.request, null, 2));
      nextStep([
        `产物：${written}`,
        '第三步：用 provider=agent（当前 Agent 填判断）或 provider=deepseek（直接调 API）执行决策。',
        `node scripts/jev-decide.mjs --questions ${written} --provider agent --emit-prompt`,
      ]);
    }
  } else if (result.error) {
    fail(result.error, '把候选清单交给用户，让他选一条或用 --custom 给出自己的问题。');
  } else if (!quiet) {
    nextStep([
      `让用户从上面 ${result.candidates.length} 条候选里选一条：--pick <序号>；`,
      '或者让用户直接给出自己的问题：--custom "……"。',
    ]);
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
