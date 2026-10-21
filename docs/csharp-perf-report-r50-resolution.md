# r50 报告：模块解析并行化（发布，Program 相位 −35.9%）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-21 ｜ 轮次: r50 ｜ 主题: parallel-module-resolution
> 触发: 用户令「按最优方案，修复发现的问题和缺陷」
> 关联: `docs/csharp-perf-report-r49-bottleneck.md`（问题定位与判定方案）、`docs/csharp-perf-report-r48-multirun.md`、`.ai/perf-ledger.md`
> 状态: 已发布。改动 1 文件，全部输出等价门禁通过，端到端两批 CI 排除 1.0。

## 1. 结论

r49 定位到的问题修好了：模块解析原本在发布循环里逐文件串行执行，占 Program 相位 95%、Total 的 21~22%。改为「解析完成的文件立即并行解析其导入，发布循环按序应用结果」后：

| 指标 | 修复前（r48） | 修复后 | 变化 |
| --- | ---: | ---: | ---: |
| Program 相位（6 对交错） | 中位 0.442 s | 中位 0.284 s | **−35.9%** |
| Total（同批） | 中位 1.331 s | 中位 1.127 s | −15.3% |
| 端到端全量态（25 对，批 1） | 732.1 ms | 625.2 ms | **0.8540，CI [0.832, 0.895]** |
| 端到端全量态（25 对，批 2） | 693.7 ms | 589.6 ms | **0.8499，CI [0.817, 0.876]** |

两批 CI 都排除 1.0，端到端快约 15%。

## 2. 修复前的结构

`CompilerProgram.LoadPending` 的循环是：

1. 把当前已知的待加载文件全部排成 `ParseAndBind` 任务，受 `parseSlots` 信号量限流；
2. 按发现顺序取队首，`await` 它的解析结果；
3. 在该文件的解析结果上**串行**解析它的 `typeReferenceDirectives`、导入与模块增强，然后把结果写进 `pending`、`files`、`diagnostics`。

第 3 步是发布线程上的串行工作。r49 实测：模块解析累计 201~235 ms，占 `progLoadRoots` 的 95%、Total 的 21~22%；831 次解析里 488 次命中解析器缓存、343 次未命中，每次未命中均摊 0.59 ms。

解析任务本来就在并行跑（`parseSlots` 限流），但它藏在串行解析下面，没能成为瓶颈；真正的墙钟由第 3 步决定。

## 3. 修复

把第 3 步拆成「准备」与「应用」两段：

- `PrepareAsync`：等本文件的解析结果，然后**并发**启动该文件全部导入的解析（`typeReferenceDirectives`、导入、模块增强），把结果打包成 `Prepared`；
- 发布循环：仍然按发现顺序 `await entry.Prepared`，然后**按原顺序**应用结果（`Include`、`resolutions.Add`、`diagnostics.AddRange`、`files.Add`）。

新增 `resolveSlots` 信号量，与 `parseSlots` 同并发度。`PrepareAsync` 在等 `parseSlots` 释放之后才申请 `resolveSlots`，因此两个信号量不会互相等待，不存在死锁。

`PrepareAsync` 在文件进入 `scheduled` 队列时就启动，所以文件 N 的解析在其解析结果就绪后立即开始，与文件 N+1、N+2 的解析重叠，不再排在发布循环后面。

### 3.1 并发安全的前提

`ModuleResolver` 的缓存读写都在 `lock (gate)` 内，`PackageJsonCache` 有自己的锁，`Request` 是每次解析新建的实例，状态不共享。这是可以并发的依据。

`--traceResolution` 是例外：trace 文本会写明某次 `package.json` 查找是否命中共享缓存，并发填充会让这个措辞依赖执行顺序。因此开启 trace 时走原来的串行路径。这条保护由 `options.TraceResolution != true && concurrency > 1` 判定。

## 4. 输出等价验证

| 验证 | 结果 |
| --- | --- |
| 6 夹具逐字节（`perf-verify`，201 artifacts，对 `pre`） | 全等 |
| 错误密集夹具 `errdense`（200 文件 × 25 常量，5000 行诊断） | stdout 逐字节相同 |
| `medium` 的 `--traceResolution`（768 行） | 逐字节相同 |
| `dtsheavy` 的 `--traceResolution`（1208 行） | 逐字节相同 |
| `--singleThreaded`（`medium`） | 逐字节相同 |
| safety 套件 | 90/93，失败 ⊆ 基线 |

错误密集夹具最关键：5000 行诊断的顺序完全一致，说明「按序应用」没有破坏诊断序。`--traceResolution` 两个夹具一致，说明串行保护生效。

## 5. 端到端的 CPU 代价

| 批 | 优化版 CPU | 基线 CPU | 变化 |
| --- | ---: | ---: | ---: |
| 批 1 | 1891 ms | 1578 ms | +19.8% |
| 批 2 | 1734 ms | 1547 ms | +12.1% |

峰值内存 380 对 378 MiB，基本持平。

CPU 上升是预期的：原来 Program 相位只有一个线程在解析模块，现在用上了空余核。对短命编译进程来说，用 CPU 换墙钟是正确的取舍，因为用户在等墙钟。但这意味着在已满载的机器上收益会缩小，高并发场景需要单独评估。

## 6. 为什么这一轮能直接修

r49 给出的判定方案是「先验输出逐字节一致，再测墙钟」。本轮按此执行：先实现，再跑六项等价验证（全部通过），最后测性能。等价性是先决条件，不通过就不测性能、直接回退。

与 r48 相比，这一轮的风险更高：它动的是程序构造的发布循环，直接决定文件序与诊断序。因此验证项从「6 夹具」扩到「错误密集诊断序 + trace 输出 + 单线程路径」三类。

## 7. 产物

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 实现 | `csharp/src/TypeScript.Compiler/Programs/CompilerProgram.cs` | 已提交 |
| 门禁记录 | `built/csharp/perf-fresh/verify/r50-final.json` | 临时 |
| 配对数据 | `/c/ai/projects/tsbench/r38/r44e-insert-*.json` | 临时 |

## 8. 剩余

Program 相位从 0.442 降到 0.284 s 后，Total 的结构变成：checkPool 约 0.55 s、Program 约 0.28 s、其余（parse/bind/emit/config）约 0.28 s。检查相位重新成为最大的一块，其内部由关系引擎族主导（受表3 勿重开约束，归因工具仍不通）。

模块解析这边还可以继续：343 次未命中平均 0.59 ms 偏高，若 node16 在候选扩展名与目录上有重复探测，探测结果的前缀缓存还有空间。这属于 `ModuleResolver` 内部，语义约束比并行化更严，需要单独的判定探针。
