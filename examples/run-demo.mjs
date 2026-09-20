#!/usr/bin/env node
/**
 * 端到端演示：三个领域 × 三种题型，走完三步流水线并落盘。
 *
 *   node examples/run-demo.mjs            # 跑到 examples/demo/
 *   node examples/run-demo.mjs --out /tmp/x
 *
 * 演示用 provider=agent（离线、无需 API key）：判断表写在下面的 CASES 里，
 * 模拟「Agent 读完提示后给出支持度与依据」这一步。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAsk, runDecide, runIdentify } from '../lib/pipeline.mjs';
import { renderDecision, renderDomain } from '../lib/render.mjs';
import { validateDecision } from '../lib/schema.mjs';
import { writeJson } from '../lib/cli.mjs';
import { stableId } from '../lib/util.mjs';

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : new URL('./demo/', import.meta.url).pathname.replace(/\/$/, '');

/** 三个用例：分别演示 choice / score / noul。判断表模拟 Agent 的产出。 */
const CASES = [
  {
    name: '数学-单选题',
    domain: '数学',
    input: [
      '解方程 x²-5x+6=0，下列哪个是它的解？',
      'A. x=1',
      'B. x=2',
      'C. x=4',
      'D. x=6',
    ].join('\n'),
    pick: 1,
    judgment: (qid) => ({
      [qid]: {
        type: 'choice',
        scores: { A: 0, B: 4, C: 0, D: 0 },
        basis: [
          '支持 B（x=2）：把 x=2 代入原式得 4-10+6=0，等式成立 → 2 是 x²-5x+6=0 的根。',
          '不支持 A（x=1）：代入得 1-5+6=2≠0 → 不是根。',
          '不支持 C（x=4）：代入得 16-20+6=2≠0 → 不是根。',
          '不支持 D（x=6）：代入得 36-30+6=12≠0 → 不是根。',
        ],
      },
    }),
  },
  {
    name: '科学-打分题',
    domain: '科学',
    input: '人类的大脑只被使用了 10%，剩下 90% 处于休眠状态。',
    types: ['score'],
    pick: 1,
    judgment: (qid) => ({
      [qid]: {
        type: 'score',
        scores: { 0: 3, 1: 2.5, 2: 0, 3: 0 },
        basis: [
          '落在第 0 档：功能性核磁共振与脑损伤研究都显示全脑区域均有活动，不存在「90% 休眠」的区域 → 该说法属于已被证伪的常见迷思。',
          '第 1 档（含迷思但方向大致对）不适用：这里不是「不够严谨」，而是核心结论与科学共识相反。',
        ],
      },
    }),
  },
  {
    name: '常识-判断题',
    domain: '常识',
    input: '油锅着火的时候可以直接用水浇灭。',
    types: ['noul'],
    pick: 1,
    judgment: (qid) => ({
      [qid]: {
        type: 'noul',
        p: 0.02,
        basis: [
          '不支持：水遇到高温食用油会瞬间汽化，把燃烧的油溅开并形成爆燃，火势反而扩大。',
          '正确做法是关火后盖上锅盖切断氧气（或倒入大量青菜降温），符合消防通行指引。',
        ],
      },
    }),
  },
];

async function main() {
  console.log('jev-skill 端到端演示（provider=agent，离线）');
  console.log(`输出目录：${OUT}\n`);

  const summary = [];

  for (const c of CASES) {
    console.log('═'.repeat(72));
    console.log(`用例：${c.name}`);

    // ① 领域识别
    const domainDoc = runIdentify({ text: c.input });
    const domainFile = await writeJson(path.join(OUT, `${c.name}-1-domain.json`), domainDoc);
    console.log(`\n【第一步】领域识别 → ${domainDoc.domain.name}（置信度 ${(domainDoc.confidence * 100).toFixed(1)}%，${domainDoc.decision}）`);

    // ② 出题并选定
    const ask = runAsk({
      domainKey: c.domain,
      input: c.input,
      types: c.types || null,
      pick: c.pick,
    });
    if (!ask.question_set) throw new Error(`用例 ${c.name} 第二步失败：${ask.error || ask.notes.join('；')}`);
    const qFile = await writeJson(path.join(OUT, `${c.name}-2-questions.json`), ask.question_set);
    const spec = ask.question_set.questions[0];
    console.log(`【第二步】选定问题 → [${spec.type}] ${spec.instructions}`);
    console.log(`         选项/等级：${spec.type === 'choice' ? Object.keys(spec.criteria).join('/') : spec.type === 'score' ? spec.criteria.length + ' 档' : '二分类'}`);

    // ③ 执行决策
    const qid = spec.id;
    const { envelope, validation } = await runDecide({
      questionSet: ask.question_set,
      providerName: 'agent',
      judgment: { schema: 'jev/judgment@1', answers: c.judgment(qid) },
    });
    if (!validation.ok) throw new Error(`用例 ${c.name} 产物校验失败：${validation.errors.join('; ')}`);
    const dFile = await writeJson(path.join(OUT, `${c.name}-3-decision.json`), envelope);

    console.log('\n【第三步】决策结果');
    console.log(renderDecision(envelope, { showJudgment: false }));
    console.log(`产物：${path.basename(domainFile)} / ${path.basename(qFile)} / ${path.basename(dFile)}`);

    const ans = envelope.response.answers[qid];
    summary.push({
      用例: c.name,
      领域: envelope.domain.name,
      题型: spec.type,
      答案: spec.type === 'noul' ? ans.noul : spec.type === 'choice' ? ans.choice : ans.score,
      置信度: ans.confidence ?? '(noul 无此字段)',
    });
  }

  console.log('\n' + '═'.repeat(72));
  console.log('汇总');
  console.table(summary);
  console.log(`\n全部产物已通过 validateDecision 校验，位于 ${OUT}`);
  console.log('用 `node scripts/jev-verify.mjs <file>` 可以随时复现这套检查。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { main, CASES, OUT, stableId, validateDecision };
