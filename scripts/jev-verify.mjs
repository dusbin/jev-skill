#!/usr/bin/env node
/**
 * jev-verify — 校验产物是否符合固定 JSON 契约（可用于 CI、可用于复核别人给的产物）。
 *
 * 用法：
 *   node scripts/jev-verify.mjs out/数学-decision-1a2b3c4d.json
 *   node scripts/jev-verify.mjs out/*.json --strict        # 有警告即失败
 *   node scripts/jev-verify.mjs out/x.json --print-request # 额外打印可直接发给真实 Jev 的请求体
 *
 * 退出码：0 全部通过；1 有产物未通过（或 --strict 下有警告）；2 读文件失败。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commonArgs, readJson } from '../lib/cli.mjs';
import {
  JUDGMENT_SCHEMA,
  QUESTION_SET_SCHEMA,
  SCHEMA_ID,
  validateDecision,
  validateJudgment,
  validateQuestionSet,
} from '../lib/schema.mjs';

function validateDomainDoc(doc) {
  const errors = [];
  const warnings = [];
  if (doc.schema !== 'jev/domain@1') errors.push('schema 必须是 jev/domain@1');
  if (!doc.domain?.id) errors.push('缺少 domain.id');
  if (typeof doc.confidence !== 'number') errors.push('confidence 必须是数字');
  if (!['auto', 'ask'].includes(doc.decision)) errors.push('decision 必须是 auto 或 ask');
  if (doc.decision === 'ask') warnings.push('该识别结果是「需要用户确认」，不要直接用它出题');
  return { ok: errors.length === 0, errors, warnings };
}

function validateByShape(doc) {
  const schema = doc?.schema;
  if (schema === SCHEMA_ID) return { kind: 'decision', ...validateDecision(doc) };
  if (schema === QUESTION_SET_SCHEMA) return { kind: 'questions', ...validateQuestionSet(doc, { maxOptions: doc.max_options ?? 4 }) };
  if (schema === JUDGMENT_SCHEMA) return { kind: 'judgment', ...validateJudgment(doc, {}) };
  if (schema === 'jev/domain@1') return { kind: 'domain', ...validateDomainDoc(doc) };
  return { kind: 'unknown', ok: false, errors: [`无法识别的 schema：${JSON.stringify(schema)}`], warnings: [] };
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional, quiet } = commonArgs(argv);
  const files = positional.length ? positional : flags.in ? String(flags.in).split(',') : [];
  if (!files.length) {
    console.error('✗ 缺少待校验文件\n  用法：node scripts/jev-verify.mjs <file.json> [more.json] [--strict] [--print-request]');
    process.exit(2);
  }

  let failed = 0;
  let warned = 0;

  for (const file of files) {
    const abs = path.resolve(String(file));
    const doc = await readJson(abs, '产物');
    const r = validateByShape(doc);
    const label = path.basename(abs);

    const status = r.ok ? (r.warnings.length ? '通过（有警告）' : '通过') : '失败';
    if (!quiet) console.log(`\n${r.ok ? '✓' : '✗'} ${label}　[${r.kind}]　${status}`);
    for (const w of r.warnings) if (!quiet) console.log(`  ⚠ ${w}`);
    for (const e of r.errors) console.error(`  - ${e}`);

    if (!r.ok) failed++;
    else if (flags.strict === true && r.warnings.length) {
      failed++;
      console.error('  - --strict：存在警告即视为失败');
    } else if (r.warnings.length) warned++;

    if (flags['print-request'] === true && doc.request) {
      console.log('\n--- 可直接 POST 到 https://api.typesafe.ai/v1/systemone 的请求体 ---');
      console.log(JSON.stringify(doc.request, null, 2));
    }
    if (flags['print-answers'] === true && doc.response) {
      console.log('\n--- Jev 原生 answers ---');
      console.log(JSON.stringify(doc.response, null, 2));
    }
  }

  if (!quiet) {
    console.log(`\n共 ${files.length} 个产物：通过 ${files.length - failed}，失败 ${failed}，其中有警告 ${warned}。`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
