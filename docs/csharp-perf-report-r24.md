# r24 报告：R 层同步化重写的定价（substrate 实测），分配收益为零、墙钟上界约 1%

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-10 ｜ 轮次: r24 ｜ 主题: r-layer-pricing
> 涉及 git 节点: `dcf8c58150`（r23，工作树基线）/ 本轮无产品源码改动，只有测量与文档
> 数据来源: substrate 基准（NativeAOT + runtime-async=on + OptimizationPreference=Speed + ServerGC/并发关，与产品同配置；窄/宽状态机两条链各 7 轮 × 200 万次）；真实工程探针调用计数（r23 产品，2,007 s 检查阶段）；AB105~AB108 既有墙钟结论
> 关联: `docs/csharp-perf-plan-r22.md`（R 层与 5~15% 预期）、`docs/csharp-perf-report-r23.md`（守卫零触发）

---

## 0. 结论

用户授权投入 1~2 月做 R 层全量同步化重写（收益未经证实）。在动工之前，我把"异步机制到底多少钱"这一个未知量用 substrate 基准测了出来。结论是**方案的 R 层前提在分配与墙钟两个方向都不成立**：

| 项 | 方案的预期 | 实测 | 差距 |
| --- | --- | --- | --- |
| 分配（状态机消失） | −100~200 MB | **0 B**（异步状态机实测零分配） | 完全不成立 |
| 墙钟（回收 runtime-async 残余税） | 5~15% 重负载 | 每帧 2.0~2.3 ns × 异步调用数；热帧计数得 **0.22%**，任何可信的外推都落在 **1~2%** 以内 | 差 3~10 倍 |
| await 本身 | 隐含成本 | 1.30 ns/次，**比同步等价（1.74 ns）还便宜** | 不存在 |
| 154 处 guard 序言 | 隐含成本 | 0.22 ns/次，874,660 次合计 0.19 ms | 不存在 |

一句话：**async 的税在 .NET 11 的 runtime-async 里已经被运行时自己收走了**。本项目已经打开 runtime-async（r20 审计确认），所以 R 层能回收的只剩残余的每调用约 2 ns 状态机建立成本，而不是方案假设的那一整套。方案 5~15% 的数字更像是经典异步时代（或 Go 同步 substrate）的估算。

---

## 1. 测量方法与原始读数

基准源码在 harness 工作区 `C:\ai\projects\tsbench\async-toll\`（`Program.cs` + 复刻 `csharp/Directory.Build.props` 的 csproj），`dotnet publish -c Release -r win-x64` AOT 发布后直接运行。两条链体相同、逐帧 `[MethodImpl(NoInlining)]`（真实检查器的方法都很大，不会被内联）：

```
depth=8 iterations=2000000 rounds=7
narrow sync chain (9 calls):   17.6 ns/call  (1.96 ns per frame)
narrow async chain (9 calls):  37.9 ns/call  (4.22 ns per frame)
async method with no await:       5.80 ns/call
wide sync chain (9 calls):     50.9 ns/call  (5.65 ns per frame)
wide async chain (9 calls):    67.4 ns/call  (7.49 ns per frame)

delta per narrow frame with an await: 2.26 ns
delta per wide frame with an await:   1.84 ns
delta of the async shape alone:       5.80 ns/call

await Task.CompletedTask.ConfigureAwait(false): 0.22 ns each
await <completed ValueTask>.ConfigureAwait(false): 1.30 ns each (sync equivalent 1.74 ns)

