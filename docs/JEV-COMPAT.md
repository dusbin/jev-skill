# 与真实 TypeSafe Jev 的对照

> 本技能是**类 Jev**（JEV-like），不是 Jev 的封装。这份文档记录调研到的真实契约、
> 我们刻意保持一致的部分、以及**有意不同的部分**——最后一项最重要，因为「哪些字段能直接发给真实 Jev」
> 和「哪些地方我们会和它不一样」必须能被一眼看清。

调研时间：2026-09。来源以 TypeSafe 官方文档为准（`docs.typesafe.ai`），
另有 AI/ML 网关的镜像文档、以及 MIT 许可的客户端实现 [`docxology/daf-jev`](https://github.com/docxology/daf-jev)（其 `docs/reference/` 是官方文档的冻结快照）。

---

## 一、Jev 是什么

- **TypeSafe AI**（旧金山，2024 成立，DCVC 领投 4000 万美元种子轮）的「System One」模型，
  2026-09-15 早期访问发布。CEO **Diogo Almeida**（InstructGPT/RLHF 论文共同作者）。
- **System One** 取意卡尼曼《思考，快与慢》的「快系统」：快速、直觉化的判断。
- **Jev** 取意 William Stanley Jevons（杰文斯悖论）。
- 训练范式自称 **RLCD**（Reinforcement Learning for Calibrated Decisions），
  目标是概率的**认知诚实度**（epistemic honesty），区别于 RLHF（人类偏好）与 RLVR（可验证奖励）。
- 口号 **"Decisions, not strings."** ——你发 `state` + 带类型的 `questions`，答案空间在请求离开你的服务器
  **之前**就被固定，拿回的是可被代码分支的带类型答案与概率分布。

**它明确不做的事**（官方原文）：

> "System One models do not write replies, produce code, or generate explanations of their reasoning."

即：不写回复、不生成代码、**不解释推理过程**。输入只有文本（无图像/音频/视频），
无对话历史、无 system prompt，**不是计算器**（计数、日期比较都不可靠）。

**"零幻觉" 是结构性的，不是正确性保证。** TypeSafe 自家技能里写得很清楚：
"Typed output guarantees the interface, not truth." ——类型保证的是接口，不是真值。

---

## 二、真实 API 契约（本技能逐字段对齐的部分）

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

其他可用入口：`GET /v1/models`；AI/ML API 走的是**另一条路径** `POST https://api.aimlapi.com/v1/decisions`。
（`openrouter.ai` 上**没有**公开的 jev slug：`/api/v1/models` 里搜不到，`/api/v1/models/typesafe/jev` 返回 404，
网页 200 但其路由树里是 `private-model-redirect`。不要假设存在公开 slug。）

### 请求

```json
{
  "state": "Hi, I've been trying to connect my Stripe account for 3 days and it keeps failing.",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this",
      "criteria": {
        "billing": "Payment or subscription issues",
        "technical": "Bugs or integration problems",
        "sales": "Pricing or account questions"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated the customer appears",
      "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"]
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "The message conveys urgency or time-sensitivity"
    }
  }
}
```

- 顶层三个字段**全部必填**：`state`（string / object / array）、`model`、`questions`（map）。
- **没有** `messages`、`system`、`temperature`、`top_p`、`seed`、`max_tokens`、`stream`。请求是无状态的。
- `instructions` 可以是 string / object / array。`state` 是对象时，用反引号路径引用：`` Does `ticket.messages[0].text` request a refund? ``
- 每个问题的 `criteria`：
  - `noul` —— **可选** `{"true": 描述, "false": 描述}`
  - `choice` —— **必填** map；**最多 255 个选项**；值为 `null` 表示「键名本身就够清楚」
  - `score` —— **必填**、**有序**（低→高）的数组；**至少 2 档，最多 10 档**
- **问题 id 不会发给模型**（"not used in inference"），只用于把答案对回去。

### 响应

```json
{
  "model": "jev-latest",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "technical",
      "probabilities": { "billing": 0.159, "technical": 0.84, "sales": 0.001 },
      "confidence": 0.596
    },
    "frustration": {
      "type": "score",
      "score": 1.035,
      "legend": { "0": "Calm, just stating facts", "1": "Frustrated but civil", "2": "Very angry, strong language" },
      "confidence": 0.842
    },
    "is_urgent": { "type": "noul", "noul": 0.999 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```

三条**必须记住**的形态规则：

| 题型 | 答案字段 | 说明 |
|---|---|---|
| `noul` | `{type, noul}` | 0–1 的概率，**没有 `confidence`**（官方：「Noul answers don't carry one」） |
| `choice` | `{type, choice, probabilities, confidence}` | `choice` 是 argmax；`probabilities` 的键就是你的选项键，和为 1 |
| `score` | `{type, score, legend, probabilities, confidence}` | `score` 是**档位下标的概率加权期望**（可为小数）；`legend` 是 `"0"/"1"/…` → 等级描述；`probabilities` 的键是**零起下标字符串** |

顶层 `model` 返回的是**解析后的版本号**（如 `jev-1.13.0`），不是 `jev-latest` 这个别名。

### `confidence` 是私有统计量——这点非常关键

官方原文：

> "you are never locked into our definition… The pros and cons of different computations is a specialized topic
> that we'll keep to a separate cookbook rather than this page."

也就是说 **TypeSafe 没有公布 confidence 的算法**，而且它**不是**下列任何一种（用官方自己公布的样例即可证伪）：

| 官方公布的分布 | 官方 confidence | 若是 max-prob | 若是归一化熵 | 若是前二名差 |
|---|---|---|---|---|
| `{0, 0.02, 0.98}` | 0.97 | 0.98 | 0.91 | 0.96 |
| `{0, 0.16, 0.84}` | **0.76** | 0.84 | 0.60 | 0.68 |
| `{0.001, 0.159, 0.84}` | **0.596** | 0.84 | 0.59 | 0.68 |
| `{0.04, 0.35, 0.61}` | 0.42 | 0.61 | 0.73 | 0.26 |
| `{0.02, 0.24, 0.34, 0.40}` | 0.20 | 0.40 | 0.17 | 0.06 |

**看第二行与第三行**：两个几乎相同的分布（`0.16/0.84` 与 `0.159/0.001/0.84`）给出的 confidence 却是
**0.76 和 0.596**。这说明它的 confidence 还依赖显示的两位小数之外的信息（多半是未舍入的内部概率或 logits）。
**结论：把 Jev 的 confidence 当作不透明的厂商统计量**，需要可辩护的数字时自己从 `probabilities` 算。

Vercel AI SDK 也警告过它「**不是被选中项的概率，也不是可移植的置信度量度**」。

---

## 三、官方给出的工程建议（本技能照做的部分）

1. **一次请求问完所有问题**。同一 `state` 的问题严格相互独立、并行评估、互相看不见答案。
   官方 cookbook 实测 13 个问题批量比 13 次单独调用**便宜 11.5 倍、快 9.6 倍**，答案不变。
   —— 本技能第三步天然是「一次决策 = 一次响应」。
2. **一个调用一个问题**。「Is this lead valuable, urgent, and likely to buy?」是三个问题穿了同一件外套。
   —— 本技能第二步的校验器会拦住带「和/以及/或」的复合判断题。
3. **不要写 prompt**。Jev 不是文本生成器；它要的是 state、一个原子问题、以及每个答案的精确含义。
   —— 本技能的 judge 提示里明确写了「不要解释方法论、不要复述题目」。
4. **描述性 criteria 比光秃秃的标签好判**。选项名与描述**都会发给模型**。
   —— 本技能第二步会警告「选项没有描述」。
5. **当选项集合可能覆盖不全时，加一个 `other` / `none of the above`**。
   —— 本技能只对**归类型**题目警告这一点（`kind: 'classify'`）；数学/英语的答案型四选一里「其他」是错误选项。
6. **别让模型做算术，也别让它做日期比较**。「Jev is not a calculator」，计数、日期排序都不可靠。
   —— 本技能的数学领域判题要点第一条就是「先算再判，能验算的必须验算」，
   并在 basis 里要求写出验算结果。
7. **不要用 score 推算两档之间的精确数值**。官方原文：
   > "Please do not use score outputs (e.g., expectations and probability) to compute the exact magnitude of a
   > number between two levels… `jev-1.13`'s score levels are **weak in numerical calibration**."
   —— 本技能在 `--round-score` 提供了「取整档」这条更保守的路径。
8. **阈值要随风险变化**，并用三档：高 → 自动执行；中 → 确认/复核；低 → 不执行、转人工。
   —— 本技能的终端渲染直接给出这三档建议，SKILL.md 里也要求按三档汇报。
9. **校准是分组性质**：「Calibration is measured across groups of predictions; it does not guarantee that an
   individual answer is correct.」——本技能 `jev calibrate` 强制输出样本量，低于 30 条时明确说「只能当趋势看」。

---

## 四、官方承认的失败模式（本技能针对性处理的）

TypeSafe 有一页自家模型的 jaggedness 文档，等于官方的问题清单。摘出对本技能影响最大的：

| 官方承认的问题 | 原文要点 | 本技能的处理 |
|---|---|---|
| **字面理解** | "answers the question you wrote, not the one you meant" | judge 提示要求 basis 摘录 state 原文；第二步的 `truth_apt` 检查会挡住没有真值的问题 |
| **不是计算器** | 计数、日期、数值比较都不可靠，规模越大越错 | 数学领域判题要点要求「先算再判 + 代入验算」 |
| **日期按文本读** | "as text, not as ordered quantities" | 不生成日期比较类问题 |
| **对抗内容不设防** | "does not treat it as hostile by default"，提示注入能改变答案 | `checkInjection()` 检测「忽略以上指令」「正确答案是 X」等模式，**报警不拦截**（state 里也可能合理地出现这类字面内容） |
| **instructions 与 criteria 冲突** | 例如给 `true` 映射到「否」的 noul 会变差 | 本技能的 noul 模板固定 `true` = 「成立」 |
| **措辞敏感** | 更委婉/间接的问法会降低一致率 | 问题模板把问法固定下来，减少每次重写的漂移 |
| **CJK 精度较低** | "other languages, including CJK scripts, are accepted but currently have lower accuracy" | ⚠️ **这一条我们与它不同**：本技能的判断来自 DeepSeek / 当前 Agent，中文是强项；这条限制属于真实 Jev |
| **别名漂移** | `jev-latest` 背后的版本会换，响应里才有解析后的版本 | 本技能在 `provenance.model` 里记录实际用于判断的模型名 |
| **速率限制随时变** | 250k tokens/s、1200 req/min，且"change without notice" | 本技能不依赖真实 Jev 的限额（默认不联网） |

另有一份第三方实测（pingwest，50 条中文客服消息 × 4 个判断）值得记住其结论形状：
Jev 全对率约 64–65%，延迟 0.73–0.75 s/题，全部 50 条约 0.002 美元；**阈值脆**——
人工标注的下限是 2.00，Jev 返回 1.99；15 次重复中有 3 个问题在通过/不通过之间翻转。
「返回精确到小数点的数字，不会自动让业务规则可靠」——这句话是本技能反复强调
「confidence 低就不要用于自动决策」的直接来源。

---

## 五、本技能与真实 Jev 的差异（**请务必看清这一节**）

| 维度 | 真实 TypeSafe Jev | 本技能 | 影响 |
|---|---|---|---|
| **概率从哪来** | 在 RLCD 目标下训练出来的专用模型 | **模型给支持度 + 引擎 softmax 换算** | 本技能的概率来自通用 LLM 的判断，**不保证与 Jev 校准水平相当** |
| **choice 选项上限** | **255** | **默认 4**（`--max-options` 可放宽到 255） | 4 是本技能的规格；`provenance.limits` 里会注明这一点 |
| **score 等级数** | 2–10 | 2–10 | 一致 |
| **noul** | 概率，无 confidence | 一致 | 一致 |
| **confidence 公式** | 未公开的私有统计量 | **公开**：`0.75·(p₁−p₂)/(1−p₂) + 0.25·(1 − H/ln n)` | 两者数值不同（平均绝对误差约 0.07，见 DESIGN.md 对照表），但方向一致 |
| **是否解释推理** | 不返回任何解释 | 额外提供 `judgment.basis`（每条摘录原文） | 本技能**多给了**可审计性；注意这部分不在 Jev 的原生 `response` 里 |
| **是否联网** | 必须 | 默认**离线**（provider=agent）；`--provider deepseek` 才联网 | 默认路径不需要 API key |
| **模型名** | `jev-latest` → `jev-1.13.0` | `request.model` 默认写 `jev-latest`（便于原样转发）；`provenance.model` 记录实际判断者 | 产物里的 `request` 可直接 POST 给真实 Jev |
| **语言** | 英文为主，CJK 精度较低 | 中文为一等公民（判断由中文强的模型完成） | 中文场景下本技能可能反而更合适 |

### 可以互操作的边界

- **`decision.json` 的 `request` 字段就是一份合法的 Jev 请求**：把它原样
  `POST https://api.typesafe.ai/v1/systemone`（带上你的 key）就能拿到真实 Jev 的 `answers` 做交叉验证。
  用 `jev verify <file> --print-request` 可以直接打印出这个请求体。
- **`response` 字段的形状与真实 Jev 响应一致**（`{model, answers, usage}`），
  所以任何按 Jev 响应写的消费代码都能直接吃本技能的产物。
- **反向也行**：如果你有真实 Jev 的响应，它的 `answers` 通过 `validateJevResponse` 能直接被本技能校验。

### 一句话总结

> 本技能把**契约**做得和 Jev 一样严（同样的三种题型、同样的字段、同样的限制、同样的数学定义），
> 但**判断层**换成了你手边的通用模型（当前 Agent 或 DeepSeek）。
> 所以：**格式可以互换，概率不可互换**——本技能的数字不继承 Jev 的校准水平，
> 想要校准数字，用 `jev calibrate` 在自己的数据上量一遍。

---

## 六、参考来源

- TypeSafe 官方文档：<https://docs.typesafe.ai/>（`introduction/quickstart`、`primitives/{noul,choice,score}`、
  `confidence`、`concepts/system-one`、`model-jaggedness/jev-1.13`、`api`、`agent-skill`）
- 官方文档索引（可 `llms.txt` 方式抓取）：<https://docs.typesafe.ai/llms.txt>
- AI/ML API 镜像文档（路径不同，含 `usd_spent` 等网关字段）：<https://docs.aimlapi.com/api-references/decision-models/typesafe/jev>
- 官方 skills 仓库：<https://github.com/typesafe-ai/skills>
- 第三方客户端（MIT，含官方文档冻结快照）：<https://github.com/docxology/daf-jev>
- Vercel AI Gateway 变更通告：<https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway>
- 工程实践长文（角色划分、提问设计）：<https://apidog.com/blog/how-to-use-jev/>
- 第三方实测：<https://www.pingwest.com/a/317597>
