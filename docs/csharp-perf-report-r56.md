# r56 报告：checker 数上调的有界实验（否决）与测量口径缺陷

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-22 ｜ 轮次: r56 ｜ 主题: checker-count-and-total-caliber
> 触发: 用户令「继续按最优方案优化」；执行 r55 §6 推荐的分叉实验（checker 数上调），并复核 r54 之后该路径的上限。
> 关联: `docs/csharp-perf-report-r52-imbalance.md`（路径 A 首测，emit 尚为共享队列）、`docs/csharp-perf-report-r54.md`（emit 属主派发，改变了该路径的上限）、`docs/csharp-perf-method.md` §7（测量协议）
> 状态: 诊断轮，**产品代码零改动**。实验用现成旋钮 `--checkers`，无临时探针。

## 1. 结论

两条结论，一条否决一条口径修正。

1. **checker 数上调否决**：`--checkers 16` 在真实工程上 Total −5.3%（CI [0.810, 1.024]，含 1.0，不可判），在官方 `medium` 夹具上 **+3.0%（CI [1.013, 1.050]，排除 1.0，确定退化）**，`huge` / `dtsheavy` / `tiny512` 中性。退化成因已定位：每 checker 的构造期重复派生（`constructEach` 0.011→0.026s、`globalMerge` 0.010→0.023s）使 check CPU **+31%**（0.65→0.85s），文件数少的夹具摊不平。按「不得让任何官方夹具退化」的纪律，不改默认值。
2. **测量口径缺陷（新，影响历史解读）**：`--extendedDiagnostics` 的 `Total time` 把统计设施自身开销算进去了——`GC.GetTotalMemory(forceFullCollection: true)` 的强制全 GC，加上 `Statistics()` 里对全部语法树的一次标识符遍历。实测该旗标给整进程墙钟加 **约 350ms**（plain 959/1031/1155ms 对 ext 1344/1278/1332ms），占 Total 读数的 **28%~31%**。`docs/csharp-perf-method.md` §7.1 只记了它对 `GC pause time` 的污染，没记它对 `Total` 的污染。

## 2. checker 数实验（r55 §6 推荐路径的执行）

r52 测这条路径时 emit 还是共享队列，属主数只影响检查相位。r54 之后 emit 按属主派发，属主数同时决定两个相位的 makespan，所以上限比 r52 记录的大，值得重测。同一二进制（`built/r54-final`）、两臂只差 `--checkers`、逐对交替、每轮全新夹具副本并删 tsbuildinfo：

| 夹具 | 文件数 | Total 中位 c8 → c16 | 比值（c16/c8） | 95% CI | 分配 c8→c16 |
| --- | ---: | --- | ---: | --- | --- |
| real-world | 291 | 1.270 → 1.203 s | 0.9472 | [0.810, 1.024] | 913→939 MiB（+2.8%） |
| **medium** | **65** | **0.669 → 0.689 s** | **1.0299** | **[1.013, 1.050]** | 294→316 MiB（+7.6%） |
| huge | 1 | 3.506 → 3.510 s | 1.0011 | [0.960, 1.036] | 531→536 MiB（+1.0%） |
| dtsheavy | 211 | 0.602 → 0.595 s | 0.9884 | [0.947, 1.012] | 217→224 MiB（+2.9%） |
| tiny512 | 512 | 0.676 → 0.667 s | — | 逐对全部在 ±2% 内 | — |

真实工程的相位分解（同一批 12 对的中位）：

| 相位 | c8 | c16 | 变化 |
| --- | ---: | ---: | ---: |
| checkPool（关键分区墙钟） | 0.583 s | 0.527 s | **−9.6%**（CI [0.727, 0.949]，排除 1.0） |
| emitTotal | 0.243 s | 0.212 s | −12.8%（CI [0.695, 1.049]，含 1.0） |
| Check time（summed，8→16 线程） | 2.198 s | 2.903 s | **+32%** |
| Total | 1.270 s | 1.203 s | −5.3%（CI 含 1.0） |

分区级读数解释了为什么相位改善没能稳定传导到端到端：

```
c8 : 1=0.626 6=0.351 2=0.307 0=0.244 5=0.221 7=0.194 4=0.189 3=0.183
c16: 7=0.444 6=0.370 3=0.191 14=0.189 10=0.188 0=0.183 11=0.155 12=0.138
     1=0.124 9=0.111 8=0.109 2=0.108 5=0.091 13=0.074 15=0.071 4=0.066
```

c8 下最重分区是 #1（0.626s，含 `proto.ts`）；c16 把它拆开了（#1 降到 0.124s），但 **#7 从 0.194s 涨到 0.444s**——权重模型重新分配后，另一个分区被灌入了新的重负载，成为新的关键路径。这就是「提高并行度不等于降低关键路径」的具体形态。

**medium 的退化成因**（同一夹具 3 次）：

| 量 | c8 | c16 |
| --- | ---: | ---: |
| `checkPool` | 0.420~0.436 s | 0.413~0.469 s |
| Check summed | 0.637~0.661 s | 0.754~0.853 s（**+31%**） |
| `constructEach` | 0.011~0.016 s | 0.019~0.026 s（近 2×） |
| `globalMerge` | 0.009~0.014 s | 0.017~0.023 s（近 2×） |
| `checkConstruct` | 0.002 s | 0.002~0.003 s |
| 进程分配 | 308 MB | 332 MB |