alloc narrow sync:  0.00 B/outer call
alloc narrow async: 0.00 B/outer call  -> 0.00 B per async frame
alloc wide async:   0.00 B/outer call  -> 0.00 B per async frame
```

三条读数：

1. **每帧 async 税约 2 ns，且不随状态机尺寸增长**（宽状态机 1.84 ns，窄 2.26 ns）。它是每次异步调用固定的状态机建立/拆除成本。
2. **异步状态机分配 0 字节**（窄、宽都测到 0.00 B）。运行时在同步完成时不把状态机放到堆上。这一条直接否定 R 的分配预期：`symbolTypesGet` 那 32.8 MB、`relRecurse` 那 39.9 MB 里没有一分钱是异步机制。
3. **await 与 guard 都不是成本**。等一个已完成的 `ValueTask` 是 1.30 ns，比"同步等价"（1.74 ns，即直接调用并读结果）还便宜；guard 序言是 0.22 ns。154 个 guard 站点在一次真实工程检查里被调用 874,660 次，合计 0.19 ms，占 2,007 s 检查阶段的 0.009%。

---

## 2. 从 substrate 到 R 的墙钟上界

R 的墙钟收益 = 每帧 2 ns × 一次检查里的异步调用次数 N。N 有一个可测的下界：独占分配探针里所有**被探针覆盖的方法调用次数之和**（这些方法正是按分配量挑出来的热帧）。

| 探针帧 | 调用次数 |
| --- | ---: |
| symbolTypesGet | 710,014 |
| relationRelated | 295,141 |
| propertyLookup | 284,135 |
| relationCompare | 123,977 |
| relKeys | 77,529 |
| relWeak | 73,039 |
| typeFromNode | 72,380 |
| relIdentical | 68,571 |
| membersTable | 68,056 |
| relRecurse | 63,891 |
| setMembers | 60,972 |
| 其余 19 帧 | 合计 ~180,000 |
| **合计** | **2,220,665** |

真实工程检查阶段（8 checker，summed）2.007 s。于是：

| 假设的 N | 异步税 | 占检查阶段 |
| --- | ---: | ---: |
| 2.22 M（探针下界，热帧即全部） | 4.4~5.1 ms | **0.22~0.25%** |
| 10 M（探针的 4.5 倍） | 20~23 ms | ~1.0% |
| 49 M | 98~113 ms | ~5% （方案下限） |
| 147 M | 294~338 ms | ~15% （方案上限） |

要触到方案的 5%，一次检查需要约 4,900 万次异步调用，即探针热帧计数的 **22 倍**；要触到 15% 需要 66 倍。判断：这些探针是按分配量挑出的最热帧（分配量与工作量正相关），未探针的异步方法要撑起 22~66 倍的调用量，只能是那些又便宜又不分配的小方法。这种可能性不能从计数上排除，但它要求"绝大多数异步调用发生在既不分配也不热的角落里"，与 r14/r21/r23 三轮分配归因的全貌（分配集中在这些帧上）不一致。

**诚实的边界**：N 的精确值没有测到，因为这台机器上的 .NET 11 RC 无法用 EventPipe 采样（`dotnet-trace collect` 启动即超时，与 r21 记录的分配采样失败同源），而给 2,181 个方法逐一计数的工作量等于重写本身。所以"墙钟 0.2~2%"是**上界性质的推断**，不是测得的墙钟。

---

## 3. 这对 R 层的含义

把 r21~r24 四轮的证据放在一起：

| 轮次 | 结论 |
| --- | --- |
| r21 | 分配侧边际收益衰减到 3.5%，建议"若仍是个位数百分比则分配侧收工" |
| r22 | `checkerRelated` 的 42 MiB 是递归调度本体，不是可修缺陷 |
| r23 | 栈守卫 874,660 次调用零触发；调度本体自有分配 4.9 MB（0.59%） |
| r24 | 异步状态机**零分配**；每帧 async 税 2 ns；R 的墙钟上界约 1~2% |

R 层是方案里唯一 >5% 的墙钟杠杆，而它的两条依据（状态机分配消失、runtime-async 残余税 5~15%）现在都被实测否掉：前者是 0，后者是每调用 2 ns 的残余，且 await 与 guard 分别比同步等价更便宜、近乎免费。

**建议**：不在这个证据基础上投入 1~2 月。理由不是"重写太难"，而是**要回收的那笔钱已经被 runtime-async 提前收走了**——r19 测到经典异步比 runtime-async 慢 16~41%，那 16~41% 正是异步税的大头，本项目已经在 r20 之前就完成了这次切换。R 层现在能动的是残余。

**什么会改变这个判断**：一个 `N` 的实测值。如果某轮把一次真实工程检查的异步调用总数测出来落在 2,000 万以上，R 的墙钟预期就回到 2% 以上，值得重新评估；低于 1,000 万则 R 的收益不足以覆盖全量重写的正确性风险。测 N 的最省力路径是给 `Checker` 的少数几个通用入口（表达式检查、类型求值、成员解析、关系入口）加计数，用四五个入口的调用量外推，而不是给 2,181 个方法逐一插桩。

---

## 4. 本轮产物

- 无产品源码改动（本轮是定价轮，r13/r14/r15 同类先例）。
- 基准与读数：`C:\ai\projects\tsbench\async-toll\`（harness 工作区，非本仓库）。
- 结论已回写 `docs/csharp-perf-plan-r22.md` 的 R 层段落（见下）。
- 若用户仍决定投入 R，本报告第 1 节的四条读数应作为动工前的基线（特别是"分配收益为零"，意味着 R 不能用分配作为中间验收指标，只能等全量转完看墙钟）。
