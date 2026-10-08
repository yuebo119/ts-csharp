# r08 实施报告：三项候选的下层归因，一项落地

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-08 ｜ 轮次: r08 ｜ 主题: initializer-path-and-relation-attribution
> 涉及 git 节点: `7afa7c1eb4`（r07，`pkgs/r07` sha256 `e0cb5c3dd1db…`）/ 本轮提交
> 数据来源: CoreCLR 诊断构建的帧级探针（本轮新增 7 帧）；`bench/AB65`（r08 vs r07，23 负载 × 15 组配对，噪声 6.8%）
> 关联: `docs/csharp-perf-report-r07.md`（三项候选的提出）

---

## 1. 结论

| r07 候选 | 本轮实测结论 | 处置 |
| --- | --- | --- |
| 初始化器检查路径（0.24 s / 54.8 MB） | 拆出三层：**上下文类型查询占 0.187 s + 15.2 MB 的重复计算**，表达式检查仅 0.073 s / 8.0 MB | 已定位到具体函数与重复调用点；修复需上下文类型记忆化（有语义风险，见 §5） |
| 结构关系本体（0.25 s，15 µs/次） | 拆出：逐属性比较 0.064 s，**多余属性检查为 0**（源类型是加宽后的非新鲜类型，根本不进入该分支），其余 0.14 s 是会话/递归/规范化机制 | 落地 `RelationKeys` 快路径；会话机制改造留待下一轮 |
| `Part[]`（61 MB） | 本轮未动 | 依据不变，需按调用点直推化，单独一轮 |

AB65（r08 vs r07）：墙钟平均 x1.002，噪声 6.8%，墙钟更优 8/23、CPU 更优 7/23，巨文件 wall x1.012 [1.000,1.023]。即本轮改动**在当前分辨率下中性**。

---

## 2. 初始化器检查路径：三层拆解（巨文件，32K 个属性初始化器）

| 帧 | 时间 | 分配 | 每属性 |
| --- | ---: | ---: | ---: |
| objectPropertyInit | 0.345 s | 54.8 MB | 1.7 KB |
| ├ objectMutable | 0.338 s | 54.8 MB | 与上层几乎相同 → 开销全在 `MutableAsync` |
| ├ ├ **mutableConst**（`ConstAsync`） | **0.187 s** | **24.7 MB** | **0.77 KB** |
| ├ ├ objectCheckExpr（表达式检查） | 0.073 s | 8.0 MB | 0.25 KB |
| ├ ├ mutableContextual（上下文类型 + 实例化） | 0.053 s | 15.2 MB | 0.48 KB |
| └ └ mutableWiden（加宽 + 映射 + 规范化） | < 0.05 s | ~6.8 MB | |

读法：`ConstAsync` 对**字面量**（`ConstArgumentAsync` 对数字/字符串/数组/对象字面量一律返回 true）会继续查询**上下文类型**并做 `const` 类型参数推断；而 `MutableAsync` 在加宽阶段**再次查询同一节点的上下文类型**。同一个查询被调用两次，合计 39.9 MB（占全量分配 8.4%）与约 0.24 s（占 check 18%）。

`ContextAsync.GetAsync` 的路径（供修复参考）：节点→父节点分派；属性初始化器走 `ObjectElementContextAsync` → `Contexts.ApparentAsync(对象字面量)`（命中上下文栈缓存）+ `ContextualProperties.GetAsync(类型, 属性名, NameType)`；初次查询还会经 `links.Values.Get(属性符号)` 建链接。

---

## 3. 结构关系本体：拆解与一处修正

| 帧 | 时间 | 说明 |
| --- | ---: | --- |
| checkerRelated（结构比较整体） | 0.208 s | 16K 次 → 13 µs/次 |
| ├ relationProperties（逐目标属性查找+比较） | 0.064 s | 31%：每个目标属性一次 `PropertyAsync(source, name)` |
| ├ relationExcess（多余属性检查） | **0（未触发）** | **修正 r07 的假设**：源类型是加宽后的普通对象类型，不是 `ObjectLiteral\|FreshLiteral`，`StructuralRelations.RelatedAsync` 第 85 行的前提不成立 |
| └ 其余 | ~0.14 s | 每次比较的固定开销：`RelationSession` 键/缓存/maybe 集合/栈 + `TypeNormalization.GetAsync` ×2 + ~15 次 await |

落地：`RelationKeys.CreateAsync` 增加"两侧都不是 `TypeReference` 时直接返回普通键"的快路径，省掉两次 `GenericAsync` 探测（该方法对非 `TypeReference` 必为 false，等价性可证）。AB65 上为中性，保留理由是严格更少工作且无语义变化。

---

## 4. 本轮改动清单

| 文件 | 改动 |
| --- | --- |
| `Diagnostics/AllocationProbes.cs` | 新增 7 个帧：`objectMutable`、`objectCheckExpr`、`relationProperties`、`relationExcess`、`mutableConst`、`mutableContextual`、`mutableWiden` |
| `Checking/ExpressionContexts.cs` | `MutableAsync` 内三段计时/计数 |
| `Checking/ObjectRelations.cs` | `PropertiesAsync` 拆出核心方法并挂帧 |
| `Checking/ExcessProperties.cs` | `HasAsync` 拆出核心方法并挂帧 |
| `Checking/RelationKeys.cs` | 非 `TypeReference` 快路径 |

---

## 5. 下一轮的两个定点（含本轮量化）

| 项 | 量级 | 具体做法 | 风险 |
| --- | ---: | --- | --- |
| 上下文类型重复查询 | 39.9 MB（8.4% 总分配）+ 0.24 s（18% of check） | 每属性只算一次：`ConstAsync` 的 const 推断与 `MutableAsync` 的加宽共用同一个上下文类型值（把 `ConstAsync` 改为接受已算出的上下文类型，或在 `ExpressionContexts` 内按节点记忆化） | 上下文类型依赖 `flags`/模式与延迟推断（`DeferExpression`/`IntraExpressionSites`），记忆化必须按节点+flags 且能随推断更新，需先做语义审查 |
| `ConstVariableAsync` 的每次调用 `Stack<(Type,int)>` | 2.8 MB | 改为惰性分配（首个 push 时才建栈） | 无（局部用法） |
| 结构关系的会话机制 | 0.14 s | 评估 `RelationSession.RecursiveCoreAsync` 在"两侧均为已解析匿名对象类型"时的一次性快路径（属性名集合相同 + 属性类型引用相同 + 无索引/签名） | 需逐条证明与完整算法等价，语料门禁必须全过 |
| `Part[]` | 61 MB | 按调用点直推化（`S(...)` → 直接 push） | 改动面大，单独一轮 |

---

## 6. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（AOT 产品形态，`pkgs/r08` sha256 `81dadb6ca9d1…`） |
| 逐字节一致 | 5 个基准负载（1,223 个产物）+ 16 个语句形态夹具，全部与未改动产物一致 |
| safety 套件 | `checker-relations`、`checker-objects`、`checker-generic-relations`、`checker-inference`、`checker-members`、`emit-foundations`、`transpile`、`declaration` 全部通过 |
| 配对 A/B | AB65：墙钟平均 x1.002（噪声 6.8%），无显著变化 |
