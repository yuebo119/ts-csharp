# r46 报告：r45 之后的候选普查（六项否决）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-21 ｜ 轮次: r46 ｜ 主题: post-r45-candidate-census
> 触发: 用户令「继续」，接续 r45 已发布的 union 双段归并
> 关联: `docs/csharp-perf-report-r45-merge.md`（已发布优化）、`docs/csharp-perf-report-r43-sortpair.md`、`.ai/perf-ledger.md`
> 状态: 全部否决，产品代码零改动。r45 的实现保持为最新发布态。

## 1. 结论

r45 之后普查了六个候选，全部被数据否决。这说明 r45 的双段归并已经把 union 路径上的主要确定性收益拿走了，剩下的候选要么规模低于噪声，要么风险不成比例。

| 候选 | 否决依据 | 规模 |
| --- | --- | --- |
| `Compare` 的 SortFlags 快路径 | flags 不同的比例仅 8.8%（57,308 / 653,744） | 低于噪声 |
| `CompareNodes` 的 parent 链遍历 | 915,502 次调用、平均链深 6.70、最深 21 | 省下的链遍历低于 1.1% |
| 2 元合并的短段二分（tsrs `merge_sorted_types`） | 长段均值仅 7.5、短段 1.2，符合条件 244 次 | 长段总长 11,316，规模太小 |
| `NamedUnions` 容器复用 | 1,156 次调用，整块分配 3.6 MB | 占全工程 0.45% |
| `AddUnionTypes` 缓冲池化 | 分配 47.7 MB（占 6.0%），但 `UnionAsync` 在 `RemoveSubtypes` 里递归（`TypeAlgebra.cs:374`） | 实例字段缓冲会被嵌套调用覆盖，不安全 |
| `CompareLiteralValues` / `CompareText` 加速 | 已是 `SequenceCompareTo`（向量化），无可压缩常数 | 无空间 |

## 2. 每项的测量方法

全部用临时探针，量后 `git restore` 回退，产品代码零改动。

### 2.1 SortFlags 快路径

在 `Compare` 入口加 `SortFlags(left) != SortFlags(right)` 判定，统计能直接分出的比例。真实工程 291 文件、`--noEmit`：

```
FLAGPROBE calls=653744 flagDecided=57308 nullSide=0 literalFast=25268
```

8.8% 的比较能在 flags 层分出，其余 91.2% 仍需进 `CompareCore` 的显式栈。省下的只是这 8.8% 的取栈与三次 push，低于测量分辨率。

顺带确认 `nullSide=0`，即所有调用两侧都非空，`CompareCore` 里的 null 分支是死代码（但保留无害）。

### 2.2 CompareNodes 的 parent 链

```
NODEPROBE calls=915502 sameFile=747756 avgDepth=6.70 maxDepth=21 nullRoot=0
```

915,502 次调用，每次沿 parent 链走 6.7 层求 SourceFile，累计约 614 万次指针跳转。81.7% 的两节点同文件。

理论上可以缓存节点的 SourceFile，但 `SyntaxNode` 没有该字段，加字段会改变对象布局（r27 记录的布局敏感先例）。链遍历本身是 6.7 次指针跳转，在 AOT 下约 10 ns，总耗时约 6 ms，端到端 0.5%，低于噪声。

### 2.3 2 元合并的短段二分

tsrs 的 `merge_sorted_types`（`checker_13.rs:1706`）在 `short * bitWidth(long) * 2 < long` 时改用二分插入，把比较次数从 n+m 降到 m log n。

本仓 `AddUnionTypes` 的 2 元快路径实测：

```
MERGEPROBE calls=2185 avgLong=7.5 avgShort=1.2 eligible=244 eligibleLongTotal=11316
```

平均长段只有 7.5 个成员。n+m=8.7 与 m log n ≈ 1.2 × 3 ≈ 3.6 的差别只有 5 次比较，乘以 244 次符合条件的调用，总计约 1,200 次比较，占 657,045 的 0.2%。规模太小。

tsrs 的优化针对「小 union 并入大 union」（大 union 几百个成员），本仓的 2 元合并场景里长段平均只有 7.5，前提不成立。

### 2.4 NamedUnions 容器复用

`NamedUnions` 每次调用分配 `List`、`HashSet`、`Stack` 三个容器，调用点还额外分配 `SelectMany`、`HashSet`、`Where().ToList()`。整块实测：

```
NAMEDPROBE calls=1156 avgInput=17.1 avgResult=1.5 allocatedKB=3579
```

3.6 MB，占全工程 790.6 MB 的 0.45%。平均结果只有 1.5 个 named union，输入 17.1。容器开销相对 3.6 MB 只是零头。

### 2.5 AddUnionTypes 缓冲池化

这是唯一有量级的分配靶点：

```
ALLOCSPLIT calls=31420 allocatedKB=47702 avgBytes=1554.7
```

47.7 MB，占 6.0%。平均每次 1,554 字节，主要是 `new List<Type>(source.Count)` 的数组。

