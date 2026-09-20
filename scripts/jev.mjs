#!/usr/bin/env node
/**
 * jev — 总入口：把三步流水线与其他辅助命令收在一处。
 *
 *   node scripts/jev.mjs domains                      列出领域与判断来源
 *   node scripts/jev.mjs identify --text "…"          第一步：领域识别
 *   node scripts/jev.mjs ask --domain 数学 --input "…" 第二步：出预定义问题 / 选定问题
 *   node scripts/jev.mjs decide --questions q.json …  第三步：执行决策，输出固定 JSON
 *   node scripts/jev.mjs run --domain 数学 --input "…" --judgment j.json   一步到底
 *   node scripts/jev.mjs verify out/x.json            校验产物是否符合固定契约
 *   node scripts/jev.mjs calibrate --records r.json   校准统计
 *
 * 每个子命令的参数与独立脚本完全一致（在本文件名后直接跟子命令名即可）。
 * 独立脚本也可以直接调用：`node scripts/jev-identify.mjs --text "…"`。
 */

import { pathToFileURL } from 'node:url';
import { flagNum } from '../lib/util.mjs';
import { fail } from '../lib/cli.mjs';
import { runAll } from '../lib/pipeline.mjs';
import { renderDecision } from '../lib/render.mjs';
import { validateDecision } from '../lib/schema.mjs';
import { stableId } from '../lib/util.mjs';
import { writeJson } from '../lib/cli.mjs';
import { requireDomain } from '../lib/domains/index.mjs';
import path from 'node:path';
import { readJson } from '../lib/cli.mjs';

const USAGE = `jev — 类 Jev 决策技能（领域识别 → 预定义问题 → choice/score/noul 决策，输出固定 JSON）

用法：node scripts/jev.mjs <子命令> [参数]

子命令：
  domains                    列出内置领域、等级集与判断来源（--json）
  identify --text "…"        第一步：领域识别（--domain 可直接指定领域）
  ask --domain <领域> --input "…"
                             第二步：生成预定义问题；--pick N 选定，--custom "…" 自定义
  decide --questions <json>  第三步：执行决策
        --judgment <json>       provider=agent 时的判断表（先跑 --emit-prompt 拿模板）
        --provider deepseek     改由本技能直接调 DeepSeek API
        --samples N             多采样做一致性测量
        --temperature N         softmax 温度（>1 更保守），默认 1
        --round-score           score 取概率最大的档位而非概率加权期望
        --emit-prompt           只写判断提示与模板
  run --domain <领域> --input "…" --judgment <json>
                             一步跑完三步（省略中间的落盘与人工核对，适合批量）
  verify <file.json> [...]   校验产物是否符合固定契约（--strict / --print-request）
  calibrate --records <json> 校准统计（ECE / Brier / 可靠性表）

示例：
  node scripts/jev.mjs identify --text "解方程 x²-5x+6=0"
  node scripts/jev.mjs ask --domain 数学 --input "解方程 x²-5x+6=0" --pick 1 --out out
  node scripts/jev.mjs decide --questions out/数学-questions-xxxx.json --emit-prompt
  node scripts/jev.mjs decide --questions out/数学-questions-xxxx.json --judgment out/xx.template.json
`;

const SUBCOMMANDS = new Set(['domains', 'identify', 'ask', 'decide', 'verify', 'calibrate', 'run', 'help']);

export async function main(argv = process.argv.slice(2)) {
  const [sub, ...rest] = argv;

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return null;
  }

  if (!SUBCOMMANDS.has(sub)) {
    fail(`未知子命令：${sub}`, `可用：${[...SUBCOMMANDS].join(' / ')}（不带子命令时打印用法）`);
  }

  switch (sub) {
    case 'domains': {
      const { main: m } = await import('./jev-domains.mjs');
      return m(rest);
    }
    case 'identify': {
      const { main: m } = await import('./jev-identify.mjs');
      return m(rest);
    }
    case 'ask': {
      const { main: m } = await import('./jev-ask.mjs');
      return m(rest);
    }
    case 'decide': {
      const { main: m } = await import('./jev-decide.mjs');
      return m(rest);
    }
    case 'verify': {
      const { main: m } = await import('./jev-verify.mjs');
      return m(rest);
    }
    case 'calibrate': {
      const { main: m } = await import('./jev-calibrate.mjs');
      return m(rest);
    }
    case 'run': {
      return run(rest);
    }
    default:
      fail(`未实现的子命令：${sub}`);
  }
}

/** 一步到底：省掉中间产物，适合“问题已经很清楚、只想拿答案”的场景。 */
async function run(argv) {
  const { parseArgs } = await import('../lib/util.mjs');
  const { flags, positional } = parseArgs(argv);
  if (!flags.domain) fail('run 需要 --domain', '先用 identify 识别领域，或直接指定。');
  const input = flags.text ? String(flags.text) : flags.input ? String(flags.input) : positional.join(' ');
  if (!input.trim()) fail('run 需要 --input', '给出要被判断的内容。');

  const judgment = flags.judgment ? await readJson(String(flags.judgment), 'judgment 文件') : null;
  const providerName = String(flags.provider || 'agent');
  if (providerName === 'agent' && !judgment) {
    fail('provider=agent 需要 --judgment', '先用 `ask` + `decide --emit-prompt` 拿到要填的模板。');
  }

  const { envelope } = await runAll({
    domainKey: String(flags.domain),
    input,
    userQuestion: flags.question ? String(flags.question) : flags.custom ? String(flags.custom) : '',
    types: flags.types ? String(flags.types).split(',').map((s) => s.trim()) : null,
    maxOptions: flagNum(flags['max-options'], 4),
    providerName,
    judgment,
    model: flags.model ? String(flags.model) : null,
    samples: flagNum(flags.samples, 1),
    temperature: flags.temperature !== undefined ? flagNum(flags.temperature, 1) : undefined,
    roundScore: flags['round-score'] === true,
  });

  const check = validateDecision(envelope);
  if (!check.ok) fail(`产物未通过校验：\n  - ${check.errors.join('\n  - ')}`);

  const domain = requireDomain(envelope.domain.id);
  const name = String(flags.name || `${domain.name}-decision-${stableId('x', input).slice(2, 8)}`);
  const written = await writeJson(path.join(String(flags.out || 'out'), `${name}.json`), envelope);

  if (flags.quiet !== true) {
    console.log(renderDecision(envelope, { showJudgment: true }));
    console.log(`\n产物：${written}`);
  } else {
    console.log(written);
  }
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
