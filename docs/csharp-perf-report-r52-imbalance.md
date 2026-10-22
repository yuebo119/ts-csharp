# r52 报告：检查相位负载失衡普查（两条利用路径实测否决）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-22 ｜ 轮次: r52 ｜ 主题: check-partition-imbalance
> 触发: 用户令「按最优方案，修复发现的问题和缺陷」
> 关联: `docs/csharp-perf-report-r51-existence.md`（本轮起点，其 §8 点名「检查相位重新成为最大块」）
> 状态: 诊断轮，产品代码零改动。临时 `TSHARP_SPLIT2` 探针已回退，工作树等于 r51 发布态。

## 1. 结论

r51 之后检查相位的最大缺陷定位到了，但两条可利用路径都用数据否决，本轮不产出产品改动。

缺陷是**分区负载失衡**：静态权重对类型级成本失明，八分区实测总线程时间 2.231 s，墙钟 `checkPool` 0.582 s，利用率约 48%，约 0.2 s 是纯等待。失衡的源头是单个文件。

否决的两条路径：

| 路径 | 机制 | 实测 | 否决理由 |
| --- | --- | --- | --- |
| 提高 checker 数 | 分区变小，失衡自然缓解 | 会话 A 20 对均值比 0.936（CI [0.906, 0.966]，17/20 占优）；会话 B 6 对均值比 0.997 | **跨会话翻转**，环境依赖，不满足可复现证据 |
| 重开 L3-a 动态认领 | 空闲 checker 认领他人队列 | 未重测（前置条件仍未解） | 见 §5，且本轮独立证得空闲时间不在 Total 关键路径上 |

## 2. 失衡的量化

探针：`TSHARP_SPLIT2`（临时，每文件与每分区实测耗时归集，量后回退）。真实工程 291 文件，`--noEmit`，产品配置。

一次代表运行的 `--extendedDiagnostics`：

```
phase:partition:      1.646s (线程时间合计)
phase:checkPool:      0.401s (墙钟)
phase:partition#1:    0.401s   == checkPool，即关键分区
phase:partition#6:    0.264s
phase:partition#2:    0.229s
phase:partition#0:    0.190s
phase:partition#5:    0.153s
phase:partition#7:    0.138s
phase:partition#4:    0.136s
phase:partition#3:    0.135s
```

分区时间合计 1.646 s，八分区理想均值 0.206 s，关键分区 0.401 s，利用率 51%。另一会话读到合计 2.231 s、墙钟 0.582 s、理想 0.279 s、关键分区 0.582 s（利用率 48%）。两个会话的绝对水平差约 35%，但**利用率稳定在 48%~51%**，这是确定性结构信号，不随机器漂移。

空闲时间 0.19~0.30 s，占 Total（0.90~1.28 s）约 20%。

## 3. 失衡的源头：权重与成本方向相反

每文件 dump 的静态权重（`CheckerPartitions.ForProgram`：`NodeCount + Bytes/100`）与实测检查耗时：

| 文件 | 体积 | 静态权重 | 实测检查耗时 |
| --- | ---: | ---: | ---: |
| `src/api/proto.ts` | 4.5 KB | **510**（全程序最小值） | **253~442 ms** |
| `src/api/sync/api.ts` | 315 KB | 41,057 | 233~291 ms |
| `src/ast/is.generated.ts` | 129 KB | 20,725 | 129~177 ms |

`proto.ts` 的权重在全程序 291 个文件里最低，检查成本却占关键分区约 63%。权重与成本在这个文件上方向相反，不是低估 70 倍（r39 口径），而是排序反转。

`proto.ts` 的全部成本落在一个结构上。定为 DSL 标签的语句级计时（filter=proto.ts）：

```
mech   435.0ms  calls=12   stmt:266      // TypeAliasDeclaration
mech     2.0ms  calls=3    stmt:263
mech     0.2ms  calls=1    s:tail
mech     0.0ms  calls=1    s:deferred
```

12 个类型别名声明吃掉 435.0 ms（每个 36.3 ms），同文件其他语句合计不超过 2.5 ms。文件内具名帧只解释其中一部分：

```
mech    81.4ms  calls=586      addUnionTypes
mech    71.6ms  calls=21572    instantiate
mech    31.1ms  calls=318036   symbolTypesGet
mech    20.0ms  calls=1102     conditionalInstantiate
mech     9.4ms  calls=2038     relationRelated
mech     8.1ms  calls=734      typeFromNode
mech     5.8ms  calls=454      resolveMembers
```

`symbolTypesGet` 318,036 次除以 12 个别名得 26,503 次每个别名，等于 `keyof APIMethodInfo` 的成员数（29,642）。即每个别名对同一批联合成员各做一次符号类型查询。

读该文件源码可见 12 个别名的构成：1 个泛型 `APIMethodsReturning<T>`，6 个非泛型实例化（`SourceFileResponse`、`SymbolResponse`、`SymbolResponse[]`、`SignatureResponse`、`TypeResponse`、`TypeResponse[]`），1 个 `Exclude<keyof APIMethodInfo, "batchRequests">`，1 个 `{[K in BatchableAPIMethod]: ...}[BatchableAPIMethod]`。其中约 8 个各自完整扫一遍 29,642 成员。

## 4. 路径 A：提高 checker 数（否决）

`checkerCount` 是现成选项。Go 参考实现 `tsc/internal/compiler/checkerpool.go` 的默认值是固定 **4**：

```go
checkerCount := 4
if program.SingleThreaded() { checkerCount = 1 } else if c := program.Options().Checkers; c != nil { checkerCount = *c }
```