但池化不安全。`UnionAsync` 在 `RemoveSubtypes` 内部递归调用自己（`TypeAlgebra.cs:374`，`RemoveSubtypes` 对每个候选源与其余成员的 union 做子类型判定），嵌套的 `AddUnionTypes` 会覆盖外层正在使用的实例缓冲。

可行的替代是用 `ArrayPool` 加显式归还，但 `set` 被 `RemoveAt`、`Where`、`BinarySearch`、`RemoveRange` 等多处使用（`TypeAlgebra.cs:90-146`），改成池化数组需要重写整个 `UnionWorker`，风险与 47.7 MB 的收益不成比例。且这 47.7 MB 里大部分是 `GetUnionFromSortedTypes` 内部化时的必要拷贝，不全是浪费。

### 2.6 比较器常数

`CompareLiteralValues` 的字符串分支走 `CompareText` → `ReadOnlySpan<byte>.SequenceCompareTo`，.NET 已用向量化实现。`SortFlags` 是两次位运算。没有可压缩的常数。

## 3. 本轮顺带确认的事实

**tsrs 的 key-property 快路径本仓已有。** tsrs 的 Row 1（`typeRelatedToSomeType`，占 big 8.9%）用「key-property 匹配优先」加速 union 目标的关系比较。本仓对应实现在 `DiscriminantRelations.cs:54-83`，`KeyPropertyName` 缓存已存在，机制同构。

**tsrs 的 `mem-checker-scratch` 结论与本仓一致。** 该笔记检查了每 checker 的垃圾、空闲表与哈希表 slack，结论是「没有一项超过 5% 峰值门槛」。本仓的分配分布（关系引擎族 305+286+259+252 MB 占前四）也在同一量级，且受 r27 表3 约束。

**r45 后的分配分布。** `--extendedDiagnostics` 的前十二项：

| 探针 | 分配（MB） |
| --- | ---: |
| relationCompare | 305.7 |
| checkerRelated | 286.6 |
| relRecurse | 259.6 |
| recStamp | 252.5 |
| relationRelated | 134.4 |
| resolveMembers | 125.0 |
| symbolTypesGet | 109.7 |
| relationProperties | 104.7 |
| typeFromNode | 72.0 |
| variableType | 70.4 |
| objectLiteral | 46.2 |
| objectMutable | 38.7 |

前四项全是关系引擎，受表3 勿重开约束。`resolveMembers` 125 MB 与 `symbolTypesGet` 109.7 MB 是关系族之外的两项，但 r39-L1 已仲裁它们的可共享面为零（×1.09 / ×1.46~2.58 斜率对应所有权契约钉死）。

## 4. 时间分布（r45 后）

| 探针 | 时间 |
| --- | ---: |
| relationCompare | 1.833 s |
| relRecurse | 1.622 s |
| recStamp | 1.024 s |
| relationProperties | 0.622 s |
| relationRelated | 0.608 s |
| resolveMembers | 0.477 s |
| symbolTypesGet | 0.442 s |
| typeFromNode | 0.231 s |
| variableType | 0.273 s |

关系族合计约 5.7 s 线程时间（多 checker 求和），占绝对主导。这些是 r27 表3 明确「勿重开」的区域：任何触碰关系调用链的改动会引入布局扰动，r27 实测 +2.27~3.04%。

## 5. 为什么本轮没有新产品改动

r45 的双段归并已经把 `AddUnionTypes` 的比较次数降了 16.0%。剩下的候选分三类：

1. **规模低于噪声**（flags 8.8%、CompareNodes 链遍历、2 元短段二分 0.2%、NamedUnions 0.45%）；
2. **不安全**（AddUnionTypes 池化受递归阻碍）；
3. **禁区**（关系引擎族，表3 勿重开）。

这不是「没有优化空间」，而是「剩下的空间在当前测量分辨率与既有约束下不可兑现」。r46 的产出是把这条边界画清楚，避免后续重复提案。

## 6. 产物

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 六个探针 | 全部 `git restore` 回退 | 不入库 |
| 产品代码 | `git status` 干净，`dotnet build csharp/TypeScript.slnx -c Release` 0 警告 0 错误 | 零改动 |
| r45 发布态 | `built/r44h-ship/`，逐字节对 `pre` 全等 | 有效 |

## 7. 下一步

要在检查相位继续取得收益，需要先解决两个前置之一：

1. **关系引擎的布局扰动归因**。r27 记录 EventPipe 在本机 .NET 11 RC 不可用，导致无法定位 +2.27~3.04% 的来源。若能定位，关系族 5.7 s 的线程时间才有优化空间。
2. **更高分辨率的测量环境**。本机同二进制配对控制组 CI 宽 ±5~10%，1.1% 分辨率的改动无法验证。端到端收益 4% 以下的改动在本机一律不可测。

两者都是环境或工具层面的前置，不是代码层面的优化机会。
