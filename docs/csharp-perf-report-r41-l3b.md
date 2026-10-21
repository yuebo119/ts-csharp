# r41 报告：proto.ts 单点热点归因（L3-b）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-21 ｜ 轮次: r41 ｜ 主题: l3b-proto-attribution
> 触发: 用户令「继续」；接续 r40 关闭 tsrs 缓存线后账本待勘仅剩 L3-b 与 L4
> 关联: `docs/csharp-perf-report-r39-l3a.md`（静态权重模型证伪）、`docs/csharp-perf-report-r40-probes.md`、`.ai/perf-ledger.md`
> 状态: 测量完成并回退。产品代码零改动，探针补丁不入库。

## 1. 结论摘要

proto.ts 的约 400 ms 集中在单个类型别名上：`APIResponse`（源偏移 1647）。它占该文件检查时间的 93%，其余 20 个顶层语句合计 25 ms。

这个别名的成本可拆成两段，归属明确：

| 阶段 | 耗时 | 占比 |
| --- | ---: | ---: |
| `UnionAsync` 总计 | 201.8 ms | 49% |
| 其中 `AddUnionTypes`（合并 + 排序） | 196.4 ms | 48% |
| 其中 `RemoveSubtypes`（子类型消除） | 0.6 ms | 0.1% |
| `InstantiateAsync` | 62.6 ms | 15% |
| 条件类型实例化 | 18.1 ms | 4% |
| 其余（关系比较、符号类型、属性表等探针已覆盖项） | 约 120 ms | 29% |

关键否定结论：**大 union 的重复率只有 2.8%**（177 次调用、172 个不同输入）。结果缓存、front cache 在这一层面都无效，这与 r40 的 union 原型结论互相印证。

## 2. 测量方法

临时探针 `TSHARP_FILE_PROBE`（`/tmp/l3b-probe.patch`，量后 `git restore` 回退），三类打点：

1. **逐顶层语句**：`CheckSourceFileAsync` 里对每条 statement 计时并记录 `TypeCount` 增量。
2. **机制计时**：在 `UnionAsync`、`TypeInstantiation.InstantiateAsync`、`ConditionalTypes.InstantiateAsync`、`MappedTypes.InstantiateAsync`、`TypeKeys.GetAsync` 入口加配对计时。
3. **union 内部分段**：在 `AddUnionTypes` 与 `RemoveSubtypes` 两侧分别计时，并按输入个数分桶。

夹具为真实工程（291 文件图，`/c/ai/projects/tsbench/r38/alloc/fixtures/real`），`--noEmit`，产品配置，每次运行前删除 `tsconfig.tsbuildinfo` 与 `tsconfig.enums.tsbuildinfo`。

## 3. 逐语句结果

| 偏移 | 语句 | 耗时 | 新建类型 |
| ---: | --- | ---: | ---: |
| 1647 | `APIResponse` | 413.7 ms | 29,642 |
| 479 | 类型别名 | 5.4 ms | 858 |
| 2015 | 类型别名 | 6.2 ms | 20 |
| 1517 | 类型别名 | 5.6 ms | 165 |
| 704 | 类型别名 | 5.0 ms | 163 |
| 其余 16 条 | 别名、函数、接口、导入、导出 | 合计 7.3 ms | 少量 |

单条语句新建 29,642 个类型，占该文件类型增量的绝大部分。这个数字本身就是成本信号：不是计算慢，是构造量太大。

`APIResponse` 的定义是：

```ts
export type APIResponse<Request extends APIRequest = APIRequest> = Request extends APIRequest ?
        & { method: Request["method"]; }
        & ({ result: APIMethodInfo[Request["method"]]["result"]; error?: undefined; }
           | { result: null; error: string; })
    : never;
```

`APIRequest` 由 `{ [K in BatchableAPIMethod]: ... }[BatchableAPIMethod]` 得到，`BatchableAPIMethod = Exclude<keyof APIMethodInfo, "batchRequests">`。于是 `APIResponse` 的分发把 `APIRequest`（约 176 个成员）拆成 176 个分支逐一求值，每个分支再实例化交叉类型与联合。

## 4. 机制分解

