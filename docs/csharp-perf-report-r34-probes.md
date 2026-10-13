# r34 定价探针：架构改写与同步化的实测价格（2026-10-13）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-13 ｜ 轮次: r34-probes ｜ 主题: pricing-the-two-remaining-levers
> 触发: 用户指令「2,3」——对「架构级改写先定价」与「同步化在串行负载上的价格」两个未定价杠杆做实测
> 数据来源: fresh 产物（`pkgs-fresh/r34`）的存活集测量；runtime-async on/off 双构建配对 A/B（10 对）；既有 no-GC region 实验

## 1. 结论摘要

两个杠杆都测完了，结论都是**不做**：

| 杠杆 | 实测价格 | 判定 |
| --- | --- | --- |
| 类型/签名结构体化 + arena | GC 通道上限 −0.9% 墙钟（no-GC region 实验已定价），局部性通道不可探针；月级工作量 | **否决**（ speculative 收益 < 工作量两个数量级） |
| 同步化重写 | 经典异步税 23.75%（串行行）已被 Runtime Async V2 全量拿走；V2 残差估计 0.22% 墙钟 | **否决**（残差低于噪声下限） |

附带确认：`runtime-async` 是 .NET 11 `<Features>` 的唯一开关（官方文档核对），没有其他可白拿的运行时收益；该开关自 2026-09-22 移植二期即在，campaign 全部轮次都带着它。

## 2. 探针一：arena 定价（对象寿命分解）

**测量**：fresh 当前产物，全量 check + emit 态（状态文件已删），对比 `CLR allocated bytes`（进程累计分配）与 `CLR managed bytes`（`GC.GetTotalMemory(forceFullCollection: true)`，退出时存活集）：

| 形态 | 累计分配 | 退出存活 | 垃圾 | 垃圾占比 |
| --- | ---: | ---: | ---: | ---: |
| 真实工程 `--noEmit`（check 阶段） | 813.7 MB | 222.0 MB | 591.7 MB | **72.7%** |
| 真实工程全量（+ emit） | 1,001.7 MB | 224.2 MB | 777.5 MB | **77.6%** |

emit 阶段再分配 188.0 MB、存活只增 2.3 MB，即 **emit 分配几乎 100% 是垃圾**（输出文本缓冲，r32 已优化过一轮仍如此）。check 阶段的垃圾不随文件数变化（huge-file 64.7% / medium 69.1% / tiny-files 71.0%），是各形态稳定的约三分之二。

**探针级归因**（今日独占分配探针）：明确临时的站点（objectCheckExpr 16.0M、relationRelated 12.4M、relRecurse 5.3M、ctxProperties 4.9M、propertyLookup 4.5M、relKeys 4.1M 及 mutable/ctx/rel 家族小点）合计约 63 MB；r27 定界为保留结构本体的（resolveMembers 77.8M、typeFromNode 36.7M、symbolTypesGet 32.8M、recStamp 25.9M、variableType 20.7M、membersTable 9.9M）合计约 204 MB。剩下约 530 MB 垃圾在未插桩路径（parse/bind/未探针 checker/AST/字符串）。

**定价**：arena 能拿掉的是那 777.5 MB 垃圾对应的分配器与 GC 工作，但：

- **GC 通道已定价**：no-GC region 实验（r33 实验 1，r34 复测）把 GC 停顿从 81.5ms 压到 3.9ms、编译期零 collection，墙钟中位只动 **−0.9%**（10 对，低于 1.1% 噪声下限）。这是「全部垃圾都不被回收」的上限，arena 的 GC 侧收益不可能超过它。
- **分配器通道很小**：.NET 分配器本身已是每线程 bump pointer，arena 替代它省的是对象头初始化和 free-list 维护，量级在每个对象几 ns。
- **局部性通道不可探针**：no-GC region 其实让局部性变差（堆里压着全部垃圾）却仍读到 −0.9%，说明 GC 收益与局部性损失大致相消；设计良好的 arena（紧凑存活集）能同时拿到两边，但这个收益不建原型测不出来，而原型就是工作量的主体。
- **对象数差距要靠结构体化不是 arena**：C# 分配字节约为 Go 的 6 倍而节点尺寸相当（IdentifierNode ~80B vs ~72B），差距在对象数；arena 只改分配位置不改对象数，真正碰对象数的是类型/签名结构体化，那是月级重写且带 r27 的布局敏感风险（−4.3MB 分配换 +2.3% 墙钟的先例）。

**判定**：月级工作量，已测上限 −0.9% + 不可测的局部性收益。不做，除非用户接受一次投机性立项。

## 3. 探针二：同步化在串行行的价格

**方法**：`runtime-async` 是编译期开关（runtimeconfig 无对应项），在一次性 worktree 构建 `runtime-async=off` 变体（产品侧只需把一处 `File.Source.Text[await StartAsync(expression)..expression.End]` 的 await 提出切片外，LSP 补全路径，不影响 CLI 负载；两个构建在 medium 夹具输出逐字节一致，DLL 15.9M vs 12.5M）。配对 A/B（10 对交替，均为 JIT 同工具链，唯一变量是异步形态）：

| 负载 | async-off / async-on 中位 | 解读 |
| --- | ---: | --- |
| medium `--checkers 1`（串行，最差单项行） | **1.2375（+23.75%）** | 经典异步税是串行检查的近四分之一 |
| medium（默认 8 checker） | 1.1234（+12.34%） | — |
| huge-file | 1.1270（+12.70%） | — |

**解读**：经典异步形态下，异步机制吃掉串行检查 23.75% 的墙钟——这正是 Go 不付的税。但 **Runtime Async V2 已经把它全量拿走**：当前构建比经典形态快 23.75%（串行）/ 12.3~12.7%（并行），而 `runtime-async=on` 自 2026-09-22 移植二期就在 `Directory.Build.props` 里，campaign 全部轮次（r06~r34）都带着它，历史表口径一致（x1.428→x1.397 不是开关假象）。

同步化重写剩下的唯一空间是 V2 的残差：r24 微基准测得 V2 下每次调用 2.0~2.3 ns，热帧折算 **0.22% 墙钟**。串行不改变这个比例（税是 CPU 工作，并行只把它摊到多核，占墙钟比例不变）。

**判定**：0.22% < 噪声下限 1.1%。不做。

## 4. 附带：运行时特性开关排查

官方文档（Microsoft Learn .NET 11 runtime、Laurent Kempé、InfoQ、dotnet/runtime#109632）核对：`<Features>runtime-async=on</Features>` 是 .NET 11 该机制的唯一开关，无其他 `<Features>` 家族成员；`DOTNET_RuntimeAsync` 环境变量已在 RC 移除，逐项目 opt-out 用 `<UseRuntimeAsync>false`。本地枚举（详细构建日志、bogus 值测试）同样只有这一个。结论：没有第二个可白拿的开关，这一项收益已经吃干。

## 5. 与既有账目的关系

- ledger 表2「AST 结构体 arena 重写」行原以「节点尺寸与 Go 相当」否决，本探针补上寿命与通道定价（77.6% 垃圾、GC 通道上限 −0.9%、局部性不可测）。
- ledger 表2「同步化重写（墙钟收益）」原记 0.22%，本探针补上经典异步税的实测幅度（串行 +23.75%）与「V2 已全量拿走」的归因。
- 至此 r33 报告列出的四个结构性杠杆全部有实测价格：no-GC region、R2R+PGO、gen0/latency、parse 槽位，加上本轮定价的 arena 与同步化。剩余方向只有架构级重写一条，且价格为月级工作量换 ≤1% 已测收益。
