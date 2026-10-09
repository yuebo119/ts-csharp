# r14 归因报告：关系引擎的分配分布，附三项被证伪的假设

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r14 ｜ 主题: relation-engine-allocation-attribution
> 涉及 git 节点: `1e1b09d7f4`（r13 勘误提交，工作树基线）
> 数据来源: CoreCLR 诊断构建的两层内层探针（每线程分配增量，跨检查器求和）；真实工程 = TS 编译器自身 186 文件 / 51,665 行
> 关联: `docs/csharp-perf-report-r13.md`（上一轮落地项）、`docs/csharp-perf-report-r10-comparison.md`（三方表）

---

## 0. 本轮结论

**本轮不落地代码改动。** 归因做完之后，关系引擎里没有任何单项超过 3%，两个最大的具名帧都是"透传"（把工作交给更深一层的类型比较或已缓存的成员解析），r13 那类"每次调用分配一个容器"的缺陷在这个引擎里不存在。三个先验假设全部被测量证伪（§4）。继续在关系引擎做微优化的性价比低于前几轮，需要的是减少**比较次数**而不是降低单次比较成本，那属于设计级改动。

---

## 1. 为什么查关系引擎

r13 轮的产品 AOT 确定性测量里，真实工程的 CLR 分配是 599.4 MB，而关系引擎的顶层帧占了接近一半。前几轮的经验（r11 打印器容器、r13 谓词工作栈）说明"每次调用分配一个临时容器"这类缺陷能贡献 2%~5%，而关系引擎是最可能藏这类缺陷的地方，因此先做归因。

口径说明：探针用 `GC.GetAllocatedBytesForCurrentThread()` 取**每线程**增量，跨线程求和后与进程级 `CLR allocated bytes` 直接可比（本次 599.45 MB）。这与 `Alloc check (summed)` 不同，后者用进程级计数器，会被并行度放大约 4 倍（本次 2167.9 MB 对 599.4 MB），只能作阶段间相对比较。

---

## 2. 关系引擎的帧层级（真实工程，总和 599.45 MB）

| 帧 | MiB | 占总分配 | 说明 |
| --- | ---: | ---: | --- |
| `relationCompare` | 255.50 | 44.7% | 单次类型比较本体 |
| `checkerRelated` | 239.65 | 41.9% | 结构关系入口 |
| `relRecurse` | 222.67 | 38.9% | 会话递归（键 + 记帐 + 结构化回调） |
| `relStructured` | 207.23 | 36.2% | 递归里的结构化回调 |
| `relAfterVar` | 165.37 | 28.9% | 方差之后的结构比较 |
| `relationRelated` | 149.29 | 26.1% | 顶层布尔关系入口 |
| `relMembers` | 138.27 | 24.2% | 属性 + 签名 + 索引三段 |
| `relSignatures` | 76.23 | 13.3% | 签名可赋值性 |
| `relSigCompare` | 71.33 | 12.5% | 签名比较本体 |
| `relSigPair` | 70.24 | 12.3% | 签名配对 |
| `relationProperties` | 68.65 | 12.0% | 属性遍历 |
| `relUnion` | 27.49 | 4.8% | 联合/交叉分发 |
| `relNormalize` | 15.13 | 2.6% | 两侧类型规范化 |
| `relVariance` | 9.42 | 1.6% | 方差 |
| `relSigCtxInst` | 6.05 | 1.1% | 签名的上下文实例化 |
| `relKey` | 1.95 | 0.3% | 关系键构造 |
| `relIndexes` | 1.11 | 0.2% | 索引签名比较 |
| `relKeyGeneric` | 0.98 | 0.2% | `GenericAsync` 的工作栈 |
| `relKeyParts` | 0.90 | 0.2% | 泛型键的 `List` + `Dictionary` |
| `relSigErased` | 0.80 | 0.1% | 签名擦除 |
| `relationExcess` | 0.41 | 0.1% | 多余属性检查 |

读法：帧是**包含式**的，父帧含子帧。`relStructured` 占 `relRecurse` 的 93%，说明递归记帐（`maybe`/`maybeSet`/两侧栈、键构造、深度检测）只占 7%。`relAfterVar` 占 `relStructured` 的 80%，`relMembers` 占 `relAfterVar` 的 84%。两个最大的具名子帧是签名可赋值性（13.3%）与属性遍历（12.0%）。

计数（同一工作负载，确定性）：`RelationKeys.CreateAsync` 115,572 次；`GenericAsync` 探测 12,172 次；泛型键构造 1,218 次；`CreateTypeReference` 29,522 次（命中 23,626，参数总数 39,611）；`RelationOperation` 分配 49,069 次。

---

## 3. 为什么这两个大帧不是可修项

**签名可赋值性 13.3% 是透传。** `relSigCompare`（71.33 MiB）几乎等于 `relSignatures`（76.23 MiB），而 `relSigCompare` 内部主要动作是对每个形参类型和返回类型调用 `operation.CompareAsync`，每次都会重新进入 `relationCompare`。也就是说这 13.3% 是递归下降本身，不是签名层的额外开销。签名层自己的开销是：擦除 0.80 MiB、上下文实例化 6.05 MiB，合计 1.1%。`SignatureParameters` 的 `CountAsync`/`HasRestAsync`/`MinimumAsync`/`ThisAsync`/`AtAsync` 全文件只有一处 LINQ（在报错分支上），本身不分配。

