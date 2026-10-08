# r09 实施报告：上下文属性查询去掉映射开销，`Part[]` 构成定界

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r09 ｜ 主题: contextual-properties-and-part-arrays
> 涉及 git 节点: `4f1c28a0bb`（r08，`pkgs/r08` sha256 `d39d70c41f71…`）/ 本轮提交
> 数据来源: CoreCLR 诊断构建的帧级探针；产品 AOT 确定性分配；`bench/AB67`
> 关联: `docs/csharp-perf-report-r08.md`（剩余定点清单）

---

## 1. 结论

| 项 | 结果 |
| --- | --- |
| `ContextualProperties.GetAsync` 的映射开销 | **已去除**：非联合类型直接走单分支，不再分配闭包+委托+`MapAsync` 帧；产品 AOT 分配 441.9 → **440.3 MB**，`mutableContextual` 帧 19.7 → 17.9 MB、耗时约 −40%（同负载口径） |
| `ConstVariableAsync` 的每次调用 `Stack` | **不改**：r08 的门控已使该路径在夹具上不再触发，改它只剩长尾收益 |
| `Part[]` 61 MB | **构成已定界**：最大的形状（类型字面量 `PushTypeMembers`、属性赋值/声明 `Push(...)`、列表 `BuildList` 直推）**早已容器无关**；剩余是长尾——`Annotation`/`Initializer` 的 `S(...)`、`Scoped(...)`、`EmitSourceFile`/`Modifiers`/对象字面量等约 40 处容器，单处收益小、改动面大 |

---

## 2. `ContextualProperties.GetAsync` 的改动

原实现是 `algebra.MapAsync(type, async part => { … })`：每个上下文属性查询都要分配一个捕获 `name`/`nameType`/`cancellation` 的闭包、一个委托和一个异步状态机。而联合类型只是少数情形。现在非联合类型直接调用抽出后的 `ConstituentAsync`（保持 `Never` 短路与 `RequireOwned` 语义），联合类型仍走 `MapAsync`：

- 巨文件：`mutableContextual` 19.7 → 17.9 MB（每属性省约 60 B，32K 次）；
- 全量分配 441.9 → 440.3 MB（−1.6 MB，−0.4%）；
- 该查询是上下文类型解析的公共入口，改动面广 → 验证覆盖 5 个负载 + 18 个语句形态夹具 + 9 个套件（含 `checker-context-query`）。

---

## 3. `Part[]` 的构成（本轮新增定界，供后续单独一轮）

| 生产点 | 形态 | 是否容器无关 | 备注 |
| --- | --- | --- | --- |
| `PushTypeMembers` / `PushList` / `BuildList` | 直接 `pending.Push` | **是** | 类型字面量、成员列表、语句列表等最大形状已直推 |
| `Emit(PropertyAssignment/PropertySignature/VariableDeclaration/…)` | `Push(a, b, c, …)` | **是** | `params ReadOnlySpan<Part>` 走栈内缓冲 |
| `Annotation` / `Initializer` | `S(T(…), N(…))` → `ToArray()` | 否 | 每声明 2 个数组，夹具上 32K 次 |
| `Scoped(...)`（4 个重载） | `new(Parts: [...])` | 否 | 类型成员等场景 |
| `Emit(ObjectLiteralExpressionNode)` 等 `new(Parts: parts)` | 容器 | 否 | 对象字面量、块体、源文件等 |
| `Modifiers`（`PreserveSourceNewlines` 分支） | `new(Parts: preserved)` | 否 | 仅保留源码换行模式 |

结论：**61 MB 分布在约 40 处小容器**，单处 1–5 MB；直推化需要逐点改写并保持字节一致，属独立一轮的机械改造，风险在"改动面"而非语义。

---

## 4. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（AOT 产品形态，`pkgs/r09` sha256 `cce7e6694c1b…`） |
| 逐字节一致 | 5 个基准负载（1,223 个产物）+ 18 个语句形态夹具（含两个 const 类型参数正例），全部与未改动产物一致 |
| safety 套件 | `checker-inference`、`checker-constraints`、`checker-context-query`、`checker-objects`、`checker-relations`、`checker-expressions`、`emit-foundations`、`transpile`、`declaration` 全部通过 |
| 确定性分配 | 巨文件 441.9 → **440.3 MB** |
| 墙钟 | 本轮测量时本机有语言服务索引负载（同一二进制总耗时在 9.6~16.9 s 间跳动），只取确定性分配结论；AB67 在负载回落后复测 |

---

## 5. 剩余清单（含各自量级与前置条件）

| 项 | 量级 | 前置条件 |
| --- | ---: | --- |
| `Part[]` 直推化（约 40 处容器） | 61 MB（全量 13.9%） | 机械改造 + 每处字节一致验证，单独一轮 |
| 结构关系的会话/递归机制 | 0.14 s（`checkerRelated` 的 72%） | 需先证明"两侧已解析匿名对象类型且属性名集合与属性类型引用一致"快路径与完整算法等价 |
| 实参位置的上下文类型重复查询 | 17.9 MB | 需按节点+flags 记忆化上下文类型，且能随延迟推断更新 |
| `symbolTypesGet`（类型解析本体） | 25.4 MB / 0.15 s | 属合法工作，除非做类型级结构共享（语义风险高） |
| `typeFromNode`/`membersTable`（注解与成员表） | 20.2 / 16.7 MB | 其中 `membersTable` 主要是成员声明的检查，属合法工作 |
