# 数据契约（固定 JSON）

本技能的一切产物都是**带 `schema` 字段的纯 JSON**，四个管线脚本靠它们串联。
任一份产物都可以被人工或模型编辑后重跑下游。

契约分两层，**不要混**：

| 层 | 字段 | 谁能改 |
|---|---|---|
| **Jev 兼容层** | `request` / `response` | **不能加字段**。加了就不再是合法的 Jev 请求/响应 |
| **信封层** | `schema` / `kind` / `domain` / `questions` / `judgment` / `derivation` / `consistency` / `provenance` | 本技能自有，用于审计与复用 |

## 版本号

| schema | 产物 | 生成者 | 消费者 |
|---|---|---|---|
| `jev/domain@1` | `domain.json` | `jev identify` | `jev ask` |
| `jev/questions@1` | `questions.json` | `jev ask` | `jev decide` |
| `jev/judgment@1` | `judgment.json` | 模型 / 人 | `jev decide` |
| `jev/decision@1` | `decision.json` | `jev decide` | `jev verify` / `jev calibrate` / 下游代码 |
| `jev/calibration@1` | `calibration.json` | `jev calibrate` | 人 |

**改结构必须升版本号**，并有测试兜底（`test/schema.test.mjs` 会校验信封的字段顺序与数量）。

---

## 一、`jev/decision@1` —— 最终产物（固定格式）

顶层字段与顺序**固定为 12 个**（`test/schema.test.mjs` 里有断言）：

```json
{
  "schema": "jev/decision@1",
  "kind": "decision",
  "generated_at": "2026-03-02T10:00:00Z",
  "generator": { "name": "jev-skill", "version": "0.1.0" },
  "domain": { "id": "math", "name": "数学", "category": "学科类", "source": "user" },
  "questions": [ /* 见 1.1 */ ],
  "request": { "model": "jev-latest", "state": "…", "questions": { "…": {} } },
  "response": { "model": "…", "answers": { "…": {} }, "usage": {} },
  "judgment": { /* 见 1.4 */ },
  "derivation": { /* 见 1.5 */ },
  "consistency": null,
  "provenance": { /* 见 1.6 */ }
}
```

### 1.1 `questions[]` —— 题目（含出题元数据）

```json
{
  "id": "q-16b0a7b0",
  "type": "choice",
  "instructions": "下列选项中，哪一个是该题的正确答案？",
  "criteria": { "A": "x=1", "B": "x=2", "C": "x=4", "D": "x=6" },
  "origin": "predefined",
  "template": "math-choice-options",
  "kind": "answer",
  "score_set": null,
  "why": "输入里已经带了选项，直接用它们做 criteria…"
}
```

| 字段 | 说明 |
|---|---|
| `id` | `sha1(模板id \| 归一化输入)` 的短哈希 → **同输入同 id，可 diff** |
| `type` | `choice` / `score` / `noul` |
| `criteria` | choice = 选项 map；score = 有序等级数组；noul = 可选的 `{true, false}` |
| `origin` | `predefined`（领域模板）或 `user`（用户自定义） |
| `kind` | `answer`（答案型）/ `classify`（归类型）/ `null`。**只用于校验，不进请求** |
| `score_set` | score 题取自哪套领域等级集（如「难度」） |
| `why` | 为什么这样问（会显示给用户） |

> `id` / `origin` / `template` / `kind` / `score_set` / `why` 是信封元数据。
> `toJevQuestion()` 只把 `type` / `instructions` / `criteria` 放进请求 —— **多一个字段发出去就不是 Jev 了**。

### 1.2 `request` —— 可直接发给真实 Jev

与 TypeSafe Jev 的请求体**逐字段一致**，可以原样 `POST https://api.typesafe.ai/v1/systemone`：

```json
{
  "model": "jev-latest",
  "state": "解方程 x²-5x+6=0，下列哪个是它的解？ A. x=1 B. x=2 C. x=4 D. x=6",
  "questions": {
    "q-16b0a7b0": {
      "type": "choice",
      "instructions": "下列选项中，哪一个是该题的正确答案？",
      "criteria": { "A": "x=1", "B": "x=2", "C": "x=4", "D": "x=6" }
    }
  }
}
```

用 `jev verify <file> --print-request` 直接打印。

### 1.3 `response` —— Jev 原生答案

**只有三种形状**，与真实 Jev 逐字段一致：

