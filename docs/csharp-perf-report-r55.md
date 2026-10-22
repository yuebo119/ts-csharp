# r55 报告：Program 相位归因（解析主导，两条利用路径否决）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-22 ｜ 轮次: r55 ｜ 主题: program-phase
> 触发: 用户令「继续按最优方案优化」；r54 之后各轴状态：emit 已到结构上限、检查相位受 r27 表 3 约束、启动为环境性，Program（0.17s / 17%）是唯一未拆到行级的大块。
> 关联: `docs/csharp-perf-report-r54.md`（相位级配对方法）、`docs/csharp-perf-report-r51-existence.md`（解析存在性缓存，起点）、`docs/csharp-perf-report-r49-bottleneck.md`（Program 首轮拆解，r50 前口径）
> 状态: 诊断轮，产品代码零改动。临时探针（`phase:r55*` 与 `TSHARP_RESOLVE_CONCURRENCY`）量后全部回退。

## 1. 结论

Program 相位的构成量清了，结论是**它已被模块解析主导，且两条最自然的利用路径都不成立**。

1. **串行发布循环不是瓶颈**（推翻 r53 §10 的推测）：roots 趟（`LoadPending`）占 Program 92%，而 roots 趟内 99% 是 `await entry.Prepared`（0.137~0.169s 对墙钟 0.138~0.171s），串行应用部分只有约 2ms。
2. **模块解析是 Program 最大项**：resolve 求和在安静批 0.137~0.367s（典型 0.31s），是 parse+bind 求和（0.135~0.161s）的 **2.3 倍**，约占 Program 墙钟的一半，即 Total 的 8~9%。
3. **加解析并发无效**（否决）：parse 固定 4、只把 resolve 槽位提到 8/16，resolve 求和反而涨到 0.50/0.70s（并发下工作量自涨），Program 墙钟无改善。整体把 parse+resolve 一起提到 8/12 同样无效（Program 0.145 / 0.149 / 0.159）。
4. **解析成本是弥散的**：`ModuleAsync` 本体 ≈ resolve，`NodeModulesAsync` 只占 8~20%，`RealPath` 占 4~6%，其余散在逐候选路径构造（`RelativeLoad`/`LoadFile`/`AddExtensions` 的候选拼接与存在性探测）与 `Trace`/`Message` 的即时参数上。与 r43「检查相位是必要工作的常数问题」、r53「emit 调度轴 ≤3%」同族。

**处置：产品代码零改动，Program 轴关闭**（无单点、余量 <5%、且低于本机端到端分辨率）。

## 2. Program 的构成

真实工程（291 文件图），full 模式，`--extendedDiagnostics`。安静批的两次代表运行：

| 量 | run A | run B |
| --- | ---: | ---: |
| Program time | 0.085 s | 0.159 s |
| Parse summed | 0.085 s | 0.091 s |
| Bind summed | 0.051 s | 0.054 s |
| `phase:r55Roots`（roots 趟墙钟） | — | 0.179 s |
| `phase:r55Await`（等 Prepared 合计） | — | 0.177 s |
| `phase:r55Drain`（把已知文件全部入队） | 0.001 s | 0.002 s |
| `phase:r55Libs`（lib 趟墙钟） | 0.000 s | 0.001 s |
| `phase:r55Read`（读文件+解码） | 0.050 s | 0.054 s |
| `phase:r55Scope`（package.json scope） | 0.013 s | 0.014 s |
| `phase:r55ParseBind`（含等解析槽） | 2.78 s | 3.15 s |
| `phase:r55Resolve`（解析槽内全部工作） | 0.14~0.42 s | 0.35~0.45 s |

读法：
- `r55ParseBind` 的 2.8~3.2s 里绝大部分是**等待解析槽**（parse+bind 本身求和只有 0.14s），说明初始 113 个 roots 一次性入队后槽位就饱和了。
- 槽内真实工作：parse+bind 0.14 + 读 0.05 + scope 0.014 ≈ 0.20s，除以 4 槽 ≈ 50ms。
- resolve 0.31s（典型），除以 4 槽 ≈ 78ms。两者相加约 128ms，与 Program 的 0.145s 中位吻合。

## 3. 两条假设的否决

### 3.1 串行发布/应用循环（否）

`phase:r55Roots`（0.171~0.179s）减去 `phase:r55Await`（0.169~0.177s）只有 **2ms**，即发布循环的记账、依赖入队、解析结果应用、`files.Add` 全部加起来约 2ms。r53 §10 把「Program 余量 = 串行发布/应用」列为下一步，本轮实测该余量不存在。

### 3.2 解析槽位不足（否）

现成旋钮 `TSHARP_PARSE_CONCURRENCY` 同时控制 parse 与 resolve 两个信号量，先做整体对照（3 次/档）：

| 并发 | Program | Parse summed | Bind summed | Total |
| ---: | ---: | ---: | ---: | ---: |
| 4（默认） | 0.144 / 0.144 / 0.146 | 0.083~0.085 | 0.048~0.052 | 0.945~0.994 |
| 8 | 0.144 / 0.151 / 0.153 | 0.084~0.097 | 0.051~0.056 | 0.952~0.961 |
| 12 | 0.158 / 0.162 / 0.158 | 0.085~0.107 | 0.050~0.060 | 0.955~0.981 |