**属性遍历 12.0% 是成员解析与成员表构建。** `relationProperties`（68.65 MiB）的主要动作是 `properties.GetAsync(target)`（成员表，未解析时触发 `resolveMembers` 81.6 MiB，本帧与其部分重叠）与每个属性的 `properties.PropertyAsync(source, name)`，后者正是 r12 加了同步快路径的那条路径。`PropertiesCoreAsync` 的 `missing` 列表是惰性分配的，只在报错路径上创建。

**递归记帐只占 7%。** `relRecurse` − `relStructured` = 15.44 MiB。其中键构造 1.95 MiB、泛型键 0.90 MiB、`GenericAsync` 工作栈 0.98 MiB。`RelationSession` 的 `maybe`/`maybeSet`/`sourceStack`/`targetStack` 是复用字段（会话按关系种类池化），不按调用分配。

---

## 4. 三项被证伪的假设

**假设一：关系键构造是热点（r13 的同类缺陷）。** 证伪。`relKey` 1.95 MiB（0.3%）。`RelationKeys.CreateAsync` 对非引用类型直接短路（r10 加的），且 `RelationKey` 是带缓存哈希的 readonly struct，普通两类型键不分配。泛型键路径（`List<Part>` + `Dictionary<Type,int>` + `ToArray`）只走了 1,218 次。

**假设二：`GenericAsync` 的 `Stack<Type>` 是热点。** 证伪。`relKeyGeneric` 0.98 MiB（0.2%）。该分支只在两侧之一是泛型类型引用时进入，真实工程 115,572 次键构造里只有 12,172 次探测、其中更少真正分配。

**假设三：`TypeCacheKey` 每次查找都分配 `long[]` 是热点。** 证伪。`CreateTypeReference` 在真实工程只调用 **29,522** 次，两侧数组合计约 1.9 MiB（0.3%），而整个 `relNormalize` 帧是 15.13 MiB。也就是说规范化帧的 2.6% 分散在多个分支上（联合归约、交叉规范化、替换类型、`SingleBaseAsync`），不是这一处。这一点差点导致一次错误的复杂改动：给 `Dictionary<TypeCacheKey, Type>` 接 `IAlternateEqualityComparer` 需要改动约 10 个字典创建点，收益却只有 0.3%。

**附带证伪：`RelationOperation` 每次顶层查询分配一个对象。** 实测 49,069 次（约 3.0 MiB，0.5%），且该对象持有可变状态（`Explanation`、`suppressed`），池化风险大于收益。

---

## 5. 巨文件不是关系引擎的有效负载

同一套探针在巨文件（398.4 MB）上的结果：

| 探针 | 巨文件 |
| --- | ---: |
| `relationRelated` | 7.80 MiB（2.0%） |
| `relationCompare` / `checkerRelated` | **0**（未进入比较本体） |
| `RelationKeys.CreateAsync` | 16,384 次 |
| `GenericAsync` 探测 / 泛型键构造 | 0 / 0 |

16,384 次键构造发生在顶层缓存探测处，之后就直接返回，从未进入会话与比较本体。巨文件的 32K 对象字面量由同形快路径（r10）与上下文类型直接检查处理。**结论：关系引擎的改动无法用巨文件验证收益，必须用真实工程负载。** 这一条对后续轮次的口径选择有直接影响。

---

## 6. 对下一步的判断

关系引擎占真实工程分配的 44.7%，但分布是弥散的：最大的具名子帧 13.3%，且是透传；能明确归因到"可避免的分配"的部分，最大也只有 2.6%（规范化帧），且其中每一处都小于 0.5%。前几轮能拿到的 2%~5% 来自"每调用一个容器"这类**结构性**缺陷，这里没有。

因此下一步若要动关系引擎，杠杆不在单次比较的成本，而在**比较次数**：

| 方向 | 说明 | 风险 |
| --- | --- | --- |
| 提高顶层结果缓存命中率 | 现在是按 (source, target, intersection) 的键缓存，键里不含泛型实参的约束状态之外的信息；命中率实测未知，需要先加计数器 | 缓存正确性依赖 `state.Reliability`，改动易引入错误结论 |
| 减少重复比较 | 同一对类型在同一个顶层查询里可能被多个路径重复比较（`WithoutErrorsAsync`/`CompareContinuingAsync` 会绕过部分缓存） | 需要先量化重复率 |
| 改到别处 | `objectLiteral`（99.9 MiB，16.7%）、`symbolTypesGet`（83.1 MiB，13.9%）、`variableType`（61.6 MiB）、`typeFromNode`（61.5 MiB）仍是未归因的大块 | 未知 |

建议下一轮先做**顶层缓存命中率与重复比较率**的计数（不需要改代码，只加计数器），再决定是否动缓存策略。

---

## 7. 工作树状态

本轮所有探针与计数器已全部移除，工作树回到 `1e1b09d7f4`，无未提交改动。本轮不产生代码提交。