```
union              201.8ms  calls=636
  unionAdd         196.4ms  calls=586   ← 主因
  unionRemoveSubtypes 0.6ms calls=7
instantiate         62.6ms  calls=21572
conditionalInstantiate 18.1ms calls=1102
keyof                2.1ms  calls=495
mappedInstantiate    0.0ms  calls=3
```

union 按输入规模分桶：

| 输入个数 | 调用 | 耗时 |
| --- | ---: | ---: |
| 129~512 | 176 | 200.0 ms |
| 2 | 451 | 1.2 ms |
| 33~128 | 3 | 0.1 ms |
| 其余 | 6 | 0.4 ms |

大 union 的输入去重：177 次调用，172 个不同输入，重复率 2.8%。

条件类型实例化的缓存命中数为 0（`conditionalMiss=1102`，`conditionalHit` 未出现）。这是命中面为零，不是缓存失效：这 1102 次调用各自对应不同的 `values` 组合，没有可复用的先例。

## 5. 成本为什么在这里

`AddUnionTypes` 对每个输入做一次有序合并，并在一般路径上调用 `order.Compare` 排序。176 个分支各构造一个约 176 成员的 union，每次都要把成员排序并去重，于是成本大致按 `分支数 × 成员数 × log(成员数)` 增长。这正是 AGENTS.md 要求显式质询的 `O(n×m)` 形态。

`RemoveSubtypes` 只被调用 7 次、耗时 0.6 ms，说明瓶颈不在关系比较。r39-L3a 记录的关系族占比（relationCompare 51 ms、checkerRelated 49 ms、relRecurse 37 ms）在本次分解中仍可见，但总量不到 union 的一半。

`instantiate` 的 62.6 ms / 21,572 次调用，平均每次 2.9 µs，是正常的实例化常数开销，不是异常热点。

## 6. 对已有结论的修正

r39-L3a 曾用静态权重模型估算 proto.ts，得出权重占 0.33%、实际成本占 23.2% 的 70 倍偏差。本轮给出了偏差的具体形态：成本不在节点数或字节数上，而在**单个别名触发的分发展开**上。静态特征看不见这种展开。

r40 关闭 union front cache 时给出的理由是「残余重复调用均值 0.85 µs，命中路径开销吃平收益」。本轮进一步补上原因：真正耗时的 union 调用（大 N）重复率仅 2.8%，缓存对它没有命中面；而重复率高的那些调用（N=2，451 次）本来就便宜。两条结论一致。

## 7. 可选下一步（未实施）

按收益与风险排序，列三项候选，均需单独立项与门槛：

| 候选 | 机制 | 预期 | 前置风险 |
| --- | --- | --- | --- |
| 分发批量化 | `APIResponse` 这类分发在同一次实例化中对同一 union 的每个成员求值时，共享一次排序结果，避免 176 次独立 `AddUnionTypes` | 若命中，可覆盖 196 ms 的主要部分 | 需证明各分支构造的 union 输入集合共享同一排序基准；关系调用链改动需过 r27 隔离批次 |
| `AddUnionTypes` 快路径 | 输入已有序时跳过排序（当前 `source.Count == 2` 已有合并快路径，N≥3 无） | 排序占比未知，需二次探针 | 排序正确性是语义的一部分，改动需逐字节门禁 |
| 类型构造预算门禁 | 单语句 `ΔTypeCount` 超过阈值时告警，用于防止同类退化 | 不直接提性能，防回归 | 阈值需标定，噪声大 |

三项都不在本轮范围内。第一项的探针成本约半天：在 `UnionAsync` 里记录「同一调用栈内相同输入集合」的出现率，即可判定是否有共享排序的空间。

## 8. 产物

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 探针补丁 | `/tmp/l3b-probe.patch`（244 行） | 临时，不入库 |
| 探针源文件 | `/tmp/FileProbe.cs` | 临时，不入库 |
| 原始输出 | `/tmp/l3b-split.err`、`/tmp/l3b-rep.err`、`/tmp/l3b-mech6.err` 等 | 临时 |
| 产品代码 | `git status` 干净，`dotnet build csharp/TypeScript.slnx -c Release` 0 警告 0 错误 | 零改动 |
