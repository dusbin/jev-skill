#!/usr/bin/env node
/**
 * jev-calibrate — 校准统计：这批决策到底有多可信？
 *
 * 两种输入：
 *
 *  ① 现成的标注记录（自己整理最快的路径）
 *     node scripts/jev-calibrate.mjs --records records.json
 *     records.json 形如：
 *       [{"question":"q-1a2b","predicted":"B","expected":"B","correct":1,
 *         "confidence":0.71,"winning_probability":0.62}, ...]
 *
 *  ② 由决策产物 + 标准答案推导
 *     node scripts/jev-calibrate.mjs --decisions out/*.json --labels labels.json
 *     labels.json 形如：{"q-1a2b": "B", "q-3c4d": 2, "q-5e6f": 1}   # noul 用 0/1
 *
 * 用法要点：
 *   `expected` 必须由人给出。这份数字的价值完全取决于标注质量——
 *   拿模型自己的结论当标准答案，测出来的只是它和自己的相似度。
 *
 * 退出码：0 正常；2 参数/文件错误。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commonArgs, fail, readJson, writeJson } from '../lib/cli.mjs';
import { summarize } from '../lib/calibration.mjs';
import { argmax } from '../lib/decision.mjs';
import { flagNum, round } from '../lib/util.mjs';

/** 从一条决策信封 + 标准答案，推导出校准记录。 */
export function recordsFromDecision(doc, labels = {}) {
  const out = [];
  for (const spec of doc.questions || []) {
    const ans = doc.response?.answers?.[spec.id];
    if (!ans) continue;
    const expected = labels[spec.id];
    if (expected === undefined) continue; // 没标注就不猜，直接跳过

    if (spec.type === 'noul') {
      const y = Number(expected) ? 1 : 0;
      const predicted = ans.noul >= 0.5 ? 1 : 0;
      out.push({
        question: spec.id,
        type: 'noul',
        predicted,
        expected: y,
        correct: predicted === y ? 1 : 0,
        winning_probability: round(y ? ans.noul : 1 - ans.noul, 6),
      });
      continue;
    }

    const keys = Object.keys(ans.probabilities || {});
    const idxOf = (k) => keys.indexOf(String(k));
    const expectedIdx = spec.type === 'score' ? Number(expected) : idxOf(expected);
    if (expectedIdx < 0 || expectedIdx >= keys.length) continue;
    const predicted = spec.type === 'choice' ? ans.choice : String(argmax(keys.map((k) => ans.probabilities[k])));
    out.push({
      question: spec.id,
      type: spec.type,
      predicted,
      expected: spec.type === 'score' ? expectedIdx : expected,
      correct: predicted === (spec.type === 'score' ? String(expectedIdx) : String(expected)) ? 1 : 0,
      confidence: ans.confidence,
      winning_probability: round(ans.probabilities[keys[expectedIdx]], 6),
      probabilities: keys.map((k) => ans.probabilities[k]),
      correct_index: expectedIdx,
    });
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional, quiet } = commonArgs(argv);
  const bins = flagNum(flags.bins, 10);
  const minSamples = flagNum(flags['min-samples'], 30);

  let records = null;

  if (flags.records) {
    const raw = await readJson(String(flags.records), 'records 文件');
    records = Array.isArray(raw) ? raw : Array.isArray(raw.records) ? raw.records : null;
    if (!records) fail('records 文件必须是数组，或含 records 数组的对象');
  } else if (flags.decisions) {
    const files = String(flags.decisions).split(',').map((s) => s.trim()).filter(Boolean);
    const labels = flags.labels ? await readJson(String(flags.labels), 'labels 文件') : {};
    records = [];
    for (const f of files) {
      const doc = await readJson(f, '决策产物');
      records.push(...recordsFromDecision(doc, labels));
    }
    if (records.length === 0) {
      fail(
        '没有推导出任何记录',
        'labels.json 的键必须是产物里 questions[].id（也就是 Jev 请求里的 question key）。用 `--print` 看一眼。',
      );
    }
  } else if (positional.length) {
    const raw = await readJson(positional[0], 'records 文件');
    records = Array.isArray(raw) ? raw : raw.records;
  } else {
    fail('缺少输入', '用 --records <file> 或 --decisions <file,...> --labels <file>；详见文件头注释。');
  }

  const clean = records.map((r) => ({ ...r, correct: Number(r.correct) ? 1 : 0 }));
  const summary = summarize(clean, { bins, minSamples });

  const report = {
    schema: 'jev/calibration@1',
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    bins,
    ...summary,
  };

  if (!quiet) {
    console.log(`\n样本：${report.n} 条　整体正确率：${(report.accuracy * 100).toFixed(1)}%` +
      `（95% 区间 ${(report.accuracy_ci.low * 100).toFixed(1)}%–${(report.accuracy_ci.high * 100).toFixed(1)}%）`);
    for (const key of ['confidence', 'winning_probability']) {
      const m = report[key];
      if (!m) continue;
      console.log(`\n【${key}】${m.definition}`);
      console.log(`  ECE ${m.ece}　Brier ${m.brier}　平均 ${m.mean_confidence}（n=${m.n}）`);
      console.log('  可靠性表（置信度区间 → 样本数 / 平均置信度 / 实际正确率 / 偏差）：');
      for (const row of m.reliability) {
        const [lo, hi] = row.range;
        console.log(
          `    [${lo.toFixed(1)},${hi.toFixed(1)})  n=${String(row.n).padStart(3)}  ` +
            `${row.mean_confidence.toFixed(3)} / ${row.accuracy.toFixed(3)}  ${row.gap >= 0 ? '+' : ''}${row.gap.toFixed(3)}`,
        );
      }
    }
    if (report.warnings.length) {
      console.log('');
      for (const w of report.warnings) console.log(`  ⚠ ${w}`);
    }
  }

  if (flags.out) {
    const file = path.join(String(flags.out), String(flags.name || 'calibration.json'));
    const written = await writeJson(file, report);
    console.log(written);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
