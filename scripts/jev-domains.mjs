#!/usr/bin/env node
/**
 * jev-domains — 列出内置领域与它们的题库/等级集；`--providers` 列出可用的判断来源。
 *
 * 用法：
 *   node scripts/jev-domains.mjs
 *   node scripts/jev-domains.mjs --json
 *   node scripts/jev-domains.mjs 数学 --json     # 只看一个领域的完整定义
 *   node scripts/jev-domains.mjs --providers
 */

import { pathToFileURL } from 'node:url';
import { commonArgs, fail } from '../lib/cli.mjs';
import { listDomains, requireDomain } from '../lib/domains/index.mjs';
import { listProviders } from '../lib/providers/index.mjs';
import { renderDomains, renderProviders } from '../lib/render.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = commonArgs(argv);

  if (flags.providers === true) {
    const list = listProviders();
    if (flags.json === true) console.log(JSON.stringify(list, null, 2));
    else console.log(`可用的判断来源：\n${renderProviders(list)}`);
    return list;
  }

  if (positional.length) {
    let d;
    try {
      d = requireDomain(positional[0]);
    } catch (error) {
      fail(error.message);
    }
    if (flags.json === true) {
      console.log(JSON.stringify(d, null, 2));
    } else {
      console.log(renderDomains([listDomains().find((x) => x.id === d.id) || { ...d, scoreSets: Object.keys(d.scoreSets || {}), templateCount: (d.templates || []).length }]));
      console.log('\n判题要点：');
      for (const h of d.judgeHints || []) console.log(`  · ${h}`);
    }
    return d;
  }

  const list = listDomains();
  if (flags.json === true) console.log(JSON.stringify(list, null, 2));
  else {
    console.log('内置领域（新增领域：在 lib/domains/ 里加一个同名结构的 .mjs，再在 index.mjs 的 BUILTIN 里加一行）：\n');
    console.log(renderDomains(list));
    console.log('\n判断来源（--provider）：');
    console.log(renderProviders(listProviders()));
  }
  return list;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