65 个文件、每文件 3.9 KB 的夹具上，checker 从 8 增到 16 让每 checker 重复派生的总量翻倍，而可并行的检查工作只有 0.65s，摊不平构造期成本。这与 r37 §3 记录的「(d) 每 checker 重复派生」是同一机制，只是当时在 check 相位观察到，现在确认它对小文件数负载的净效应为负。

**处置：否决。** 也不能用「按文件数自适应」绕过：真实工程 291 文件、medium 65 文件，但 dtsheavy 211 文件与 tiny512 512 文件都只读到中性，说明收益依赖的是「文件大且多」这一组合，而静态特征（节点/字节/导入）已被 r39/r52 两次证明无法预测真实成本，没有可靠的判据把两者分开。

## 3. 测量口径缺陷：`Total time` 包含统计设施开销

`CompilationCapture.Statistics()` 在 `Total` 的计时窗口内做两件昂贵的事（`Diagnostics/CompilationCapture.cs:311-332`）：

```csharp
foreach (var file in program.SourceFiles) { pending.Push(file.Syntax); while (pending.TryPop(out var node)) { ... identifiers++ ... } }   // 整棵语法树遍历
...
ManagedBytes = GC.GetTotalMemory(forceFullCollection: true),   // 强制全量 GC
```

`started` 在 Capture 构造时取（`:222`），`TotalTime = Stopwatch.GetElapsedTime(started)...`（`:336`），所以这两项都计入 `Total`。实测（真实工程 full 模式）：

| 模式 | 墙钟（3 次） |
| --- | --- |
| 不带 `--extendedDiagnostics` | 959 / 1031 / 1155 ms |
| 带 `--extendedDiagnostics` | 1344 / 1278 / 1332 ms |

差值约 **350ms**，而读数里的 `Total time` 为 1.12~1.19s——即 **Total 的 28%~31% 是统计设施自身**。

影响：

- **本轮之前所有「Total 占比」类结论都系统性低估各相位份额**。例如 r54 说「emit 占 Total 19%」，按纯编译 Total（约 0.85s）应是 24%；「checkPool 47%」应是 62%。
- 相对比较（同口径下的比值、相位间比例）不受影响，所以已发布的优化结论（emit 派发、union 归并等）不受影响。
- `docs/csharp-perf-method.md` §7.1 已记 `GC.GetTotalMemory(forceFullCollection: true)` 会抬「GC pause time」读数（0.22~0.24s 对自然值 81.5ms），但没记它同时污染 `Total`。

**本轮不动产品代码**：把这两项移出计时窗口会让 `Total` 变小而真实速度不变，属于改测量而非改性能，且会让全部历史轮次的 Total 读数与报告不可比。正确处置是把它写进测量协议作为已知偏移。

## 4. 战役状态（r56 之后）

r55 §6 列的两条需裁决路径，第一条（分叉的分区重平衡）由本轮数据否决：上限在 r54 之后确实变大了（checkPool −9.6% 对 r52 的读数同量级，emit 也拿到 −12.8%），但关键路径的转移（#1→#7）与 medium 的确定退化让净收益不可判且带回归。剩下只有表示层重写一条路。

| 手段族 | 状态 | 依据 |
| --- | --- | --- |
| 调度（emit 派发） | 已发布，轴关闭 | r54 |
| 调度（check 分区/checker 数） | 否决 | r52、r56 |
| 缓存（infer/union/flow/比较对/跨 checker 共享） | 全部否决 | r40、r42、r43 |
| 并发（解析槽位） | 否决 | r55 |
| 相位排列（check→emit 流水线） | 结构性恒等 | r54 §7 |
| lib 预绑定 | 关闭 | r53 |
| Program 串行段 | 关闭（仅 2ms） | r55 |
| 启动地板 | 环境性 | r54 §8 |
| **表示层（类型对象布局）** | **唯一未定价的大方向** | 表 2 的 arena 否决是「不建原型测不出局部性通道」的定价，非「已证无收益」 |

## 5. 复现口径

- 配对驱动：`node tsbench/r38/r56-checkers-paired.mjs <fixture-dir> <tag> <pairs> <warmups>`（`R56_EXE` 覆盖二进制；arms 固定为 `--checkers 8` 与 `--checkers 16`）。
- 等价性驱动：`node tsbench/r38/r56-checkers-equivalence.mjs`——同一夹具先 8 后 16，删除 `out/` 与 tsbuildinfo 后逐产物哈希比对：**195 产物、0 差异**，即 checker 数不影响发射字节（这是该旋钮可安全实验的前提）。
- 每轮删夹具根 `tsconfig.tsbuildinfo` / `tsconfig.enums.tsbuildinfo`。
- 本报告所有 Total 读数均含 §3 的约 350ms 统计开销，跨报告比较占比时须换算。

## 6. 下一步

只剩表示层重写（紧凑 `Type` 对象 / arena 式布局）。它的定价依据目前只有两条间接证据：tsrs 的 4~17× 优势全部来自表示层与内存层（`docs/csharp-perf-tsrs-analysis.md`），以及 r34 的「局部性通道不建原型测不出」的判定。这是月级工程，且触碰全仓最热的类型系统，开工前需要：

1. 一个**可证伪的定价原型**（例如只对单一高频类型族做紧凑化，量不到局部性收益就停），规模 1~2 周。
2. 用户显式裁决——它会与已发布基线全面不可比，并且是全仓风险最高的改动面。