```json
{
  "model": "jev-agent/agent",
  "answers": {
    "q-choice": { "type": "choice", "choice": "B",
                  "probabilities": { "A": 0.0174, "B": 0.9478, "C": 0.0174, "D": 0.0174 },
                  "confidence": 0.913 },
    "q-score":  { "type": "score", "score": 1.4352,
                  "legend": { "0": "…", "1": "…", "2": "…", "3": "…", "4": "…" },
                  "probabilities": { "0": 0.061, "1": 0.613, "…": 0.0 },
                  "confidence": 0.4528 },
    "q-noul":   { "type": "noul", "noul": 0.93 }
  },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

硬性约束（`validateJevAnswer` 会全部检查）：

| 题型 | 约束 |
|---|---|
| `noul` | `noul ∈ [0,1]`；**不得携带 `confidence`**（真实的 Jev 也没有） |
| `choice` | `choice` 必须是 `probabilities` 的 argmax；`probabilities` 的键必须**完整覆盖**题目选项；和 = 1（容差 1e-6） |
| `score` | `probabilities` 的键是**零起下标字符串**，和 = 1；`legend[i]` 必须逐档对上 `criteria[i]`；**`score` 必须等于 `Σ i·pᵢ`**（Jev 的定义） |

`usage` 在 `provider=agent` 时是 `{0, 0}`，这是正常的（没有网络调用），不是「没做事」。

### 1.4 `judgment` —— 模型的原始判断（可审计）

```json
{
  "schema": "jev/judgment@1",
  "answers": {
    "q-16b0a7b0": {
      "type": "choice",
      "scores": { "A": 0, "B": 4, "C": 0, "D": 0 },
      "basis": [
        "支持 B（x=2）：把 x=2 代入原式得 4-10+6=0，等式成立 → 2 是 x²-5x+6=0 的根。",
        "不支持 A（x=1）：代入得 1-5+6=2≠0 → 不是根。"
      ]
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `scores` | choice / score 用：选项或等级 → **任意实数**（支持度，不是概率）。键必须与题目完全一致 |
| `p` | noul 用：模型的概率直接值（0–1），引擎只做裁剪 |
| `support` | noul 用：对数几率，引擎走 `sigmoid` |
| `basis` | 依据数组。**不是必填，但不填就等于放弃了可审计性** |

`--samples N` 时这里是 `{schema, samples: [judgment, …], note}`。

### 1.5 `derivation` —— 数字是怎么算出来的

```json
{
  "q-16b0a7b0": {
    "kind": "choice",
    "method": "softmax(scores / 1)，再按 4 位归一",
    "scores": { "A": 0, "B": 4, "C": 0, "D": 0 },
    "temperature": 1,
    "probabilities": { "A": 0.0174, "B": 0.9478, "C": 0.0174, "D": 0.0174 },
    "stats": { "n": 4, "top": 0.9478, "runner_up": 0.0174,
               "entropy": 0.2646, "normalized_entropy": 0.1889, "normalized_margin": 0.9470 }
  }
}
```

score 题的 derivation 额外带 `expected_score` 与 `rounded_score`。
`--samples N` 时额外带 `per_sample_probabilities`。

有了这一块，任何人都能用纸笔复算出 `confidence` —— 这正是它存在的意义。

### 1.6 `provenance` —— 谁、用什么、在什么限制下算的

```json
{
  "provider": "agent",
  "provider_name": "当前 Agent 的模型",
  "model": "jev-agent/agent",
  "samples": 1,
  "state_injection": { "suspicious": false, "findings": [], "advice": "" },
  "engine": {
    "softmax_temperature": 1,
    "confidence_margin_weight": 0.75,
    "confidence_formula": "confidence = 0.75·(p₁−p₂)/(1−p₂) + 0.25·(1 − H(p)/ln n)",
    "score_rule": "Σ i·pᵢ（概率加权期望，Jev 原生定义）",
    "probability_digits": 4
  },
  "limits": {
    "choice_max_options": 4,
    "choice_max_options_note": "这是本技能的规格；TypeSafe Jev 自身支持最多 255 个选项。",
    "score_levels": [2, 10]
  },
  "deterministic": true,
  "notes": ["判断由当前 Agent 提供，未经过网络调用：usage 为 0 是正常的，不代表没做事。"]
}
```

`limits` 里那句 note 是刻意的：**限制本身也是留痕的一部分**——看到产物的人应该知道这是谁的规矩。

### 1.7 `consistency` —— 多采样一致性

`--samples 1` 时为 `null`；`>1` 时：

```json
{
  "q-16b0a7b0": {
    "samples": 5,
    "agreement": 0.6,
    "flips": 2,
    "label_distribution": { "A": 3, "B": 2, "C": 0, "D": 0 }
  }
}
```

**一致率低的问题应当被当作「这条结论不能用于自动决策」。**

---

## 二、`jev/domain@1` —— 第一步产物

```json
{
  "schema": "jev/domain@1",
  "input": "解方程 x²-5x+6=0…",
  "source": "rule",
  "domain": { "id": "math", "name": "数学", "category": "学科类" },
  "decided_domain": { "id": "math", "name": "数学", "category": "学科类" },
  "confidence": 0.7551,
  "decision": "auto",
  "margin": 1,
  "evidence_mass": 14,
  "scores": [
    { "id": "math", "name": "数学", "raw": 13, "share": 0.8125,
      "hits": [{ "term": "方程", "weight": 3, "count": 1, "kind": "strong", "score": 3 }] }
  ],
  "candidates": [{ "id": "math", "name": "数学", "raw": 13 }],
  "notes": ["判定依据：…"],
  "state_injection": { "suspicious": false, "findings": [], "advice": "" }
}
```

| 字段 | 说明 |
|---|---|
| `source` | `user`（用户指定）/ `rule`（规则识别） |
| `decision` | `auto`（confidence ≥ 0.55）/ `ask`（**必须回问用户**） |
| `domain` | `decision=ask` 时是 `other` |
| `decided_domain` | 无论 `ask` 与否，都保留规则算出的第一名 |
| `scores[].hits[].kind` | `strong` / `medium` / `weak` / `pattern` / **`exclude`**（反证词，`score` 为负） |

---

## 三、`jev/questions@1` —— 第二步产物

```json
{
  "schema": "jev/questions@1",
  "generated_at": "2026-03-02T10:00:00Z",
  "domain": { "id": "math", "name": "数学", "category": "学科类" },
  "state": "…",
  "max_options": 4,
  "questions": [ /* 与 decision@1 的 questions[] 同形 */ ],
  "request": { "model": "jev-latest", "state": "…", "questions": {} },
  "notes": ["题目来源：领域模板 math-choice-options"],
  "validation": { "ok": true, "errors": [], "warnings": [] }
}
```

`jev ask` 不带 `--pick` / `--custom` 时，只输出候选清单（`planQuestions` 的返回值），**不落盘**：

```json
{
  "domain": {}, "domain_meta": {}, "state": "…",
  "detected_options": [{ "label": "A", "text": "x=1", "raw": "A. x=1" }],
  "inferred_type": "choice",
  "truth_apt": { "ok": true, "status": "truth_apt", "reasons": [], "reformulations": [] },
  "candidates": [ /* 候选题目 */ ],
  "validation": [{ "id": "…", "label": "…", "type": "choice", "ok": true, "errors": [], "warnings": [] }],
  "notes": []
}
```

---

## 四、`jev/calibration@1` —— 校准报告

```json
{
  "schema": "jev/calibration@1",
  "generated_at": "2026-03-02T10:00:00Z",
  "bins": 10,
  "n": 120,
  "accuracy": 0.72,
  "accuracy_ci": { "point": 0.72, "low": 0.63, "high": 0.79 },
  "min_samples": 30,
  "confidence": {
    "n": 120, "ece": 0.11, "brier": 0.19, "mean_confidence": 0.68,
    "reliability": [{ "bin": 6, "range": [0.6, 0.7], "n": 20,
                      "mean_confidence": 0.64, "accuracy": 0.7, "gap": 0.06 }],
    "definition": "本技能的 confidence 统计量（0.75·归一化优势 + 0.25·(1−归一化熵)）"
  },
  "winning_probability": { "…": "…", "definition": "被选中那一项的 probabilities 值（要卡阈值应该用这个）" },
  "warnings": []
}
```

**样本少于 `min_samples`（默认 30）时 `warnings` 里会出现明确提示**——校准是分组性质，
样本不足时测的是噪声。

---

## 五、校验

任何产物都可以用同一套检查复现：

```bash
node scripts/jev-verify.mjs out/x.json              # 0 = 通过，1 = 有错
node scripts/jev-verify.mjs out/*.json --strict     # 有警告也算失败
node scripts/jev-verify.mjs out/x.json --print-request   # 额外打印可直发真实 Jev 的请求体
node scripts/jev-verify.mjs out/x.json --print-answers   # 额外打印 Jev 原生 answers
```

`validateDecision` 的检查清单（与 `jev verify` 一一对应）：

1. 顶层 12 个字段齐全，`schema` / `kind` 正确，`generated_at` 是 ISO 时间戳；
2. `questions[]` 逐个过 `validateQuestion`（含选项数上限、等级数、复合问题、泄漏答案等）；
3. `request` 过 `validateJevRequest`（含 model/state/questions 三件套）；
4. `response` 过 `validateJevResponse`：
   - 每道题都有答案；
   - **答案的 `type` 必须与题目一致**（在 `noul` 题上给 `choice` 会被抓住）；
   - 逐个过 `validateJevAnswer`（概率和、argmax、legend、`score = Σ i·pᵢ`）；
5. `provenance.provider` 非空；缺 `provenance.engine` 给警告（无法复现概率来源）；
6. `derivation` / `consistency` 若存在必须是对象或 `null`。
