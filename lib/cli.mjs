/**
 * @module cli
 * 各管线脚本共用的命令行辅助：读写 JSON、终端输出、统一退出码。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { flagBool, parseArgs } from './util.mjs';

/** 解析 argv，并把常用 flag 归一化。 */
export function commonArgs(argv) {
  const { flags, positional } = parseArgs(argv);
  return {
    flags,
    positional,
    quiet: flagBool(flags.quiet, false),
    outDir: path.resolve(String(flags.out || 'out')),
  };
}

/** 读 JSON 文件（失败给出明确提示与退出码 2）。 */
export async function readJson(file, label = '文件') {
  try {
    return JSON.parse(await readFile(path.resolve(String(file)), 'utf8'));
  } catch (error) {
    console.error(`✗ 无法读取${label}：${file}\n  ${error.message}`);
    process.exit(2);
  }
}

/** 写 JSON 文件（自动建目录；2 空格缩进便于 diff）。 */
export async function writeJson(file, obj) {
  const target = path.resolve(String(file));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  return target;
}

/** 写文本文件。 */
export async function writeText(file, text) {
  const target = path.resolve(String(file));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  return target;
}

/** 终端小节标题 */
export function banner(text, sub = '') {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${text}`);
  if (sub) console.log(`  ${sub}`);
  console.log('─'.repeat(64));
}

/** 统一的「下一步」提示 */
export function nextStep(lines) {
  console.log('\n下一步：');
  for (const l of lines) console.log(`  ${l}`);
}

/** 失败退出：打印错误与可选提示，退出码 2（与「校验不通过」区分开，后者是 1）。 */
export function fail(message, hint = '') {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(2);
}

/** 解析 --types choice,score / --type noul */
export function parseTypes(flags) {
  const raw = flags.types ?? flags.type;
  if (!raw || raw === true) return null;
  const list = String(raw)
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const map = { 单选题: 'choice', 选择: 'choice', 选择題: 'choice', 打分: 'score', 打分题: 'score', 判断题: 'noul', 判断: 'noul' };
  const resolved = list.map((t) => map[t] || t);
  const bad = resolved.filter((t) => !['choice', 'score', 'noul'].includes(t));
  if (bad.length) fail(`未知题型：${bad.join(', ')}`, '可用：choice / score / noul');
  return resolved;
}

/** 打印校验结果（错误 → 退出码 1；仅警告 → 照常继续）。 */
export function reportValidation(result, { strict = false, quiet = false } = {}) {
  if (!quiet) {
    for (const w of result.warnings || []) console.log(`  ⚠ ${w}`);
  }
  if (!result.ok) {
    console.error('\n✗ 校验未通过：');
    for (const e of result.errors || []) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (strict && (result.warnings || []).length > 0) {
    console.error('\n✗ --strict：存在警告即视为失败。');
    process.exit(1);
  }
  return true;
}
