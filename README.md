# jev-skill

一个**类 Jev** 的决策技能：把「一个模糊的提问」变成一条**可追溯、可复现、带概率**的判决。

```
用户输入
   ├─ ① jev identify  → 领域识别（时政/数学/科学/常识/英语），拿不准就问，不猜
   ├─ ② jev ask       → 生成合理的预定义问题（choice/score/noul），用户选一条或自定义
   └─ ③ jev decide    → 执行决策，输出**固定 JSON**（Jev 原生 answers）
```

零 npm 依赖，只要 Node ≥ 18。

## 它和「直接问模型」有什么不同

| | 直接问模型 | 本技能 |
|---|---|---|
| 输出 | 一段文字 | 固定 JSON：选中项 / 每项概率 / 置信度 / 命题成立概率 |
| 概率从哪来 | 模型嘴里说的（常常是假均匀或假自信） | 模型只给**支持度**，引擎 softmax 换算 |
| 置信度 | 没有，或者随口给 | 公式公开：`0.75·(p₁−p₂)/(1−p₂) + 0.25·(1 − H/ln n)` |
| 判断依据 | 混在文字里 | 逐条 `basis`，必须摘录原文 |
| 可复现 | 否 | 同输入同判断 → 逐字段相同（除时间戳） |
| 领域出错 | 看不出来 | 置信度不足时判 `ask`，强制回问用户 |
| 坏题 | 照问不误 | 选项 >4、等级 <2、一题问两件事、要求解释 → 拦下 |

## 快速开始

```bash
JEV=$(pwd)

# 第一步：识别领域
node "$JEV/scripts/jev.mjs" identify --text "解方程 x²-5x+6=0，下列哪个是它的解？
A. x=1
B. x=2
C. x=4
D. x=6"

# 第二步：出候选 → 选第 1 条
node "$JEV/scripts/jev.mjs" ask --domain 数学 --input "解方程 x²-5x+6=0，下列哪个是它的解？
A. x=1
B. x=2
C. x=4
D. x=6" --pick 1 --out out

# 第三步：先拿判断模板，填好后再出结果
node "$JEV/scripts/jev.mjs" decide --questions out/数学-questions-*.json --emit-prompt --out out
#   → 读 out/*.prompt.md，把 out/*.template.json 填成 judgment.json
node "$JEV/scripts/jev.mjs" decide --questions out/数学-questions-*.json --judgment judgment.json --out out

# 校验产物是否符合固定契约
node "$JEV/scripts/jev.mjs" verify out/数学-decision-*.json
```

也可以让技能自己去问模型（需要 `DEEPSEEK_API_KEY`）：

```bash
DEEPSEEK_API_KEY=sk-... node "$JEV/scripts/jev.mjs" decide \
  --questions out/数学-questions-*.json --provider deepseek --samples 5 --out out
```

让技能自己判断太慢？Agent 可以**独立填多份判断表**做一致性测量（`judgment.samples: [...]`），
引擎会算出与 `--provider deepseek --samples N` 同样的 `consistency`。

跑一遍完整演示（含三种题型的产物）：

```bash
node examples/run-demo.mjs
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `jev domains` | 列出 5 个内置领域、等级集与 2 个判断来源 |
| `jev identify --text "…"` | 第一步：领域识别（`--domain` 可直接指定） |
| `jev ask --domain 数学 --input "…"` | 第二步：出候选；`--pick N` 选定，`--custom "…"` 自定义 |
| `jev decide --questions q.json …` | 第三步：执行决策，输出固定 JSON（`--judgment` / `--provider` / `--samples` / `--emit-prompt`） |
| `jev run --domain 数学 --input "…" --judgment j.json` | 一步到底（跳过中间落盘） |
| `jev verify x.json` | 校验产物是否符合固定契约（`--strict`） |
| `jev calibrate --records r.json` | 校准统计：ECE / Brier / 可靠性表 |

每个子命令都有独立脚本（`scripts/jev-identify.mjs` 等），参数完全一致。

## 文档

- [`SKILL.md`](SKILL.md) — 给 Agent 的完整作业指导（三步流程、判断纪律、汇报要求）
- [`docs/DESIGN.md`](docs/DESIGN.md) — 设计取舍与全部公式，含与官方样例的对照
- [`docs/SCHEMA.md`](docs/SCHEMA.md) — 固定 JSON 契约
- [`docs/JEV-COMPAT.md`](docs/JEV-COMPAT.md) — **真实 TypeSafe Jev 的接口契约、官方样例、已知失败模式，以及本技能与它的差异**
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — 开发历程与踩坑

## 五条读法上的硬规矩

1. `confidence` **不是**「答案正确的概率」，它是分布集中程度；要卡阈值请用被选中项自身的概率。
2. `noul: 0.5` 是「分不出来」，不是「中等强度」。
3. `score` 是概率加权期望，可以落在两档之间，但**不要当精确测量值**（TypeSafe 自己说评分等级数值校准很弱）。
4. 概率是**分组性质**的，不保证单条正确。`confidence < 0.5` 或一致率低时不要用于自动决策。
5. 本技能不做**没有真值**的问题（好不好、该不该、预测未来）——会挡下来并给可回答的改写。

## 许可证

MIT
