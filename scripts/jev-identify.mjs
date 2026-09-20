#!/usr/bin/env node
/**
 * jev-identify — 第一步：领域识别。
 *
 * 用法：
 *   node scripts/jev-identify.mjs --text "解方程 x²-5x+6=0"
 *   node scripts/jev-identify.mjs --text "..." --domain 数学        # 用户直接指定领域（跳过规则识别）
 *   node scripts/jev-identify.mjs --in question.md --out out --quiet
 *
 * 产物：`<out>/<领域>-domain-<hash>.json` 或者 `<out>/domain.json`（--name 指定时）
 * 退出码：0 正常；1 识别结果不唯一需要用户确认（--require-auto 时）；2 参数/文件错误。
 *
 * 注意：这一步**不猜**。置信度低于阈值时 `decision` 会是 `ask`，并把候选领域一并给出，
 * 由调用方（Agent 或人）去问用户，而不是替用户决定。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { banner, commonArgs, fail, nextStep, readJson, writeJson } from '../lib/cli.mjs';
import { runIdentify } from '../lib/pipeline.mjs';
import { renderDomain } from '../lib/render.mjs';
import { stableId } from '../lib/util.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional, quiet } = commonArgs(argv);

  let text = '';
  if (flags.text || flags.input) text = String(flags.text || flags.input);
  else if (flags.in) {
    const p = path.resolve(String(flags.in));
    try {
      text = await readFile(p, 'utf8');
    } catch (error) {
      fail(`无法读取输入文件：${p}`, error.message);
    }
  } else if (positional.length) {
    text = positional.join(' ');
  }
  if (!text.trim() && !flags.domain) {
    fail('缺少输入', '用 --text "…" 或 --in <file> 给出要被识别的文本；若已知领域，用 --domain 指定。');
  }

  if (flags.prev) {
    const prev = await readJson(String(flags.prev), '上一步产物');
    if (!text) text = prev.input || prev.state || '';
  }

  const doc = runIdentify({ text, hint: flags.domain ? String(flags.domain) : '' });

  const name = String(flags.name || `${doc.domain.name}-domain-${stableId('x', doc.input || 'empty').slice(2, 8)}`);
  const outFile = path.join(String(flags.out || 'out'), `${name}.json`);
  const written = await writeJson(outFile, doc);

  if (!quiet) {
    banner('第一步 · 领域识别', doc.source === 'user' ? '领域由用户指定' : '基于证据打分，不猜');
    console.log(renderDomain(doc));
  }

  if (flags['require-auto'] === true && doc.decision !== 'auto') {
    console.error(`\n✗ --require-auto：识别置信度 ${doc.confidence} 未达阈值，需要用户确认领域。`);
    process.exit(1);
  }

  if (quiet) {
    console.log(written);
  } else {
    nextStep([
      `产物：${written}`,
      doc.decision === 'auto'
        ? `"${doc.domain.name}" 识别置信度 ${(doc.confidence * 100).toFixed(1)}%，可直接进入第二步：`
        : `⚠ 领域不确定（置信度 ${(doc.confidence * 100).toFixed(1)}%），请先向用户确认领域，再用 --domain 指定后重跑。`,
      `node scripts/jev-ask.mjs --domain ${doc.domain.id} --input "<原始问题>"`,
    ]);
  }
  return doc;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