无改善，12 略差。随后把两者拆开（parse 固定 4，只提 resolve，临时 `TSHARP_RESOLVE_CONCURRENCY`）：

| resolve 槽位 | Program | `phase:r55Resolve`（求和） |
| ---: | ---: | ---: |
| 4（默认） | 0.084 / 0.162 / 0.143 | 0.137 / 0.367 / 0.312 |
| 8 | 0.154 / 0.144 / 0.161 | 0.495 / 0.495 / 0.536 |
| 16 | 0.151 / 0.172 / 0.158 | 0.651 / 0.784 / 0.703 |

槽位翻倍时 resolve 的**求和**涨 1.5~2 倍而墙钟不动，是共享资源争用的典型形态（解析缓存锁 / package.json 缓存锁 / 池化路径分配的争用，未逐一定位）。**「多开解析并发」这条最自然的路径被数据否决**，因此在 32 核机器上 Program 仍稳定落在 0.14~0.15s。

## 4. 解析内部构成

`ModuleResolver.Request.RunAsync` 的分支插桩（安静批）：

| 帧 | 占 `r55Resolve` | 说明 |
| --- | ---: | --- |
| `r55ResBody` / `r55ResModule`（`ModuleAsync` 本体） | ≈100% | 解析主流程 |
| `r55ResNodeModules`（node_modules 祖先链） | 8%~20% | 裸模块名 |
| `r55ResReal`（`RealPath` + 规范化） | 4%~6% | 命中时的符号链接解析 |

即成本不在某一个分支，而在主流程的逐候选处理：相对导入走 `RelativeLoad` → `LoadFile`/`AddExtensions`，每个候选都要做路径拼接、`DirectoryExists`/`FileExists`（r51 的缓存命中路径）、`Trace`/`Message` 参数构造。831 次解析、去重后 343 次未命中，单次未命中 0.4~1.2ms。

**为何不再往下挖**：这些站点单点价值都在 1~3ms 量级（`Message` 的 `params` 数组与 `ExtensionNames` 字符串、`ResolveAsync` 每次重复的 `Resolve`/`ToLowerInvariant`、逐候选路径分配等），合计低于 Total 的 1.5%，也低于本机 2.4% 的端到端伪差地板（r53/r54 实测）。按「<5% 默认不做」，不立项。

## 5. 复现口径与边界

- 探针：`phase:r55Roots`/`r55Await`/`r55Drain`/`r55Libs`（LoadPending 两趟与等待）、`r55Read`/`r55Scope`/`r55ParseBind`/`r55Resolve`（Builder）、`r55ResBody`/`r55ResModule`/`r55ResNodeModules`/`r55ResReal`（解析器），全部 `Measure(..., traced:false)`，量后回退；`TSHARP_RESOLVE_CONCURRENCY` 临时旋钮同回退。
- 机器态影响显著：同一二进制同一负载，Program 读到过 0.084s 与 0.43s 两端；本报告只用**同一会话内的比例与求和/槽位关系**下结论，不用跨会话绝对值。
- `Measure` 作用域的分配列是进程级（`GC.GetTotalAllocatedBytes` 差值），并行下会重复计数，本报告不引用该列做结论（r52 已记同一陷阱）。
- 一次构建踩坑：`r55` 首版探针在 `using` 块里给 `ResolvedModule result`（`ResolvedModule?` 的返回）赋值触发 CS8600，改为 `ResolvedModule?` + `??=` 解决。

## 6. 剩余空间（本轮之后）

| 相位 | 现状 | 状态 |
| --- | --- | --- |
| 检查 0.52s / 47% | 关键分区由 `proto.ts` 单点钉住；关系引擎族受 r27 表 3 约束；r54 已证 check→emit 流水线恒等 | 关闭（需用户裁决或归因工具） |
| emit 0.20s / 19% | r54 已发布属主派发（相位 −12.3%），轴到结构上限 ≤3% | 关闭 |
| Program 0.14s / 17% | 本轮：解析主导、并发无效、成本弥散 | **关闭** |
| 启动 0.09~0.14s | 环境性（进程创建 60~130ms） | 非代码目标 |

**结论：本仓在「调度 / 缓存 / 并发 / 相位排列」四类手段上已无 ≥5% 的可兑现空间**，这与 r43、r53 的结论一致。要继续拿两位数收益只剩两条路，且都需要用户裁决：

1. **与参考实现分叉的分区重平衡**（改 `CheckerPartitions` 权重或默认 checker 数）。r52 实测 checkPool 可降 0.13~0.29s，但跨会话翻转且分配 +6%，并会让已发布基线全部失效。
2. **表示层重写**（类型对象的紧凑化 / arena 式布局，即 tsrs 4~17× 的来源）。ledger 表 2 有 arena 的否决记录（r23/r34），但那是「局部性通道不建原型测不出」的定价，不是「已证明无收益」；这是目前唯一有可能突破 10% 的方向，规模为月级。