本仓已偏离到 `Math.Clamp(Environment.ProcessorCount / 4, 4, 8)`（本机 32 核取 8），注释记录的理由是 16 核主机上吞吐在 8 处见底。

`checkPool` 随 checker 数单调下降，确定性可观：

| checkers | checkPool | 分区线程时间合计 |
| ---: | ---: | ---: |
| 8 | 0.489~0.729 s | 1.65~2.23 s |
| 20 | 0.378~0.436 s | 2.97 s |

但端到端读数跨会话翻转：

| 会话 | 采样 | 配对均值比（20/8） | 占比优势 | 备注 |
| --- | --- | ---: | ---: | --- |
| A | 20 对交替双向 | **0.936**，CI [0.906, 0.966] | 17/20 | 绝对值 0.77~1.09 s |
| B | 6 对交替双向 | **0.997** | 4/6（含两个 1.20+ 反例） | 绝对值 0.89~1.32 s，整体上浮 |

会话 A 的 20 对区间排除 1.0，会话 B 的同会话配对没有效应。两会话绝对水平相差约 30%。按 `docs/csharp-perf-method.md` 的机器漂移口径，这只能给出比值区间，而区间跨过 1.0。

代价侧：CLR 分配字节 764.0~764.3 MB（8）→ 809.9~810.4 MB（20），**+6.0%**；峰值工作集 833.3/820.0 MB（会话 A）、910~936 MB（会话 B），无系统性差异。

**否决**。收益跨会话不可复现，代价是确定性 +6% 分配，且会把默认值从参考实现的 4 推得更远，并让已发布基线全部失效。按仓内「<5% 默认不做」与「测量类断言禁进程级全局态」两条纪律，不立项。

## 5. 路径 B：重开 L3-a 动态认领（维持关闭）

r39-L3-a 的三个重开前置条件现状：

1. **让 emit 不依赖属主计数均衡**：未动。其记录的对内差是动态 emit 尾部比静态多 44%（187 vs 130 ms），逻辑是每文件借池在属主数偏斜后同属主连续段串行化。
2. **找到类型级成本的静态可预测特征**：本轮再次证伪。dump 出的静态权重显示 `proto.ts` 是全程序权重最小值（510，占总权重不到 0.05%），成本却占关键分区 63%。节点、字节、导入三族之外，本轮试了「类型级节点密度」一族（`proto.ts` 465 个节点且几乎全是类型节点），绝对量仍远低于 315 KB 的 `sync/api.ts`（权重 41,057），无法把 `proto.ts` 判成最重文件。
3. **接受只在 noEmit 场景收益**：证据不足。

本轮新增一条**独立否证**：路径 A 是同一份空闲时间的另一种收割方式，且不承担 emit 尾部代价与跨文件诊断语义风险。路径 A 把 checkPool 确定性压低 0.13~0.29 s，Total 只动 0.06~0.11 s（会话 A）。也就是说这 0.2 s 空闲**不在 Total 的关键路径上**，checkPool 的节省被未变动相位与阶段重叠吸收。L3-a 当年「113 ms 检查收益被 emit 尾部吃光」的结论由此得到同向佐证，且不依赖 emit 侧的复测。

结论：**维持关闭**。

## 6. 路径 C：压低 proto.ts 自身成本（本轮不立项）

`proto.ts` 是必要工作而非重复劳动，三条证据：

1. 8 次全量扫描各自产出不同的方法名联合（`APIMethodsReturning<SourceFileResponse>`、`<SymbolResponse>`、`<SymbolResponse[]>`、`<SignatureResponse>`、`<TypeResponse>`、`<TypeResponse[]>`、`Exclude<keyof APIMethodInfo, "batchRequests">`、`APIRequest`），不存在可合并的同一结果。
2. 每别名 26,503 次符号类型查询已被缓存（`symbolTypesGet` 单次 0.1 µs），共享的是 `APIMethodInfo[K]` 的属性类型解析，且已经在共享。
3. 具名帧只解释 437 ms 中的约 150 ms，其余落在对 29,642 成员逐个求值的循环体内，每成员约 0.9 µs 的模板实例化与条件求值。

这与 r43 的六项关闭清单同源：本仓检查相位是必要工作的常数问题。要动它必须走表示层（跨 29,642 成员循环的每成员常数），属 r35 W3 家族，不是本轮目标。

## 7. 复现口径与已知边界

- 探针 `TSHARP_SPLIT2`（每文件 `checkFileTotal`、每分区耗时、每语句 kind 计时），`TSHARP_FILE_FILTER` 限定单文件，全部已回退。
- 分区线程时间合计是确定性量；`Total` 与 `checkPool` 墙钟跨会话漂移 ±30%，本报告所有占比结论只基于前者。
- 峰值工作集用 `Start-Process -PassThru` 后轮询 `WorkingSet64`（10 ms 间隔）采样最大值，非精确峰值。
- 每次运行前删除夹具根的 `tsconfig.tsbuildinfo` 与 `tsconfig.enums.tsbuildinfo`（r44/r45 实测的污染陷阱）。

## 8. 剩余空间

检查相位最大块仍是关系引擎族（`relationCompare` 线程时间 1.2~1.5 s，占检查线程时间约 69%），受 r27 表 3 约束。EventPipe 对本机 AOT 二进制仍挂接不通（`dotnet-counters ps` 列表里没有 AOT 进程），布局扰动归因这条前置条件未解。

本轮之后，已知未保护的性能面只剩 L4（lib 预绑定），属架构级改动。