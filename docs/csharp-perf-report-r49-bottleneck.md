# r49 报告：r48 之后的瓶颈复测（关系引擎仍最大，模块解析是最大未保护区）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-21 ｜ 轮次: r49 ｜ 主题: post-r48-bottleneck
> 触发: 用户引用 r46 的瓶颈结论，要求继续修复
> 关联: `docs/csharp-perf-report-r48-multirun.md`（本轮起点）、`docs/csharp-perf-report-r46-census.md`（被修正的旧结论）、`.ai/perf-ledger.md`
> 状态: 测量完成，产品代码零改动。给出修正后的分布与下一个可攻靶点。

## 1. 先修正一处过时结论

用户引用的「关系引擎族 5.7 s 线程时间占绝对主导」是 r48 之前的读数。多段归并上线后重新测量：

| 探针（线程时间，多 checker 求和） | r46 读数 | r49 读数 |
| --- | ---: | ---: |
| relationCompare | 1.833 s | 1.551 s |
| relRecurse | 1.622 s | 1.306 s |
| recStamp | 1.024 s | 1.267 s |
| relationProperties | 0.622 s | 0.528 s |
| relationRelated | 0.608 s | 0.692 s |
| resolveMembers | 0.477 s | 0.442 s |
| symbolTypesGet | 0.442 s | 0.488 s |

相位：`checkPool` 0.550 s、`Program` 0.309 s、`Total` 1.134 s。

关系引擎族仍是线程时间最大的区块，但两个要点需要纠正：

1. 这些是**线程时间**，多 checker 求和，不等于墙钟。墙钟由 `partition#1` 决定。
2. 检查相位已从 r45 的 0.580 s 降到 0.504 s（12 对交错中位），剩余空间比 r46 时小得多。

## 2. EventPipe 归因：工具在，路径不通

r27 记「EventPipe 在本机 .NET 11 RC 不可用」。本轮核实：

- `dotnet-trace` 与 `dotnet-counters` 都已在 `~/.dotnet/tools` 安装（r27 时的结论已过时）；
- 但对 AOT 二进制启动挂接失败：`dotnet-trace collect -- <exe>` 报 `the target app failed to connect to the diagnostics port`；
- 改用 `DOTNET_DiagnosticPorts=<sock>,suspend,connect` 加 `dotnet-trace --diagnostic-port` 也未连上。

结论：工具可用，AOT 的 diagnostics IPC 在这条路径上仍不工作。r27 的「布局扰动归因」前置条件在实践上仍未解除。这是本轮确认的事实，不是猜测。

## 3. 新发现：模块解析是关系引擎之外最大的未保护区

给 `CompilerProgram.BuildGraph` 加临时相位后，Program 时间的内部分解：

| 相位 | 耗时 | 占 Program |
| --- | ---: | ---: |
| `progLoadRoots`（291 个源文件） | 0.246~0.278 s | ~95% |
| `progAutoTypes`（`@types` 自动指令） | 0.002 s | <1% |
| `progLoadLibs`（默认 lib 链） | 0.001 s | <1% |
| `progLibPath` | 0.000 s | <1% |

也就是说，Program 的 0.23~0.31 s 几乎全部是加载 291 个根文件。再往里拆：

`LoadPending` 的结构是「parse+bind 并行入队，模块解析在发布循环里串行执行」。实测：

```
resolveMs=201.1  hits=488  misses=343
```

- 模块解析累计**201~235 ms**，占 `progLoadRoots` 的 95%、`Total` 的 **21~22%**；
- 831 次解析中 488 次命中解析器缓存、343 次未命中；
- Parse（0.098 s 求和）与 Bind（0.063 s 求和）并行执行，藏在串行解析下面，因此没有成为墙钟瓶颈。

343 次未命中摊到 201 ms，平均每次 0.59 ms。这个量级对一次文件系统探测偏高，指向 node16 解析在候选路径上的多次探测。

## 4. 为什么这是下一个该攻的点

| 维度 | 关系引擎 | 模块解析 |
| --- | --- | --- |
| 规模 | 线程时间 5.3 s（墙钟占比未知） | 墙钟 0.20~0.24 s，Total 的 21~22% |
| 约束 | r27 表3 勿重开，前置是布局扰动归因 | 无表3 约束 |
| 归因工具 | EventPipe 路径不通（本轮确认） | 已有可用的临时相位与缓存计数 |
| 风险 | 任何触碰都会引入 +2.27~3.04% 布局扰动 | 输出顺序（文件序、诊断序）必须逐字节不变 |

模块解析的优化方向有三个，都需要单独立项：

1. **并行化解析**。当前是「文件 A 解析完 → 串行解析 A 的导入 → 再处理文件 B」。把每个文件的导入解析改为并发启动、按序汇合，可保持输出顺序不变而压掉串行段。风险在 `ModuleResolver` 的线程安全性与 `PackageJsonCache` 的共享状态。
2. **减少探测次数**。343 次未命中平均 0.59 ms，若 node16 在候选扩展名与目录上重复探测，可以做探测结果的前缀缓存。语义约束最严，必须与 tsc 的解析顺序完全一致。
3. **预热 `@types` 与 lib**。这两项合计仅 3 ms，不值得。

第一项的期望收益最大：[估] 若把 201 ms 的串行段压到 8 路并行下的 60~80 ms，Total 可降 12~14%。

## 5. 本轮没有动产品代码的原因

三项都需要改程序构造的核心路径（`LoadPending` 的发布循环或 `ModuleResolver` 的缓存层），一旦文件序或诊断序变化，25 夹具逐字节门禁会失败。按 r27 的纪律，这类改动必须先有隔离批次的判定探针，而不是直接改。

而关系引擎方向的归因工具本轮已验证不通，所以那条线仍按表3 保持关闭。

## 6. 产物

| 项 | 位置 | 状态 |
| --- | --- | --- |
| Program 相位探针 | 已 `git restore` 回退 | 不入库 |
| 解析器缓存计数探针 | 已 `git restore` 回退 | 不入库 |
| 产品代码 | `git status` 干净，`dotnet build csharp/TypeScript.slnx -c Release` 0 警告 0 错误 | 零改动 |
| r48 发布态 | `built/r48-final/`，逐字节对 `pre` 全等 | 有效 |

## 7. 下一步

给模块解析并行化做一个判定探针：在 `LoadPending` 里把「解析所有文件导入」改成并发任务、按序汇合，先只测输出是否逐字节一致（不做性能）。一致则继续测墙钟；不一致则按 r27 纪律记录并关闭这条线。

这个探针不需要改产品代码，只在临时补丁里做，与 r48 的流程相同。
