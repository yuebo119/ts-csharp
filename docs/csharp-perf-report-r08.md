# r08 实施报告：三项候选的下层归因，一项落地

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-08 ｜ 轮次: r08 ｜ 主题: initializer-path-and-relation-attribution
> 涉及 git 节点: `7afa7c1eb4`（r07，`pkgs/r07` sha256 `e0cb5c3dd1db…`）/ 本轮提交
> 数据来源: CoreCLR 诊断构建的帧级探针（本轮新增 7 帧）；`bench/AB65`（r08 vs r07，23 负载 × 15 组配对，噪声 6.8%）
> 关联: `docs/csharp-perf-report-r07.md`（三项候选的提出）

---

## 1. 结论

| r07 候选 | 本轮实测结论 | 处置 |
| --- | --- | --- |
| 初始化器检查路径（0.24 s / 54.8 MB） | 拆出三层：**上下文类型查询被调用两次**（`ConstAsync` 的 const 推断 + `MutableAsync` 的加宽），合计 39.9 MB / 0.24 s；表达式检查仅 0.073 s / 8.0 MB | **已落地门控**：可证明无 const 类型参数时跳过该查询 → 产品 AOT 分配 **465.5 → 441.9 MB（−5.1%）** |
| 结构关系本体（0.25 s，15 µs/次） | 拆出：逐属性比较 0.064 s，**多余属性检查为 0**（源类型是加宽后的非新鲜类型，根本不进入该分支），其余 0.14 s 是会话/递归/规范化机制 | 落地 `RelationKeys` 快路径；会话机制改造留待下一轮 |
| `Part[]`（61 MB） | 本轮未动 | 依据不变，需按调用点直推化，单独一轮 |

AB66（r08 vs r07，23 负载 × 15 组配对，噪声 **3.6%**）：墙钟平均 x1.002（11/23 更快），CPU 平均 x1.024；巨文件 873 → 860 ms（x0.984 [0.971,1.004]）；`declarations` 139 → 150 ms（x1.084 [1.043,1.126]，**CPU x1.00 不变**，判为墙钟/IO 侧异常，代码工作量未变）。分配削减 −5.1% 为确定性结果。

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

### 2.1 落地：`ConstAsync` 的 const 类型参数门控

`ConstVariableAsync` 只在上下文类型是（或按深度 ≤5 包含）带 `const` 修饰符的 `TypeParameter` 时返回 true，而上下文类型能携带类型参数只有两条来源：

1. 祖先路径上的**签名/类/接口/类型别名/映射类型/条件类型/infer 子句**声明的类型参数（含 `const` 修饰符）；
2. **被调方签名**提供的上下文类型，即可从实参、装饰器、标签模板、JSX 位置到达。

`TypeParameterQueryPossible(node)` 用一次祖先遍历判定这两类情形，两者都不成立时跳过 `GetAsync` 与 `ConstVariableAsync`。巨文件夹具的属性初始化器不属于任何一类 → 每属性省掉 0.77 KB 与约 5.8 µs。

**一次被对抗夹具抓住的不健全版本（记录在案）**：第一版只判"祖先是否有类型参数容器"，漏掉了第 2 条来源，在 `declare function pick<const T>(v: T): T; const a = pick({ x: 1 })` 这类实参位置上会错误跳过 const 推断 → 新增的 `constarg`/`constprop` 两个夹具立刻报 `.d.ts` 逐字节不一致，随后补上实参/JSX 判定并通过。**结论：门控类改动必须先有覆盖被门控分支的正例夹具，再谈收益。**

效果：产品 AOT 分配 **465.5 → 441.9 MB（−5.1%）**，`Check time` 巨文件 0.333~0.348 → 0.322~0.329 s；AB66 墙钟平均 x1.002。

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

## 5. 下一轮的定点（含本轮量化）

| 项 | 量级 | 具体做法 | 风险 |
| --- | ---: | --- | --- |
| 实参位置上的上下文类型重复查询（门控已排除非实参位置，此处仍有两次） | 19.7 MB（`mutableConst` 残余）+ `mutableContextual` 15.2 MB | 在实参位置按节点记忆化上下文类型，或让 `ConstAsync` 复用 `MutableAsync` 已算出的值 | 上下文类型依赖 `flags`/模式与延迟推断（`DeferExpression`/`IntraExpressionSites`），记忆化需按节点+flags 且能随推断更新 |
| `ConstVariableAsync` 的每次调用 `Stack<(Type,int)>` | 2.8 MB | 改为惰性分配（首个 push 时才建栈） | 无（局部用法） |
| 结构关系的会话机制 | 0.14 s | 评估"两侧均为已解析匿名对象类型"时的一次性快路径（属性名集合相同 + 属性类型引用相同 + 无索引/签名） | 需逐条证明与完整算法等价，语料门禁必须全过 |
| `Part[]` | 61 MB | 按调用点直推化（`S(...)` → 直接 push） | 改动面大，单独一轮 |

---

## 6. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（AOT 产品形态，`pkgs/r08` sha256 `d39d70c41f71…`） |
| 逐字节一致 | 5 个基准负载（1,223 个产物）+ **18 个**语句形态夹具（新增 `constarg`/`constprop` 两个 const 类型参数正例），全部与未改动产物一致 |
| safety 套件 | `checker-inference`、`checker-constraints`、`checker-algebra`、`checker-objects`、`checker-relations`、`checker-generic-relations`、`emit-foundations`、`transpile`、`declaration` 全部通过 |
| 配对 A/B | AB66：墙钟平均 x1.002（噪声 3.6%），巨文件 x0.984；唯一显著变慢项 `declarations` 的 CPU 比值为 1.00 |
| 确定性分配 | 巨文件 465.5 → **441.9 MB（−5.1%）** |
