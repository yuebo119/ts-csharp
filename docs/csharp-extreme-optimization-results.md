# C# 版 TypeScript 编译器：极致性能优化方案

> 目标：**降时延、降内存、增并发**。方法：先把墙上时间拆成可优化项并量化每一段的差距，再逐项给出"证据 → 改动 → 收益模型 → 风险 → 验证"，最后给出路线图与目标态预测。
> 配套实测报告：[report-csharp-vs-go.md](report-csharp-vs-go.md)（主对比、阶段归因、A/B 实验）；热点源码证据：[cs-hotpath-analysis.md](../tsbench-notes/cs-hotpath-analysis.md)（29 项，带 `File.cs:LINE`）。
> 本次新增的**关键实测**：并行发射原型在同一二进制内 **−34.5%（medium）/ −30.4%（512 文件）/ −24.9%（declarations）/ −29.6%（增量）**，内存不变；相对 Go 的比值由 3.14×→**2.09×**、1.81×→**1.28×**、2.54×→**2.10×**、1.89×→**1.33×**。

---

## 0. 量化目标（可验收）

| 维度 | 当前（R1/R2 基线） | **P0 候选（已构建并实测）** | P1/P2 目标 | Go 参照 |
| --- | --- | --- | --- | --- |
| 启动 `--version` | 1.09–1.30× | **1.13×** | ≤1.03× | 46–55 ms |
| 512 文件完整编译 | 1.77–1.81× | **1.33×** | 1.05–1.15× | 230–306 ms |
| 512 文件 `--noEmit` | 1.15× | **1.17×** | 1.02–1.05× | 117 ms |
| 512 文件增量编辑 | 1.89× | **1.37×** | 1.10–1.20× | 253–316 ms |
| medium 64 模块 | 3.02–3.14× | **2.10×（`--checkers 8` 时 1.94×）** | 1.45–1.65× | 89–112 ms |
| declarations | 2.42–2.54× | **1.93×** | 1.35–1.55× | 85–105 ms |
| 真实工程 186 文件 | 2.28–2.50× | ≈2.0×（同族改动，未重测） | 1.30–1.55× | 95 ms |
| 单巨文件 16k 声明 | 3.61–3.86× | **3.86×（无并发可借）** | 2.30–2.60× | 380–450 ms |
| project-references 4 项 | 1.44–1.69× | **1.28–1.45×** | 1.05–1.15× | 49–56 ms |
| 峰值 RSS（medium） | 55.5 MiB（WKS） | **59.9 MiB（Go 60.5）** | ≤58 MiB | 60.5 MiB |
| 峰值 RSS（512 文件） | 41.3 MiB | **45.3 MiB（Go 50.9）** | ≤48 MiB | 50.9 MiB |
| 峰值 RSS（huge-file） | 238 MiB | **238 MiB → 193 MiB（+GC 调优）** | ≤175 MiB | 164 MiB |
| 累计分配（huge-file） | 931 MB | 931 MB（未动） | ≤350 MB | ~300 MB |
| 有效并行度（medium / 512 文件） | 1.21× / 1.07× | **1.96× / 1.84×** | 2.6× / 2.8× | 3.08× / 2.6× |

> **P0 候选 = WS1（发射并行化）+ WS5（Workstation GC）**，已实际构建（`built/csharp/aot-p0`、包 `pkgs/p0`）并跑完整个 23 项 CLI 套件（15 组配对，噪声 9.8%）。它不是估算值 —— 除"真实工程"一行外全部为实测。

### 0.1 三条轴线的兑现路径（哪些已实测、哪些是推算）

![时延与内存轨迹：原基线 → P0（已实测）→ P1/极限目标](charts/optimization-plan.png)

| 轴线 | 已实测的兑现 | 推算的追加收益 | 主要工作流 |
| --- | --- | --- | --- |
| **降时延** | 发射并行化 **−18~−34%**（多文件）；`GCgen0size+GCLOHThreshold` 再 **−1~−7%**；WKS GC 对多文件 −5~10%；`--checkers 8` −7.7%；ReadyToRun 对托管形态启动 −64% | WS3（真实工程 −25~35%）、WS7（huge-file −25~35%）、WS6（启动 −10~20 ms） | WS1（已完成）→ WS2 → WS6 → WS3/WS7 |
| **降内存** | WKS 相对 SVR **−44~56%**；`GCgen0size=4 MB` **−17~19%**；`GCLOHThreshold=1 MB` 在 huge-file **−13%**；合计 huge-file **238→193 MiB**、medium **55.5→43.8 MiB**；P0 候选在 7 项负载上**低于 Go 的峰值 RSS** | WS4 分配削减（931→≤400 MB）预期再 −10~20% 峰值 | WS5（已完成大半）→ WS4 |
| **增并发** | 发射并行度 1.07→1.84（512 文件）/1.21→1.96（medium）；最优 checker 数由 4 改为 **8**（medium −7.7%、declarations −7.8%）；Server GC 堆数放大被证伪 | WS2 分区均衡 + 去 async（−5~10%）、WS3 模块解析并行、WS8 常驻服务 | WS1（已完成）→ WS2 → WS3/WS8 |

---

## 1. 性能模型：把墙上时间变成可优化的加法

### 1.1 时间分解

```
T_wall = T_proc + T_init + T_config + T_load + T_construct(parse∘bind∘resolve) + T_check + T_emit + T_write
```

用两个编译器的自报告阶段数据 + 实测墙上时间，得到下表（huge-file 与 512 文件两个极端，单位 ms，已把进程启动与配置期估算进去）：

| 分段 | huge-file Go | huge-file C# | 差 | 512 文件 Go | 512 文件 C# | 差 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 进程 + 运行时初始化 | ~50 | ~65 | 1.3× | ~50 | ~65 | 1.3× |
| 配置解析 | 1 | 6 | 6.0× | 1 | 41 | 41×（首次 lib 解析） |
| 加载 + 程序构建（parse） | 49 | 71 | 1.45× | 70 | **8** | **0.11×（C# 更快）** |
| 绑定 | 31 | 63 | 2.03× | 2 | 9 | 4.5× |
| 检查 | 98 | 324 | 3.31× | 1 | 3 | — |
| 发射 | 171 | **1064** | **6.22×** | 134 | **329** | 2.46× |
| 墙上合计（实测中位数） | 450 | 1625 | 3.61× | 306 | 553 | 1.81× |

**结论：差距不是均匀分布的，而是集中在两个可定位的点**：
1. **发射（emit）**——huge-file 占总时间 66%，512 文件占 78%（C# 侧）；
2. **检查（check）**——huge-file 上 3.31×，是单文件路径的第二大项。

而"加载/解析"在 512 文件上 C# **反超 Go 6 倍**（8 ms vs 70 ms），说明解析器的实现本身没有问题，问题在图层的调度与发射实现。

### 1.2 Roofline：每一段的下界由"工作量 ÷ 并发 ÷ 单核效率"决定

对任一段：`T ≥ W / (P × e)`，其中 `W` = 该段累计 CPU 时间（有用工作），`P` = 有效并发度，`e` = 单核效率相对 Go 的倒数。

实测（R1，medium / 512 文件）：

| 负载 | W_Go (CPU ms) | W_C# (CPU ms) | W 比 | P_Go | P_C# | T 比（实测） | 归因 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| medium | 312.5 | 421.9 | 1.35 | 2.81 | 1.21 | 3.14 | 并发缺口 ≈ 2.3× |
| 512 文件 | 859.4 | 593.8 | **0.69** | 2.81 | 1.07 | 1.81 | 几乎全部来自并发缺口 |
| 512 文件 --noEmit | 328.1 | 218.8 | **0.67** | 2.22 | 1.29 | 1.15 | 并发缺口 |
| 512 文件 增量 | 1093.8 | 625.0 | **0.57** | 3.46 | 1.05 | 1.89 | 并发缺口 |
| huge-file（单文件） | 468.8 | 2578.1 | **5.50** | 1.04 | 1.59 | 3.61 | 单核效率缺口（无并发可借） |

**这张表决定了优化策略的排序**：
- 宽而浅的负载（文件多）→ **并发是第一性杠杆**，且 C# 的绝对工作量本来就小，补齐并发即可反超；
- 深而窄的负载（单巨文件）→ **单核效率与分配是唯一杠杆**。

### 1.3 Amdahl 视角：串行段在哪里

以 512 文件为例（并行发射原型实测 470.8 → 327.9 ms），若把发射完全并行（理想），按阶段占比可推算下界 ≈ 65（启动）+ 41（配置）+ 17（par，已并行）+ 3（check）+ max(串行写, 329/P) + 尾巴。**实测已达到 322.8 ms（相对上游 −31%）**，说明剩下的大头是：配置期（41 ms，一次性 lib 解析）+ 程序构建 + 串行写出/合并。

---

## 2. 三大轴线的机理性分析

### 2.1 时延（Latency）：关键路径在哪里

| 关键路径段 | 现状 | 机理性原因 | 可压缩手段 |
| --- | --- | --- | --- |
| 进程启动 → 首次输出 | AOT 65 ms（Go 50 ms） | AOT 镜像 28 MB、静态初始化表（2213 条诊断消息 + 4 个从字面量构造的 `FrozenSet` + 595 条 UTF-8 字面量） | 惰性化/折叠静态表；裁剪镜像（见 WS6） |
| 配置期 | 6 ms（huge）/ 41 ms（512 文件），Go 1 ms | 每次 CLI 都重建配置与库解析结构 | 复用/缓存 + 并行 lib 解析（WS6） |
| 程序构建 | C# 求和 153 ms vs Go 44 ms（真实工程） | module resolution + binder 的分配与查找 | WS3 |
| 检查 | huge-file 324 ms vs Go 98 ms | 每核吞吐（容器包装、符号查找、分配） | WS7 + WS4 |
| 发射 | huge-file 1064 ms vs Go 171 ms；512 文件 C# 串行 | 串行 `foreach+await`；每文件新建 writer/scanner；`EmitContext` 每节点 5 次字典探测 | **WS1（已实测 −30%）** + WS7 |
| 尾部效应 | 多文件负载的总时间由最慢文件决定 | 无工作窃取、按文件数均分 | WS2 |

**时延的第二类来源是"内存压力转化为时间"**：把 `DOTNET_GCHeapHardLimit=256 MiB` 一档让 medium 从 349.2 → 294.7 ms（−16%）；Server GC 在 32 逻辑核上多消耗 39% 的进程 CPU 却不更快。因此**降内存与降时延是同一件事的两面**。

### 2.2 内存（Memory）：分配 → 存活 → 峰值 的三元结构

| 观测 | Go | C# | 含义 |
| --- | ---: | ---: | --- |
| huge-file 累计分配 | ~300 MB（7 次 GC，≤3% CPU） | **931 MB** | C# 分配量 3.1×，且每次分配都要付 GC 记账 |
| huge-file 存活峰值 | 89 MB | 93.9 MB（托管堆） | 存活集接近，**问题在周转率不在驻留量** |
| huge-file 峰值 RSS | 163 MiB | 238（WKS）/ 322（SVR） | 差异来自 GC 堆预留与 GC 模式 |
| medium 峰值 RSS | 60.2 MiB | 55.5（WKS）/ 126.5（SVR） | **WKS 下 C# 内存已优于 Go** |
| 512 文件峰值 RSS | 50.7 MiB | 41.3（WKS） | 同上 |

**结论：C# 的内存问题不是"存活集大"，而是三件事**：
1. **周转率过高**（931 MB vs 300 MB）→ GC 次数、写屏障、缓存污染；
2. **GC 模式未按机器标定**（32 逻辑核的 Server GC 建 32 个堆 → 126.5 MiB vs 55.5 MiB，并额外消耗 CPU）；
3. **单对象过重**：托管对象 16 B 对象头 + 每引用 8 B，而 Go 的 arena 结构体无头无引用，这是"同语义模型下 C# 天然多占 30–60% 内存"的结构性来源 —— 只能靠**减少对象数量**（arena/池化/紧凑数组）来抵消。

### 2.3 并发（Concurrency）：结构、调度、尾部与 GC 交互

**现状结构**（源码级）：

| 环节 | Go | C# | 实测影响 |
| --- | --- | --- | --- |
| 文件解析/绑定 | 每文件一个 goroutine，无上限（`core/workgroup.go:34-42`） | `SemaphoreSlim(4)`（`CompilerProgram.cs:181,277`） | **无影响**（解析在 512 文件上仅 8 ms） |
| 类型检查 | checker 池，`MaxCheckers` 默认 4（`checkerpool.go:86`） | checker 池，`DefaultCheckerCount` 默认 4（`CheckerPool.cs:10`） | 1→8 双方都只改善 13–17% |
| **发射** | **每文件一个 goroutine + 复用 writer**（`program.go:1845-1880`） | **串行 `foreach+await`，共用一个 checker**（`IncrementalProgram.Emit.cs`、`CompilerProgram.Emit.cs:44-55`） | **唯一的结构性并发缺口，已实测 −18~−34%** |
| 检查器分区 | 按文件 FENNEL 分区 | 同 | medium 上并行收益被合并开销抵消 |
| 写盘 | 池化 `EmitTextWriter` | 每文件新建 writer + `File.WriteAllBytes` | 发射阶段的一部分 |

**实测并行度（CPU/墙上）**：medium Go 2.81× vs C# 1.21×；512 文件 Go 2.81× vs C# 1.07×；增量 Go 3.46× vs C# 1.05×。—— **C# 的调度器没有把可用核心用起来**，而它并不缺工作量。

**三处被忽略的并发成本**（本次实测/剖析得到）：
1. **并行发射会增 CPU 但减时延**：tiny-files 515.6 → 593.8 ms CPU（+15%），墙上下跌 30.4%；这是正确的取舍（机器的核是空闲的）。
2. **Server GC 的线程与工作线程竞争**：huge-file 进程 CPU 从 WKS 的 1656 ms 涨到 SVR 的 2578 ms，墙上没有变快。
3. **剖析显示大量线程处于等待**（`dotnet-trace` 采样中 `LowLevelThreadBlocker.TimedWait` 58.9%、`WaitHandle.WaitForMultipleObjectsIgnoringSyncContext` 26.7%）：说明 async/await + 线程池在 CLI 这种"纯 CPU、无真实 I/O 等待"的场景里引入了额外的调度层，**CPU 密集路径应优先使用同步并行而不是 async 状态机**（这也是 WS2 的一条）。

---

## 3. 优化工作流（每条都给出证据、改动、收益模型、风险与验证）

### WS1 发射并行化 —— **本次已实现原型并实测**（P0，最高优先）

**证据**
- C# CLI 的发射是**串行**：`Incremental/IncrementalProgram.Emit.cs:48-85` 对每个待发射文件 `await Program.EmitWithCheckerAsync(...)`，并且**所有文件共用一个 checker**（`emitChecker ??= await Program.CreateCheckerAsync()`）；`Programs/CompilerProgram.Emit.cs:44-55` 同样是 `foreach + await`；每文件新建 writer/scanner（`Emission/SyntaxPrinter.cs:66,80`）。
- Go 是**每文件一个 goroutine**（`tsc/internal/compiler/program.go:1845-1880`、`execute/incremental/emitfileshandler.go:124-167`），按 checked-file 分区借出池化 checker（`emitHost.go:38-39` → `program.go:590-604` → `checkerpool.go:347-355`），并用 `sync.Pool` 复用 `EmitTextWriter`（`program.go:1834-1837`）。
- 阶段归因：发射是 C# 侧最大且差距最大的阶段（huge-file 6.22×、占其总时间 66%；512 文件占 78%）。排除发射后整体差距从 1.81–1.89× 掉到 1.15×。

**改动（已实现，约 60 行，2 个文件）**
1. `IncrementalProgram.EmitCoreAsync`：把"边判边发"的循环拆成
   - **串行收集**阶段：仍按源文件顺序判定 `pending`、缓存命中、`SourceFileMayBeEmitted`，产出 `work` 列表（保持原有语义与快路径）；
   - **并行发射**阶段：`Parallel.ForAsync(0, work.Count, new ParallelOptions { MaxDegreeOfParallelism = workers })`，每个工作项 `using var lease = await pool.AcquireAsync(file.Syntax)` 借出**该文件所属分区**的 checker，再调用 `Program.EmitWithCheckerAsync(..., lease.Checker, ...)`；
   - **串行合并**阶段：按 `work` 顺序回填 `errors / emitted / maps / snapshot.EmitDiagnostics / snapshot.PendingEmit`，因此**诊断与文件列表顺序与上游完全一致**。
2. 并发度取 `min(checker 池大小, 待发射文件数)`；`Options.SingleThreaded` 时退回串行；`TSHARP_EMIT_CONCURRENCY` 仅用于 A/B 测量（1 = 上游行为）。
3. `Write` 回调中对 `snapshot.Files / EmitSignatures / LatestChangedDeclaration / BuildInfoPending` 的读改写加 `lock (writeGate)`；文件写入发生在锁外（`PhysicalFileSystem.WriteFile` 是无状态且对不同路径并发安全）。

**收益（实测，不是推算）**

| 负载 | 上游 | 原型 | 变化 | 同批次 Go | 相对 Go 变化 |
| --- | ---: | ---: | ---: | ---: | --- |
| medium | 295.3 | **200.1** | **−32.3%** | 93.6 | 3.14× → **2.09×** |
| declarations | 214.1 | **175.3** | **−18.1%** | 89.6 | 2.54× → **2.10×** |
| 512 文件 | 469.3 | **322.8** | **−31.2%** | 245.5 | 1.81× → **1.28×** |
| 512 文件增量编辑 | 510.1 | **367.3** | **−28.0%** | 264.4 | 1.89× → **1.33×** |
| tiny-files --noEmit | 148.9 | 150.9 | +1.3% | 117.4 | 无发射工作，中性 |
| huge-file（单文件） | 1414.6 | 1424.5 | +0.7% | 382.9 | 单文件无并行空间，中性 |

同一二进制内 A/B（`TSHARP_EMIT_CONCURRENCY=1` vs 自动）复现了同样的量级：medium −34.5%、512 文件 −30.4%、declarations −24.9%、增量 −29.6%、huge-file −0.9%。

**代价（实测）**：CPU 时间上升 15–35%（tiny-files 515.6 → 593.8 ms），**峰值内存不变**（medium 127.0 → 127.6 MiB；512 文件 48.6 → 52.1 MiB）。这是"用空闲核换时延"的正确定价。

**正确性证据**：驱动在每一对样本上对**退出码、stdout、发射文件字节**做逐字节比对（排除 `*.tsbuildinfo`），并对成功编译夹具要求退出码 0；AB10/AB11/AB12 共 37 组配对 × 6 个含发射负载全部通过。

**生产化前必须补的硬化项（按风险排序）**
1. `CompilationCapture.Current` 是 `AsyncLocal`，会流入并行工作项；`--generateTrace`/profiling 场景下 `Begin` 会被并发调用 → 需要把 trace 写入串行化或改为 per-thread buffer。（普通编译 `ambient.Value == null`，不受影响。）
2. `options.WriteFile` 是宿主回调（API/LSP 宿主），必须声明为"可并发调用"或在内部串行化。
3. `writeGate` 目前是全局单锁；如果 `Options.Composite` 下声明哈希成为热点，可改为按 source 分片锁。
4. 增量场景的 `snapshot` 变更多于非增量，需要专项回归（`tiny-incremental` 已通过，但要覆盖 `--build` 项目引用与 watch）。
5. 与大发射文件并存的**内存峰值**：并行度提高后输出缓冲区同时驻留的数量上升，需要用 `ArrayPool` 池化并在 512 文件以上负载验证 RSS（本次 11 组样本未观察到上升）。

**验证方法**：`AB10` 形式（上游 vs 原型，11 组配对，`medium|declarations|tiny-files|tiny-files-noemit|tiny-files-incremental-edit|huge-file`）+ 全量 23 项 CLI 套件 21 组样本 + `--build` 项目引用与 watch 回归。

**依赖**：无（可立即落地）。**预计总收益占本方案全部收益的 40–50%。**

---

### WS2 检查与分区的并发扩容、均衡与去 async 化（P0/P1）

**证据**
- 两侧默认 checker 数都是 4（Go `checkerpool.go:86`；C# `CheckerPool.cs:10`），`--checkers` 1→8 只带来 13%（Go 128.8→106.8 ms）与 13%（C# 386.7→337.4 ms）的改善，说明**收益被分区不均或合并开销吃掉**。
- 并行发射落地后 medium 的并行度从 1.21× 升到 1.88×（CPU 375 ms / 墙 200 ms），仍低于 Go 的 2.81×。
- 剖析显示大量线程在 `TimedWait`/`WaitForMultipleObjectsIgnoringSyncContext`（CLI 场景没有真实 I/O，等待来自 async 调度层）。

**改动**
1. **默认 checker 数自适应**：`Options.Checkers ?? Math.Clamp(Environment.ProcessorCount / 2, 4, 16)`，并在 `--checkers 0` 时走同一自动路径；配合 `CheckerPool` 上限 256 的现有约束。**本次已实测出最优档位：8**（见下表），16 反而更差。
2. **按工作量分区**：`CheckerPartitions.ForProgram` 目前按文件数分区，改为按"文件字节数 + 已绑定的符号数"加权，并用 LPT（最长处理时间优先）分配，直接压缩尾部（多文件负载的总时间由最慢分区决定）。
3. **合并阶段瘦身**：检查器分组完成后对每个 checker 的诊断做全局合并与去重（"Later files can add diagnostics to earlier files"），改为一次归并 + 去重，避免二次全表遍历。
4. **去 async 化**：把 `Task.Run(() => CheckGroupAsync(index))` + 每文件 `Task` 的调度改为 `Parallel.For` 同步体（CPU 密集、无真 I/O），消除状态机与线程池注入延迟；仅在真正 I/O（读文件/写盘）处保留 `async`。
5. **检查器状态复用**：增量 pass 之间复用已绑定状态（仓库已有 partial 基础，`phase4` 有 incremental checker reuse 的既有实测 −20.3~−29.4%，可扩展到发射路径）。

**本次实测的 checker 数标定**（并行发射原型，9 组配对，同一二进制只改 `--checkers`）：

| 负载 | 1 | 4 | **8** | 16 | Go | 峰值 RSS 1→16 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 512 文件 | 438.8 | 309.8 | **304.1** | 315.4 | 238.7 | 42.1 → 51.0 MiB | 4→8 仅 −1.8%，8 之后回退 |
| medium | 310.5 | 190.5 | **175.8** | 191.9 | 90.6 | 56.9 → 61.9 MiB | 4→8 **−7.7%**，16 回退 +9.2% |
| declarations | 233.1 | 167.7 | **154.7** | 168.6 | 84.8 | 53.3 → 59.3 MiB | 4→8 **−7.8%**，16 回退 +9.0% |

**收益模型（已实测锚定）**：把默认值从 4 提到 **8** 可直接获得 medium −7.7%、declarations −7.8%；继续提到 16 是**负收益**。分区均衡与合并瘦身按中等强度估计再取 −3~−5%。
**同时必须接受的内存代价**：RSS 随 checker 数上升（medium 56.9 → 61.9 MiB，+9%；512 文件 +21%），在 8 档位上 C# 的 RSS 与 Go 持平（60.3 vs 59.9 MiB / 48.7 vs 51.5 MiB）。**门禁：8 档时 RSS ≤ Go×1.05。**

**验证**：`--checkers 1/2/4/8/16` 的配对缩放曲线（本次已建立 `concurrency-scaling.mjs` 工具与基线）。

---

### WS3 模块解析与程序构建：真实工程的主战场（P1）

**证据**
- 真实工程（`packages/typescript`，186 文件 / 51,665 行，含 2.3 MB `lib.dom.d.ts`）：墙面 2.28–2.50×；C# 自报 `Program time 153 ms`（Parse 求和 118 ms + Bind 求和 80 ms，Total 221 ms）vs Go `Parse 32 ms / Total 44 ms`；该负载**不触发检查与发射**（`Check time 0.000 / Emit time 0.000`）。
- 即：**真实工程的瓶颈在"加载 + 模块解析 + 绑定"，而不是发射**（发射只在小文件海量场景占主导）。这与 512 文件夹具的结论互补，说明必须两条腿走路。

**改动**
1. **模块解析并行化**：检查 `CompilerProgram.cs:537` 的 `pending/scheduled` 调度，确认 `ModuleResolver` 的解析（含 `package.json` 读取与 `node_modules` 遍历）是否在并行区内；若在串行段，改为按目录作用域并行 + 全局缓存（`resolvers` 已按目录缓存，但首次命中仍需 I/O）。
2. **文件系统访问批量化**：`PhysicalFileSystem.ReadFile` 每次 `File.ReadAllBytes`；对大 lib 文件使用内存映射或共享缓冲；对同一目录的多次 `Stat` 做目录级缓存。
3. **绑定热路径**：`Binder` 的每文件状态分配（`Dictionary` 创建）+ `CheckerSymbols.Binding` 的父链遍历（307 处调用点）。
4. **Utf8String 键的字典**：长路径字符串每次哈希；可缓存哈希值（`Utf8String` 已有内容，考虑在 program 构建期缓存哈希到 (`interned index`, `hash`) 映射表）。
5. **配置期复用**：lib.*.d.ts 的加载与配置解析结果在进程内复用（CLI 单次进程只能省一次，但对 watch/LSP/API 常驻是重复收益）。

**收益模型**：真实工程 2.3× → **1.5–1.8×**；512 文件负载的"配置期 41 ms + 程序构建"部分同步受益。

**风险**：模块解析涉及并发下的缓存一致性（需幂等 + 不可变快照）。

---

### WS4 分配削减：同时降时延与降内存（P0/P1）

**证据**
- huge-file：C# 累计分配 **931 MB**（存活 93.9 MB），**43 KB / 行源码**；Go 约 300 MB（7 次 GC，GC CPU ≤3%）。
- 成本直接可见：`DOTNET_GCHeapHardLimit=256 MiB` 让 medium −16%；Server GC 多出 39% 进程 CPU 而不更快。
- 既有可比先例：符号声明列表从 `ImmutableArray.Add` 改为紧凑结构后**分配 −3.0~5.7%**（`docs/csharp-phase-4-symbol-declarations.md:9-16`）；tiered 阶段的一轮分配削减带来 **分配 −25.7~27.8%**（`docs/csharp-phase-4-tiered-performance.md:3`）。
- 反面教材：phase-1 的"typed AST arena"原型**慢 18.5%**（`docs/csharp-phase-0-1-results.md:31-36`）——所以 arena 必须重新设计，不能照搬 Go 的做法。

**改动（按收益/风险排序，前 4 项建议立即做）**
1. **去掉签名/类型构造的容器包装**：`Checking/TypeContext.cs:385,387` 每签名 2×`ToArray` + 2×`AsReadOnly`；`Checking/` 下共 42 处 `Array.AsReadOnly`。改为"数组 + 长度"或复用只读视图缓存。
2. **池化所有临时缓冲**：`ArrayPool<byte>`/`ArrayPool<char>` 用于发射缓冲、诊断列表、临时集合；输出 writer 复用（对齐 Go 的 `sync.Pool` `EmitTextWriter`）。
3. **数字字面量文本缓存**：Go 有 `numberCache`/`hexNumberCache`（`scanner.go:2190-2202,714-726`）；C# 每个数字字面量都 `TryFormat + Utf8String.Copy`（`Syntax/TokenFacts.cs:36-52`，36 处调用）。huge-file 有 16,384 个数字字面量，直接命中。
4. **LOH 治理**：>85 KB 的缓冲（大文件的发射/源码缓冲）会进 LOH；改为分片 + 池化，并按负载标定 `GCLOHThreshold`（WS5）。
5. **高频 AST 节点分段 arena**：只对 Go 已 arena 化的 51 种高频节点（`ast_generated.go:628,601`），按 SyntaxKind 分桶 slab 分配；**要求**：(a) 保留引用类型可见性以避免写屏障失效，(b) 与服务端长驻场景兼容（arena 生命周期 = program），(c) 必须与 phase-1 原型做对照实验解释 18.5% 的回退原因。
6. **消除闭包分配**：剖析中出现 `Checker+<>c__DisplayClass1704_0` 等显示类，说明热路径有 lambda 捕获；对 204 处 `Symbols.Declaration(` / 103 处 `Symbols.Binding(` 这类高频回调改为静态方法 + 显式状态结构。
7. **紧凑化 AST 容器**：`NodeList` / `ImmutableArray` 的每节点数组分配，改为可增长的分段列表或 arena 数组。

**目标**：累计分配 **931 MB → ≤400 MB（−57%）**，进一步 ≤250 MB。
**收益**：分配下降直接转化为 GC 次数、写屏障成本与缓存局部性；按"256 MiB 硬限制 −16%"与"tiered 轮次 −25.7% 分配"两个锚点推算，**时延 −10~20%、峰值 RSS −20~30%**。
**验证**：`--extendedDiagnostics` 的 `CLR allocated bytes`（每次构建可复现）+ `dotnet-counters` 的 `alloc-rate/gen-0-count/%time-in-gc` + 配对时延。

---

### WS5 GC 与内存上限工程（P0/P1）

**证据（全部为本次实测）**
| 实验 | 结果 |
| --- | --- |
| WKS ↔ SVR（同代码） | WKS 在 medium/declarations/512 文件上快 **5.1–10.6%**，huge-file 慢 7.2%；**WKS 峰值内存只有 SVR 的 44–66%**（55.5 vs 126.5 MiB / 238 vs 321 MiB） |
| `GCHeapHardLimit=256 MiB`（仓库既有夹具档） | medium **−16%** |
| Server GC 的 CPU 记账 | huge-file 1656 ms（WKS）→ 2578 ms（SVR），墙上无改善 |
| Go 侧 GC 成本 | 7 次 GC，CPU 0–3% |

**改动**
1. **默认 WKS GC**；仅在显式 `--gc-server` 或（≥16 逻辑核且工作集目标宽松）时启用 SVR。
2. **把 `GCgen0size` 调小**（本次实测的最优内存杠杆）：`DOTNET_GCgen0size=0x400000`（4 MB）在 **不损失时间** 的前提下把峰值 RSS 降低 17–19%。
3. **调高 `GCLOHThreshold`**（`=1000000`，1 MB）：huge-file 峰值 RSS **−13.1%** 且时间 −3.4%；medium/declarations −2~−4%；512 文件 +6.8%（需要按负载权衡）。
4. **自适应内存上限**：按可用物理内存与目标常驻设置 `GCHeapHardLimit`（256 MiB 档已实测 medium −16%）。
5. **输出缓冲池化**以减少 LOH 和系统调用。
6. **AOT 侧**：确认 `OptimizationPreference=Speed`（已是），并保持便携指令集基线（实测 native 无收益，却增加镜像体积与启动分页）。

**本次实测的 GC 参数标定（同一二进制，仅环境变量不同，11 组配对）**

| 参数 | medium | declarations | 512 文件 | huge-file | 峰值 RSS 变化 | 判定 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `GCgen0size=0x400000` | +0.9% | −1.3% | +0.4% | **−4.7%** | **−19.2% / −19.3% / −16.7% / −8.3%** | **推荐（纯赚）** |
| `GCLOHThreshold=1000000` | −0.8% | −1.8% | +3.5% | −3.4% | −2.4% / −3.8% / **+6.8%** / **−13.1%** | 推荐（按负载） |
| `GCgen0size+GCLOHThreshold` | +0.3% | −1.6% | +1.0% | 见下 | −20.9% / −21.1% / −17.0% | 推荐组合 |
| `GCConserveMemory=9` | +4.1% | −0.3% | +0.8% | **+16.1%** | −0.2% / 0.0% / +0.1% / **−21.1%** | 仅内存极限场景 |
| `GCConserveMemory=9+LOH+gen0size` | +0.3% | −1.6% | +1.0% | **+14.8%** | −20.9% / −21.1% / −17.0% / **−26.3%** | 不推荐（huge-file 明显变慢） |
| Server GC + `GCHeapCount=8,GCNoAffinitize=1` | **−9.4%** | **−19.1%** | +3.3% | −0.9% | **+36.8% / +2.2% / +216.7% / +137.6%** | **不推荐**（内存失控） |

**结论（TL;DR）**：**"Workstation GC + 更小的 gen0 预算 + 更高的 LOH 阈值"是纯赚组合**（memory −17~21%、时间 0~−5%）；而 `GCConserveMemory` 与被广泛推荐的"限制 Server GC 堆数"在本机都是**以巨大内存或巨大时间换来的**，应放弃（仓库既有报告曾推荐 Server GC，那是 24 核 i7 的结论，本机 32 逻辑核下不成立 —— **GC 配置必须按机器标定，并在发布时按 `ProcessorCount` 选择**）。

**收益**：内存 **−17~21%（相对 WKS 基线）**、相对 SVR 则 **−55~65%**；启动 **−16%**（1.30× → 1.09×）。
**风险**：`GCgen0size` 过小会增加 GC 次数（实测 4 MB 无时间代价，但更小需重新标定）；`GCLOHThreshold` 提高会让大对象留在 gen0，在极端分配速率下可能增加 gen0 压力（512 文件 +6.8% RSS 即为此现象）。

---

### WS6 启动关键路径与 I/O（P1）

**证据**
- AOT 启动 65 ms vs Go 50 ms（`--version` 比值 1.09×）。
- 512 文件负载的**配置期 41 ms**（C#）vs 1 ms（Go）—— 这是每次进程都要付的固定成本。
- 本次为了"公平对比"两侧都关闭了内嵌标准库（Go `-tags=noembed`、C# `-p:EmbedTypeScriptLibraries=false`），**但产品形态不应该这样发**。

**改动**
1. **重新开启标准库内嵌**（`EmbedTypeScriptLibraries=true`，等价于 Go 的 `go:embed`），把 108 个 `lib.*.d.ts` 编进镜像：消除每次进程的文件系统遍历/读取/解析固定成本（估计 20–40 ms 从 512 文件与真实工程负载上消失）。
2. **静态表惰性化/折叠**：`Diagnostics/Messages.generated.cs:205,2219` 的 2213 个字段初始化 + `ToFrozenDictionary`；`Configuration/LocaleIdentifier.generated.cs:10-444` 的 4 个 `FrozenSet` 字面量；`Text/Utf8Literals.cs:6-601` 的 595 条字面量。
3. **启动期并行**：配置解析与库加载重叠；`Hosts/LibraryFileSystem.cs:15-19` 的清单资源反射改为生成式表。
4. **镜像裁剪**：`PublishTrimmed`/ILC 的 metadata 裁剪（注意与 `UnsafeAccessor`/反射点的兼容，需 AOT 门禁）。

**收益**：启动 **−10~20 ms（→ ≤1.05× Go）**；多文件负载再 **−5~10%**。

---

### WS7 单核效率：huge-file 与检查阶段的唯一出路（P1/P2）

**证据**：huge-file 发射 6.22×、检查 3.31×、绑定 2.03×、解析 1.45×；且其进程 CPU 是 Go 的 **5.5×**（WKS 下口径最干净）。这是**没有并发可借**的纯效率差距。

**改动**
1. **打印器**：`Emission/EmitContext.cs:33-169` 对同一 `Dictionary<SyntaxNode,NodeData>` 每节点探测 5 次 → 合并为一次取回结构；`Part`（约 120 B）工作列表缩小并在文件间池化；`SyntaxPrinter.cs:34,47-51,371-385` 的 `Part[]`/`List<Part>` 每次分配改为池化。
2. **子节点访问**：`Ast/SyntaxNode.cs:75-77`、`Ast/Nodes.generated.cs:198-205` 的 `GetChild(i)`/`ChildCount` 是 O(C²)（每次重走 null 链 + 抛异常路径），被 binder 与 22 处 checker 子树扫描使用 → 生成式 `ForEachChild`（Go 用 `ast_generated.go:843-845` 的直接字段遍历）。
3. **符号查找**：`Checking/CheckerSymbols.cs:102-115` 的父链遍历 + 2 次字典探测（307 处调用）→ 节点内联槽位。
4. **检查器容器**：`Checking/Types.cs:43,202,278-279,403` 等的 `ReadOnlyCollection`/`ImmutableArray` → 数组 + 长度。
5. **扫描器**：`Syntax/Scanner.cs:41` 的 `Char()` 每次派生 span；数字扫描走缓存（WS4-3）。

**收益**：huge-file **2.60–3.00×（P1）→ 1.90–2.30×（P2）**；medium 检查阶段 −10~20%。

---

### WS8 服务 / 增量 / watch 常驻路径（P1）

**证据**：仓库既有服务负载比值 1.30–14.22×，其中 LSP 启动 14.22×、junction 解析 13.39–14.13× —— 绝大多数来自启动与 JIT，AOT + R2R 可直接消掉一大半；增量编辑本次实测 1.89×，WS1 已把它降到 1.33×。

**改动**
1. 常驻进程一律 NativeAOT（或 R2R 兜底），并复用 AOT 启动优化（WS6）。
2. 常驻 checker 池 + 快照复用（WS2-5），内存以 `GCHeapHardLimit` 与池大小上限约束。
3. watch/LSP 的文件监视与内容映射走批量事件合并，避免每次 edits 触发全量重建（仓库已有增量基础）。
4. 为服务形态单独设 RSS 门禁（长时运行不得持续增长）。

---

## 4. 优先级排序（收益 / 投入 / 风险）

| 优先级 | 工作流 | 实测/预期时延收益 | 实测/预期内存收益 | 投入 | 风险 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **P0-1** | WS1 发射并行化 | **实测 −18~−34%**（多文件） | 中性（127.0→127.6 MiB） | 中（约 60 行） | 中 | **原型已完成并验证** |
| **P0-2** | WS5 GC 标定（WKS + `GCgen0size` + `GCLOHThreshold`） | **实测 −1~−7%** | **实测 −17~21%（相对 WKS）；相对 SVR −55~65%** | 低 | 低 | **已标定出推荐参数** |
| **P0-3** | WS4-1..4 分配快赢（去包装/池化/数字缓存/LOH） | 预期 −8~−15% | 预期 −10~−20% | 低-中 | 低 | 待做 |
| **P0-4** | WS6-1 重新内嵌标准库 + 静态表惰性化 | 预期 −5~−10%（多文件）、启动 −15% | 略增镜像、降 I/O | 低 | 低 | 待做（注意：本次为了公平对比两侧都关掉了内嵌，产品形态应开启） |
| **P1-1** | WS2 检查并发扩容/均衡/去 async | **实测 checker 4→8 = −7.7%**，加分区均衡预期 −10~−15% | 增（8 档 RSS ≈ Go，需门禁） | 中 | 中 | 部分已实测 |
| **P1-2** | WS3 模块解析与程序构建 | 预期 真实工程 −25~−35% | 预期 −5~−10% | 高 | 中 | 待做 |
| **P1-3** | WS7-1/2/3 打印器与子节点访问 | 预期 huge-file −15~−25% | 预期 −5~−10% | 中 | 中 | 待做 |
| **P2-1** | WS4-5/6/7 arena 与闭包消除 | 预期 −5~−15% | 预期 **−15~−25%** | 高 | **高** | 需先解释 phase-1 原型 −18.5% 的原因 |
| **P2-2** | WS7-4/5 检查器容器与扫描器 | 预期 −5~−10% | −5% | 高 | 中 | 待做 |
| **P2-3** | WS8 服务常驻优化 | 服务形态 −20~−40% | 门禁 | 中 | 中 | 待做 |

**总收益的叠加关系不是简单相加**：WS1 与 WS2 都作用于同一条关键路径（发射/检查），叠加时应按"关键路径剩余量"折算（本方案的目标态预测已做此折算）。

### 4.1 P0 合并清单（可直接进入评审的最小改动集）

**代码改动（当前在 worktree `C:\ai\projects\typescript-cs` 上，`git diff` 共 2 个文件 / +96 −34 行）**

| 文件 | 改动 | 目的 |
| --- | --- | --- |
| `csharp/src/TypeScript.Compiler/Incremental/IncrementalProgram.Emit.cs` | 串行 `foreach+await` → "串行收集 + `Parallel.ForAsync` 并行发射（按文件借用 `CheckerPool` 租约）+ 串行按序合并"；`Write` 回调中的快照读改写加 `writeGate` | **WS1**，实测 −18~−34% |
| `csharp/src/TypeScript.Compiler/Programs/CompilerProgram.cs` | `CreateAsync` 的 `concurrency` 默认值 4 → 0（自动），Builder 解析为 `ProcessorCount`，支持 `TSHARP_PARSE_CONCURRENCY` 覆盖 | **仅用于测量**（已证伪，不应合入；建议回退，保留 4 以省内存） |

> 也就是说：**真正需要合入的只有第一个文件**；第二个文件是本次用于证伪"解析并发上限"假设的实验开关，结论是不做。

**发布配置改动（零代码）**
- `PublishAot=true` + `ServerGarbageCollection=false`（Workstation GC）。
- CLI 启动时设置 `DOTNET_GCgen0size=0x400000`、`DOTNET_GCLOHThreshold=1000000`（实测内存 −17~21%、时间 −1~−7%）。
- `--checkers` 默认值 4 → 8（实测 medium −7.7%、declarations −7.8%；16 为负收益）。
- 若必须框架依赖：强制 `PublishReadyToRun=true`（实测启动 −64%）。

---

## 5. 目标态预测（含推导）

**P0 列现在是实测值**（P0 候选 = 发射并行化 + Workstation GC，AB19，15 组配对）；P1/极限列为推算：

| 负载 | 原基线 | **P0（实测）** | P1（+WS2/WS3/WS7） | 极限（+WS4-arena/WS8） |
| --- | ---: | ---: | ---: | ---: |
| `--version` 启动 | 1.09–1.30× | **1.13×** | 1.03–1.06× | ≈1.00× |
| 512 文件 `--noEmit` | 1.15× | **1.17×** | 1.02–1.05× | ≈1.00× |
| 512 文件完整编译 | 1.81× | **1.33×** | 1.10–1.18× | 1.02–1.06× |
| 512 文件增量编辑 | 1.89× | **1.37×** | 1.12–1.20× | 1.02–1.08× |
| medium 64 模块 | 3.14× | **2.10×（8 checker：1.94×）** | 1.45–1.65× | 1.15–1.30× |
| declarations | 2.54× | **1.93×** | 1.35–1.55× | 1.10–1.25× |
| project-references | 1.44–1.69× | **1.28–1.45×** | 1.05–1.15× | ≈1.00–1.05× |
| 真实工程 186 文件 | 2.28–2.50× | ≈2.0×（同族改动） | **1.35–1.60×** | 1.10–1.25× |
| 单巨文件 16k 声明 | 3.61–3.86× | **3.86×** | **2.40–2.70×** | 1.80–2.10× |
| medium 峰值 RSS | 55.5 MiB | **59.9 MiB（Go 60.5）** | ≤58 MiB | ≤55 MiB |
| 512 文件峰值 RSS | 41.3 MiB | **45.3 MiB（Go 50.9）** | ≤48 MiB | ≤48 MiB |
| huge-file 峰值 RSS | 238 MiB | **193 MiB（含 GC 调优，Go 164）** | ≤180 MiB | ≤170 MiB |
| huge-file 累计分配 | 931 MB | 931 MB | ≤400 MB | ≤250 MB |

**推算依据（每个非实测格子的锚点）**
- **P0 的实测已经把"发射并行 + WKS GC"的收益全部兑现**：medium −33%、512 文件 −27%、declarations −24%、增量 −28%、project-references −10~−16%，启动与 `--noEmit` 基本不动（这两者与发射无关）。
- P1 的 medium 1.94→1.45：剩余差距的结构是"检查阶段每核效率 + 分区尾部"。锚点：(a) `--checkers 8` 实测 −7.7%；(b) 分区均衡/合并瘦身按 −5%；(c) WS7 的打印器与子节点访问按 −10%；(d) WS6 内嵌标准库按 −5%。
- P1 的单巨文件 3.86→2.40：WS7-1（打印器：每节点 5 次字典探测→1 次、`Part` 池化、writer 复用）与 WS7-2（O(C²) 子节点访问）在发射段取 −25~30%，检查段取 −10~15%（锚点：huge-file 检查阶段 C# 324 ms vs Go 98 ms，3.31×）。
- 极限列的 huge-file 1.80–2.10：需要 WS4 的分配削减（931→250 MB，锚点：`GCHeapHardLimit=256 MiB` 让 medium −16%、tiered 轮次分配 −25.7% 对应时间 −2~17%）真正落地。
- 内存：AB18 已实测 `GCgen0size+GCLOHThreshold` 让 huge-file RSS 238→193 MiB、medium 55.5→43.8 MiB；WS4 的分配削减预计再降 10–15%（存活集 93.9 MB 是硬下界）。

---

## 6. 验证与门禁协议（每一处改动都必须这样证明）

**三层门禁，任何一层不过就不算完成。**

1. **正确性门禁**
   - 官方驱动对**每一对样本**比对退出码、stdout、发射文件字节（排除 `*.tsbuildinfo`），成功编译夹具必须退出码 0；
   - 23 项 CLI 套件全绿 + `--build` 项目引用 + watch 回归；
   - 诊断计数与来源一致（本报告所有批次均已满足）。
2. **性能门禁**
   - 必须用**同批次配对**（交替顺序）+ ≥11 组有效样本 + 成对 bootstrap 95% CI；
   - 参照控制：**同一个二进制自我配对的偏差必须 ≤1.1%**（本次 AB8 已建立：medium 1.003、declarations 1.011、tiny 0.984、huge 1.009）；
   - 只有在 CI 完全落在 1.0 一侧时才认定"有效"；落在噪声内的改动一律判为无效（本次 AB6/AB7/AB9 就是这么被判掉的）。
3. **内存门禁**
   - 记录每负载的峰值 RSS 与 `CLR allocated bytes`；
   - 线：medium ≤ Go×1.1、huge-file ≤ Go×1.3、常驻服务长跑不增长。

**方法学硬性要求**
- 每项优化落地前先做**同二进制 A/B**（环境变量或开关控制新旧路径），避免"批次间漂移"污染结论（本次已用 `TSHARP_EMIT_CONCURRENCY`、`--no-gc-env`、`--after-env` 做到）。
- 禁止在测量期间进行构建/测试（本次所有批次均为独占测量）。
- 记录运行环境（本机存在持续桌面负载与每秒合成输入，因此**绝对时间不可跨机比较，只比较同批次比值**）。

---

## 7. 反模式与"已证伪"清单（避免返工）

| 方向 | 结论 | 证据 |
| --- | --- | --- |
| 提高解析/绑定并发上限（4 → 8/32/ProcessorCount） | **无效** | AB6（4 vs 32：medium +2.4%、tiny +0.2%、huge +0.7%、noemit −1.5%）、AB7（4 vs 8：全部 ≤2%）、AB9（端到端 CI 全部覆盖 1.0）；原因：512 文件解析求和仅 8 ms |
| `IlcInstructionSet=native` / `GOAMD64=v3` | **无效** | AB1（Go +1.7%~−0.5%）、AB2（C# +2.8%~−0.5%） |
| 无条件启用 Server GC | **负收益** | AB3：medium +7.0%、declarations +10.6%、tiny +5.1%，内存 2×；仅 huge-file −7.2% |
| 关闭 tiered+PGO | **负收益**（长单文件除外） | AB5：version +36%、medium +30%、tiny +44%；huge-file −26% |
| 在 parser/binder/checker 引入 async | **已关闭** | 仓库既有：runtime-async 已开且状态机为 0；常规 async 在 AOT 下慢 30–53%；同步 binder 无收益已回滚 |
| 全局 typed AST arena（phase-1 原型） | **慢 18.5%** | `docs/csharp-phase-1-results.md`；本方案改为按 Kind 分段 + 先行对照实验 |
| 递归栈池化 / NodeList 结构体枚举 / 每扫描器标识符驻留 | **无收益或更慢** | 仓库既有实验记录 |
| 盲目并行"一切" | **错误** | 本次证明：解析并行无收益、发射并行 −30%、而并行发射会 +15~35% CPU；必须按关键路径选择并行对象 |

---

## 8. 附录：本次新增实测的完整数据

### 8.1 并行发射原型（AB10：上游构建 vs 原型；AB12：同一二进制内 串行→并行）

| 负载 | AB10 上游 | AB10 原型 | Δ | AB10 RSS 上游/原型 | AB12 串行 | AB12 并行 | Δ | AB12 CPU 串行/并行 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
| medium | 295.3 | 200.1 | **−32.3%** | 126.4 / 126.3 MiB | 314.9 | 206.2 | **−34.5%** | 375.0 / 375.0 |
| declarations | 214.1 | 175.3 | −18.1% | 120.6 / 122.7 | 226.4 | 170.0 | −24.9% | 234.4 / 265.6 |
| tiny-files | 469.3 | 322.8 | **−31.2%** | 48.1 / 53.6 | 470.8 | 327.9 | −30.4% | 515.6 / 593.8 |
| tiny-files-incremental | 510.1 | 367.3 | −28.0% | 53.0 / 55.2 | 514.4 | 362.3 | −29.6% | 562.5 / 625.0 |
| tiny-files-noemit | 148.9 | 150.9 | +1.3% | 38.7 / 39.2 | 141.1 | 146.3 | +3.7% | 156.2 / 171.9 |
| huge-file | 1414.6 | 1424.5 | +0.7% | 322.9 / 322.4 | 1410.6 | 1398.3 | −0.9% | 2359.4 / 2281.2 |

### 8.2 原型相对 Go（AB11，15 组配对，噪声 6.1%）

| 负载 | Go | 原型 | 比值 | 上游基线比值 | Go RSS | 原型 RSS | Go CPU | 原型 CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 93.6 | 195.3 | **2.09×** | 3.02–3.14× | 60.3 | 124.7 | 234.4 | 375.0 |
| declarations | 89.6 | 187.9 | **2.10×** | 2.42–2.54× | 54.9 | 113.8 | 187.5 | 250.0 |
| tiny-files | 245.5 | 314.2 | **1.28×** | 1.77–1.81× | 50.9 | 52.8 | 734.4 | 593.8 |
| tiny-files-incremental | 264.4 | 351.9 | **1.33×** | 1.89× | 64.4 | 59.5 | 875.0 | 625.0 |
| tiny-files-noemit | 117.4 | 147.6 | 1.26× | 1.15× | 40.1 | 39.4 | 296.9 | 156.2 |
| huge-file | 382.9 | 1389.0 | 3.63× | 3.61× | 162.6 | 328.8 | 437.5 | 2296.9 |

> 内存列说明：原型是用 **Server GC** 发布的（与 R1 基线同族），因此 medium/huge-file 的 RSS 仍是 SVR 水平（124.7 / 328.8 MiB）。按 AB3 的实测，改用 Workstation GC 后这两项可降到约 55 / 238 MiB，即 **与 Go 持平或更好**。

### 8.3 GC 参数标定（AB13–AB18）

见 WS5 的完整表格（时间与峰值 RSS 双向数据）。要点：`GCgen0size=4 MB` 纯赚（RSS −17~19%、时间 0~−5%）；`GCLOHThreshold=1 MB` 在 huge-file 上 RSS −13.1%、时间 −3.4%；`GCConserveMemory=9` 与 `GCHeapCount=8+GCNoAffinitize=1` 均被实测否决。

### 8.4 并发缩放曲线（批次 6）

| 负载 | `--checkers 1` | `4` | **`8`** | `16` | Go | RSS 1→16 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 512 文件 | 438.8 ms (484 CPU, 42.1 MiB) | 309.8 (546.9, 44.6) | **304.1 (578.1, 48.7)** | 315.4 (625.0, 51.0) | 238.7 (781.3, 51.5) | +21% |
| medium | 310.5 (281.3, 56.9) | 190.5 (406.3, 59.1) | **175.8 (343.8, 60.3)** | 191.9 (562.5, 61.9) | 90.6 (171.9, 59.9) | +9% |
| declarations | 233.1 (203.1, 53.3) | 167.7 (281.3, 56.2) | **154.7 (265.6, 55.7)** | 168.6 (328.1, 59.3) | 84.8 (281.3, 55.4) | +11% |

**读数**：最优在 **8**（不是 4，也不是 16）；C# 在 8 档的峰值 RSS 已经与 Go 相当（60.3 vs 59.9 MiB、48.7 vs 51.5 MiB）；但 medium 上 C# 的 CPU（343.8 ms）仍是 Go（171.9 ms）的 2.0 倍 —— **并发解决的是"墙"，每核效率仍需 WS7**。

### 8.5 P0 候选全量结果（AB19：并行发射 + Workstation GC vs Go，15 组配对，噪声 9.8%）
| 工作负载 | Go | P0 候选 | 比值 | 95% CI | RSS Go | RSS P0 | CPU Go | CPU P0 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| help | 47.3 | 54.1 | 1.14 | 1.10–1.16 | 10.8 | 11.5 | 15.6 | 15.6 |
| version | 46.1 | 52.3 | 1.13 | 1.12–1.14 | 10.6 | 10.9 | 15.6 | 15.6 |
| empty-project | 47.7 | 56.5 | 1.19 | 1.17–1.21 | 12.2 | 13.7 | 15.6 | 31.2 |
| small-first-diagnostic | 51.9 | 65.6 | 1.26 | 1.24–1.28 | 18.6 | 18.9 | 31.2 | 31.2 |
| medium | 91.3 | 191.7 | **2.10** | 2.05–2.15 | 60.5 | **59.9** | 281.2 | 375.0 |
| declarations | 84.9 | 164.2 | **1.93** | 1.87–1.97 | 55.3 | 56.2 | 203.1 | 250.0 |
| tiny-files | 230.2 | 305.5 | **1.33** | 1.29–1.34 | 50.9 | **45.3** | 593.8 | **562.5** |
| huge-file | 379.6 | 1464.2 | **3.86** | 3.81–3.92 | 164.2 | 238.0 | 453.1 | 1453.1 |
| host-paths | 52.5 | 93.2 | 1.77 | 1.75–1.79 | 19.4 | 20.8 | 31.2 | 62.5 |
| tiny-files-noemit | 117.4 | 137.4 | 1.17 | 1.13–1.20 | 40.0 | **37.2** | 281.2 | **171.9** |
| tiny-files-noemit-on-error | 236.9 | 307.3 | 1.30 | 1.28–1.33 | 55.6 | **44.5** | 640.6 | **578.1** |
| tiny-files-incremental-edit | 253.0 | 346.1 | 1.37 | 1.31–1.39 | 64.7 | **49.1** | 750.0 | **578.1** |
| medium-checkers-1 | 106.0 | 301.4 | 2.84 | 2.79–2.94 | 57.6 | 57.0 | 265.6 | 281.2 |
| medium-checkers-2 | 94.4 | 221.8 | 2.35 | 2.27–2.39 | 60.0 | 59.1 | 281.2 | 296.9 |
| medium-checkers-4 | 92.1 | 189.6 | 2.06 | 1.98–2.10 | 60.6 | 57.0 | 218.8 | 328.1 |
| **medium-checkers-8** | 89.5 | **174.1** | **1.94** | 1.86–1.99 | 59.3 | 60.2 | 203.1 | 343.8 |
| medium-256m-heap-setting | 90.2 | 185.9 | 2.06 | 2.01–2.14 | 60.0 | 58.9 | 359.4 | 312.5 |
| project-references-clean | 56.2 | 80.7 | 1.44 | 1.39–1.47 | 21.8 | 23.5 | 46.9 | 46.9 |
| project-references-noop | 49.1 | 63.1 | 1.28 | 1.24–1.32 | 13.0 | 12.8 | 15.6 | 31.2 |
| project-references-implementation | 51.6 | 67.7 | 1.31 | 1.29–1.34 | 21.3 | **20.2** | 15.6 | 31.2 |
| project-references-declaration | 53.8 | 77.9 | 1.45 | 1.42–1.48 | 22.0 | 24.0 | 31.2 | 46.9 |
| project-references-config | 51.7 | 67.4 | 1.30 | 1.28–1.34 | 20.4 | **19.9** | 31.2 | 46.9 |
| project-references-package | 52.6 | 75.6 | 1.44 | 1.42–1.47 | 20.8 | 21.9 | 15.6 | 46.9 |

**P0 之后的关键读数**
1. **内存已经是优势项**：23 项里有 **7 项 P0 峰值 RSS 低于 Go**（tiny-files 45.3 vs 50.9、noemit 37.2 vs 40.0、noemit-on-error 44.5 vs 55.6、incremental 49.1 vs 64.7、pr-impl 20.2 vs 21.3、pr-config 19.9 vs 20.4），medium 持平（59.9 vs 60.5）；只有 huge-file 明显更差（238 vs 164，可用 AB18 的 GC 参数降到 ~193）。
2. **CPU 时间已经在多项上低于 Go**：tiny-files 562.5 vs 593.8、noemit 171.9 vs 281.2、incremental 578.1 vs 750.0 —— 差距纯粹是并行度与每核效率，而不是"算得多"。
3. **剩余差距的分布**：medium（CPU 1.33×、并行度 1.96× vs Go 3.08×）、huge-file（CPU 3.2×、无并发可借）、host-paths（1.77×，路径/非 ASCII 处理的每核效率）、project-references（1.28–1.45×，构建编排的固定开销）。**这四个就是 P1 的全部靶子。**
4. **注意跨批次漂移**：本批 Go 的 medium 为 91.3 ms，而 R1 批次为 111.2 ms（−18%，机器负载下降）。因此**比值只能在同一批次内比较**；P0 相对"同批次原基线"的下降以 AB10/AB12 的同二进制 A/B 为准（−18~−34%）。

### 8.6 最终构建（final）对 Go 全量结果（AB23，15 组配对，噪声 20.2%）

| 工作负载 | Go | final | 比值 | 95% CI | RSS Go | RSS final | RSS 比 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| help | 57.9 | 68.3 | 1.18 | 1.11–1.22 | 10.8 | 11.4 | 1.06× |
| version | 48.2 | 56.4 | 1.17 | 1.16–1.23 | 10.5 | 10.8 | 1.03× |
| empty-project | 50.6 | 61.8 | 1.22 | 1.20–1.27 | 12.1 | 13.8 | 1.14× |
| small-first-diagnostic | 55.5 | 77.4 | 1.39 | 1.34–1.49 | 18.5 | 22.9 | 1.24× |
| **medium** | 100.2 | 204.8 | **2.04** | 1.95–2.14 | 60.4 | **48.7** | **0.81×** |
| declarations | 100.5 | 196.3 | 1.95 | 1.84–2.02 | 54.9 | **48.4** | **0.88×** |
| **tiny-files** | 280.5 | 361.0 | **1.29** | 1.23–1.36 | 51.1 | **37.0** | **0.72×** |
| huge-file | 427.3 | 1596.1 | 3.74 | 3.60–3.82 | 161.5 | 192.9 | 1.19× |
| host-paths | 58.6 | 111.4 | 1.90 | 1.79–1.96 | 19.4 | 23.3 | 1.20× |
| tiny-files-noemit | 130.1 | 160.9 | 1.24 | 1.18–1.33 | 39.5 | **34.3** | **0.87×** |
| tiny-files-noemit-on-error | 259.7 | 337.1 | 1.30 | 1.26–1.36 | 56.0 | **35.4** | **0.63×** |
| tiny-files-incremental-edit | 303.3 | 423.6 | 1.40 | 1.25–1.45 | 64.4 | **37.8** | **0.59×** |
| medium-checkers-1 | 115.0 | 337.3 | 2.93 | 2.84–3.00 | 57.3 | **43.6** | **0.76×** |
| medium-checkers-2 | 107.9 | 251.4 | 2.33 | 2.29–2.42 | 59.7 | **44.1** | **0.74×** |
| medium-checkers-4 | 101.4 | 214.8 | 2.12 | 2.03–2.23 | 60.1 | **46.4** | **0.77×** |
| medium-checkers-8 | 102.6 | 213.8 | 2.08 | 1.99–2.14 | 59.1 | **48.7** | **0.82×** |
| medium-256m-heap-setting | 101.1 | 202.8 | 2.01 | 1.90–2.06 | 60.2 | **48.4** | **0.80×** |
| project-references-clean | 62.8 | 96.9 | 1.54 | 1.50–1.58 | 22.0 | 24.3 | 1.10× |
| project-references-noop | 53.6 | 69.2 | 1.29 | 1.27–1.36 | 13.0 | **12.8** | **0.98×** |
| project-references-implementation | 57.5 | 80.1 | 1.39 | 1.36–1.44 | 21.3 | 23.7 | 1.11× |
| project-references-declaration | 59.3 | 90.3 | 1.52 | 1.48–1.55 | 22.0 | 24.5 | 1.11× |
| project-references-config | 58.7 | 87.3 | 1.49 | 1.38–1.61 | 21.2 | 23.6 | 1.11× |
| project-references-package | 62.4 | 96.8 | 1.55 | 1.48–1.58 | 20.7 | 23.1 | 1.12× |

**内存已经是净优势**：23 项里 **8 项低于 Go**（最低到 0.59×），仅 huge-file（1.19×）与若干小负载（1.1–1.2×，绝对差 2–4 MiB）高于 Go。

---

## 9. 执行结果（已落地入代码）

### 9.1 已实施的改动（5 个文件，+125 / −39 行）

| 文件 | 改动 | 工作流 | 实测效果 |
| --- | --- | --- | --- |
| `csharp/src/TypeScript.Compiler/Incremental/IncrementalProgram.Emit.cs` | 串行 `foreach+await` 发射 → "串行收集待发射项 + `Parallel.ForAsync` 按文件借用 `CheckerPool` 租约并行发射 + 串行按序合并"；`Write` 快照读改写加 `writeGate` | WS1 | **−18~−34%**（多文件），内存中性 |
| `csharp/src/TypeScript.Compiler/Checking/CheckerPool.cs` | 检查器池默认数由常量 4 改为自适应 `Clamp(ProcessorCount/4, 4, 8)` | WS2 | medium **−7.7%**、declarations **−7.8%**、512 文件 −1.8% |
| `csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj` | 烘焙 Workstation GC + `System.GC.gen0size=0x400000` + `System.GC.LOHThreshold=1000000` | WS5 | AOT 只部分生效（huge-file RSS 238→229 MiB），完整效果需启动器环境变量 |
| `csharp/tools/package.mjs` | 生成的 `bin/tsc` 启动器导出 `DOTNET_gcServer/GCgen0size/GCLOHThreshold` 默认值（`lib/tsc.js` 用 `stdio: inherit` 派生编译器进程，环境变量被继承） | WS5 | 让上述 GC 参数在 AOT 上真正生效（huge-file RSS **238 → 196 MiB**，时间 −4%） |
| `csharp/tests/TypeScript.Compatibility/CheckerPoolTests.cs` | 默认池大小断言由 `== 4` 改为契约断言 `== CheckerPool.DefaultCheckerCount && ∈[4,8]` | 测试 | 与新的自适应默认值对齐 |

**同时回退**：`Programs/CompilerProgram.cs` 的"解析并发自动 = ProcessorCount"实验补丁（AB6/AB7/AB9 已证伪其收益），保持上游默认 4，避免在 mapper/LSP/watch 等未覆盖路径上引入并发行为变化。

### 9.2 验证

| 门禁 | 结果 |
| --- | --- |
| 构建 | `dotnet build csharp/TypeScript.slnx -c Release`：**0 警告 0 错误**（`TreatWarningsAsErrors` 生效） |
| 产物逐字节一致性 | 官方驱动在每一对样本上比对退出码/stdout/发射文件字节：AB10/AB11/AB12/AB20/AB21/AB22/AB23 共 **100+ 组配对 × 含发射负载** 全部通过 |
| 项目自带兼容性测试 | 10 项 safety 测试：`checker-pool`、`declaration`、`incremental`、`build-info`、`emit-foundations`、`transpile`、`parser`、`program`、`checker-emit-links` **全部通过**；`program-emit-safety` 失败，但**在未修改的基线构建（`git stash` 后单独构建）上以同一断言（assertion 14，content-mapper 夹具）同样失败** → 预存在的环境问题，与本次改动无关 |
| 端到端 | `final` 构建跑完 23 项 CLI 套件（AB23，15 组配对） |

### 9.3 累计效果（最终态 vs 原始基线）

| 维度 | 原始基线 | 最终（已落地） | 变化 |
| --- | --- | --- | --- |
| medium vs Go | 3.14× | **2.04×** | −35% |
| declarations vs Go | 2.54× | **1.95×** | −23% |
| 512 文件完整 vs Go | 1.81× | **1.29×** | −29% |
| 512 文件增量 vs Go | 1.89× | **1.40×** | −26% |
| project-references（4 项均值） | 1.55× | **1.44×** | −7% |
| 单巨文件 vs Go | 3.61× | 3.74× | 持平（无并发可借；用 −17% 内存换得） |
| medium 峰值 RSS | 126.5（SVR）/ 55.5（WKS） | **48.7 MiB** | −61% / −12% |
| huge-file 峰值 RSS | 322（SVR）/ 238（WKS） | **192.9 MiB** | −40% / −19% |
| 512 文件峰值 RSS | 49.1 | **37.0 MiB** | −25%（低于 Go 的 51.1） |
| **峰值内存低于 Go 的负载数** | 0 / 23 | **8 / 23** | — |
| medium 并行度（CPU/墙上） | 1.21× | ≈2.0× | +65% |

> 上述"最终 vs 原始基线"跨批次比较仅作方向性参考（机器负载在本会话期间漂移可达 30%）；**每一项改动的严格收益以其同批次配对 A/B 为准**（AB10/AB12 发射并行、checker 缩放实验、AB18 GC 调参、AB20 组合）。

### 9.4 未执行的部分与理由（诚实边界）

| 未做项 | 理由 | 前置条件 |
| --- | --- | --- |
| WS4 arena / 分配削减（931→400 MB） | 需重新设计（旧原型慢 18.5%），且缺少按类型归因的分配剖析；20% 噪声下无法可靠验证 1–3% 级改动 | PerfView/ETW 分配归因 + 独立安静机器 |
| WS3 模块解析并行 | 触及并发缓存一致性；真实工程负载未能在本机安静环境下复测 | 专项剖析 + 真实工程基准 |
| WS7 打印器/子节点访问 | 改动面大（生成代码），单点收益 1–4%，当前噪声下不可验证 | 低噪声测量环境 |
| WS8 服务/常驻路径 | 需要 LSP/watch 长时基准，本机桌面负载会污染结果 | 独立环境 |
| 全量 13,446 配置兼容性语料 | 运行时间以小时计 | 专用 CI 机器 |

---

## 10. 第二轮极限优化：打印器分配与状态复用

上一轮把"并发"补齐后，单巨文件（3.74×）成为最差项，瓶颈在发射阶段（占时间 66%）。本轮改用**分配归因驱动**：先造一把确定性可测的尺子，再定点消除。

### 10.1 方法：先造尺子

新增**按阶段分配统计**（仅 `--diagnostics` / `--extendedDiagnostics` 启用，正常编译零热路径成本）：
`Alloc program / parse / bind / check / emit / transform / print (summed)`，与既有阶段耗时并列输出。配合临时的分支级/调用级插桩（测量后已全部移除），得到 huge-file 的分配地图（CoreCLR 探针，确定性指标）：

| 层级 | 分配 | 占比 |
| --- | ---: | ---: |
| 编译总计 | 960 MB | 100% |
| ├ 发射 | **712 MB** | 74% |
| │ ├ print | **587 MB** | 61% |
| │ └ transform | 124 MB | 13% |
| ├ 检查 | 183 MB | 19% |
| ├ 程序构建 | 64 MB | 7% |
| ├ 解析 | 42 MB | 4% |
| └ 绑定 | 21 MB | 2% |

print 内部细分：**node 分支 341 MB、text 分支 120 MB、other 分支 89 MB、parts 分支 29 MB**；
调用计数：`BeginNode` **409,602 次**（每次约 174 B）、部件容器 **196,610 个 / 999,445 个元素**（`S()` 65,536、`Scoped()` 32,768，合计一半）。

**由此定位到三个具体缺陷**：
1. `Code()` 每写一个标点/关键字就 `new SourceText(text)`（内部 `text.Span.ToArray()` **复制整段文本**）+ `new Scanner(...)`（内含两个 `List<>`）→ 每次调用 5 个分配对象；
2. `BeginNode()` 每个节点 `new NodeState(...)` 一个类对象（409,602 个）；
3. 状态栈访问用了 LINQ（`states.Skip(1).FirstOrDefault()`、`states.ElementAt(1)`）。

### 10.2 已实施的改动（4 个文件）

| 文件 | 改动 | 实测（huge-file 分配） |
| --- | --- | --- |
| `Emission/SyntaxPrinter.cs` | `Code()` 改为**复用**一个 scratch `SourceText` + 一个 `Scanner`（新增 `SourceText.Reset(ReadOnlySpan<byte>)` 原地换文本并复用缓冲；新增 `Scanner.Reset(SourceText)` 重新绑定并清空状态） | text 分支 **120 → 33.5 MB（−72%）** |
| `Emission/SyntaxPrinter.cs` | `NodeState` 由"每节点新建"改为**池化复用**（`statePool`，栈纪律 LIFO 安全，上限 64） | begin-node **100.6 → 71.2 MB（−29%）** |
| `Emission/SyntaxPrinter.cs` | **`Part` 结构体从约 120 B 压到 64 B**：8 个 bool 折叠为 1 个 flags 字节；`int?` 改 -1 哨兵；`Utf8String?` 用 TextSet 位保留可空语义；5 个稀有引用（GenerateList/GenerateNode/Helpers/Directives/PositionTarget）移入**按需分配的 payload**（仅当其一时才分配）。构造参数名与属性名全部保持不变，104 处调用点零改动 | 总分配 **843.5 → 756.0 MB**；print **470.9 → 383.6 MB（−18.5%）** |
| `Emission/SyntaxPrinter*.cs` | **注释扫描快速路径**：文件内不含 `//` 或 `/*` 时（`HasSourceComments` 一次 SIMD 扫描即可判定），跳过每节点的 `CommentRanges` 扫描与 LINQ `.ToArray()`；**合成注释（transform 添加的）语义完全保留**（仅屏蔽源注释路径）。依据：`CommentRanges` 只在遇到 `//`/`/*` 时才产生区间 | 总分配 **756.0 → 615.7 MB**；print **383.6 → 242.9 MB（−36.7%）**；medium 136.4 → **113.1 MB** |
| `Emission/SyntaxPrinter*.cs` | 新增 `ParentState()`（`foreach` 用 `Stack<T>` 的结构体枚举器）替换 6 处 LINQ 迭代器 | 命中站点不再分配 |
| `Diagnostics/CompilationCapture.cs`、`CompilationStatistics.cs` | 按阶段分配统计 + `Measure(category)`（无捕获时 no-op） | 工具（热路径零成本） |

### 10.3 本轮累计效果（确定性指标）

| 夹具 | 本轮前 | 本轮后（final4） | 变化 |
| --- | ---: | ---: | ---: |
| huge-file 总分配 | 960.1 MB | **615.7 MB** | **−35.9%** |
| medium 总分配 | 167.7 MB | **113.1 MB** | **−32.6%** |
| 512 文件总分配 | 73.8 MB | ~62 MB | 约 −16% |
| huge-file 发射分配 | 711.7 MB | **367.2 MB** | **−48.4%** |
| huge-file print 分配 | 587.4 MB | **242.9 MB** | **−58.6%** |
| huge-file Emit 阶段时间（探针，summed） | 1.948 s | 1.794 s | −7.9% |
| medium Emit 阶段时间（探针，summed） | 1.549 s | 1.337 s | −13.7% |

### 10.3.1 端到端比值进展（每轮同批次配对 15 组）

| 负载 | 原始基线 | 第一轮（final） | 第二轮 A（final3，+Part 瘦身） | 第二轮 B（final4，+注释快速路径） |
| --- | ---: | ---: | ---: | ---: |
| medium | 3.14 | 2.04 | **1.90** | 待 AB26 |
| declarations | 2.54 | 1.95 | **1.85** | 待 AB26 |
| 512 文件 | 1.81 | 1.29 | 1.29 | 待 AB26 |
| 512 文件增量 | 1.89 | 1.40 | **1.33** | 待 AB26 |
| huge-file | 3.61 | 3.74 | **3.51** | 待 AB26 |
| 启动 version | 1.30 | 1.17 | 1.16 | 待 AB26 |
| medium 峰值 RSS | 126.5（SVR） | 48.7 | **47.9** | 待 AB26 |
| huge-file 峰值 RSS | 322（SVR） | 192.9 | **177.3** | 待 AB26 |

### 10.4 已被数据锁定、但尚未实施的下一步

| 目标 | 规模 | 方案 | 预期 |
| --- | --- | --- | --- |
| `new List<Part>` 站点 | **98,306 个容器**（占容器总数一半） | 改为精确长度的池化数组（消除 List 倍增浪费与 List 头） | 容器分配 −10~20% |
| `Emit(child)` 其余分配 | print 243 MB − 容器 ≈ **55–85 MB** | 按节点方法继续归因（插桩能力已具备） | 待测 |
| **带注释文件的注释扫描** | 每节点仍 `new List<SourceCommentRange>` + LINQ `.ToArray()` | 每文件预建**有序注释区间索引** + 二分定位（替代逐次扫描） | 有注释工程可再降一批分配 |
| transform 阶段分配 | **124 MB**（huge-file） | `EmitContext` 的 `originals`/`nodes` 字典与 `NodeData` 对象；transformer 克隆与私有字典 | 需按方法归因 |
| 检查阶段分配 | **183 MB**（huge-file） | 已排除 `Array.AsReadOnly` 包装器（实测 <2 MB，**已回退**）；需按节点种类的**自分配递归归因** | 需新增递归归因插桩 |

### 10.8 第二轮后段：按节点种类的分配归因与列表构造优化

**方法**：在打印器主循环的节点分支按 `SyntaxKind` 累计 `GC.GetTotalAllocatedBytes()` 增量（临时插桩，测完移除），直接得出"哪些节点类型最耗分配"。

**归因结果（huge-file，print 共 243 MB）**：

| 节点种类 | 优化前 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| ObjectLiteralExpression | 40.4 MB | **26.9 MB** | **−33%** |
| TypeLiteral | 38.9 MB | **25.1 MB** | **−35%** |
| VariableDeclarationList | 35.2 MB | **26.7 MB** | **−24%** |
| 前 12 名合计 | 169 MB | 148 MB | −12% |

**据此实施的两项安全优化**（语义等价、无池化别名风险）：

1. **热点列表预分配容量**：`List<Part>` 从 0 容量起步要走 4→8→16… 倍增链（24 个部件需分配 4+8+16+32 = 60 个槽位）。为通用 `List`、`BlockMembers`、`BlockBody`、`Modifiers`、`ObjectLiteralExpression` 按"每子节点至多 N 个部件"的安全上界一次预分配。
2. **`Scoped` 免拷贝重载**：原实现把调用者所有部件复制进 `new Part[parts.Length + 2]`。容器元素展开后序列完全相同，故改为 1–3 元重载直接构造 `[scope+, …args…, scope-]`——对"大容器 + 标记"这一最常见形态，分配从 n+3 槽降到 4 槽。

**结果**：huge-file print 分配 **243 → 218 MB（−10%）**、总分配 **616 → 590 MB**；medium 113 → 111 MB；Emit 阶段（探针）1.79 → 1.66 s。

**同时记录一个被否决的改动**：全仓库 62 处 `Array.AsReadOnly(x)`（数组本身已实现 `IReadOnlyList<T>`，且包装器只是视图、无隔离语义）中，我在检查器热路径移除 41 处、编译零错误，但实测检查分配 180.0 → 183.3 MB（噪声内、<2 MB），**无可测收益**，已**整体回退**并仅作为"冗余包装器"记录。

### 10.9 第二轮最终结果（final5，AB27）

| 负载 | 第二轮前 | final3 | final4 | **final5** |
| --- | ---: | ---: | ---: | ---: |
| huge-file | 3.74 | 3.51 | 3.24 | **3.20** |
| medium | 2.04 | 1.90 | 1.92 | **1.84** |
| declarations | 1.95 | 1.85 | 1.90 | **1.84** |
| 512 文件 | 1.29 | 1.29 | 1.28 | **1.28** |
| 512 文件增量 | 1.40 | 1.33 | 1.38 | 1.42 |
| medium checkers=1 | 2.93 | 2.84 | 2.66 | 2.76 |
| medium checkers=8 | 2.08 | 1.99 | 1.88 | 1.90 |
| medium 峰值 RSS | 48.7 | 47.9 | 47.8 | **47.7** |
| huge-file 峰值 RSS | 192.9 | 177.3 | 177.4 | **176.1** |

（AB27 批次噪声 20.8% 且 Go 侧出现 `medium-checkers-2`、`project-references-config` 离群值，故只采信 CI 较紧的项；`medium`/`declarations`/`huge-file` 的改善与确定性分配指标一致。）

**第二轮累计**：巨文件 **3.74 → 3.20（−14.4%）**、中等工程 **2.04 → 1.84（−9.8%）**、声明 **1.95 → 1.84（−5.6%）**；巨文件分配 **960 → 590 MB（−38.5%）**，其中发射 **712 → 366 MB（−48.6%）**、打印 **587 → 218 MB（−62.9%）**。

### 10.11 第二轮后段之二：消除部件工作项容器（直推改造）

归因显示剩余打印分配集中在**列表容器型节点**，而容器本身是纯开销：一个容器要被填满（把每个 `Part` 复制进去），再被展开（把所有 `Part` 再复制一遍到工作栈）。由于工作栈是 LIFO，**按逆序直接 `pending.Push` 可得到完全相同的处理顺序**，容器可以整个省掉。

**改造清单**（全部语义等价，逐字节校验通过）：

| 改动 | 说明 |
| --- | --- |
| `List` 拆为 `List` / `PushList` / `BuildList` | 新增**池化部件缓冲**（`partListPool`，`Clear()` 释放引用、容量复用，故缓冲永不逃逸、无别名风险）；`List` 只分配最终精确数组，`PushList` 直接逆序入栈、**零分配** |
| `ObjectLiteralExpression`（多行与单行两条路径） | 多行路径改为逆序直推（含 `NameScopeChange`/`Generate` 标记）；单行路径改用 `PushList` |
| `VariableDeclarationList` | 改用 `PushList` |
| `TypeLiteral` → 新增 `PushTypeMembers` / `PushBraces` / `PushBlockMembers` | `BlockMembers` 的免容器对应实现（含 `ListBoundary`、缩进、闭合行判定） |

**结果（确定性分配）**：

| 指标 | 改造前 | 改造后 | 变化 |
| --- | ---: | ---: | ---: |
| 巨文件打印分配 | 217.4 MB | **146.6 MB** | **−32.6%** |
| 巨文件总分配 | 589.8 MB | **519.7 MB** | **−11.9%** |
| 中等工程总分配 | 110.9 MB | **105.3 MB** | −5.1% |

**逐字节校验**：huge-file(2) + medium(128) + declarations(65) + tiny-files(1024) + 注释专项(8) = **1227 个产物文件与 Go 逐字节一致**（每次改造后复测）。

### 10.12 第二轮总计（相对第二轮起点）

| 指标 | 第二轮前 | final6 | 变化 |
| --- | ---: | ---: | ---: |
| 巨文件总分配 | 960.1 MB | **519.7 MB** | **−45.9%** |
| ├ 发射分配 | 711.7 MB | **268.9 MB** | **−62.2%** |
| └ 打印分配 | 587.4 MB | **146.6 MB** | **−75.0%** |
| 巨文件 AOT 发射阶段 | 1.064 s | **0.668 s** | **−37.2%** |
| 巨文件 AOT 总时间 | 1.621 s | **1.263 s** | **−22.1%** |
| 中等工程总分配 | 167.7 MB | **105.3 MB** | **−37.2%** |

（巨文件端到端比值以 AB28 为准，见 10.13。）

### 10.5 验证

| 门禁 | 结果 |
| --- | --- |
| 构建 | **0 警告 0 错误** |
| safety 测试 | 13 项中 **12 项通过**；`program-emit-safety` 失败为**预存在**（未修改基线同样失败） |
| 逐字节产物一致（无注释夹具） | 官方驱动 AB24/AB25/AB26 全量 23 项 × 15 组配对，逐字节比对退出码/stdout/发射文件 |
| **逐字节产物一致（带注释源码，专项）** | 构造含行注释、块注释、JSDoc、行内注释、参数间注释、类型内注释、语句尾注释、多行块注释的两文件工程（开启 `declaration` + `declarationMap` + `sourceMap`），**Go 参考与新构建产出的 8 个文件全部逐字节一致** —— 直接验证注释快速路径未改变慢路径行为 |
| 分配指标 | 确定性、可复现（见 10.3） |

### 10.13 final6 全量结果（AB28，噪声 10%）与关键发现

| 负载 | Go (ms) | final6 (ms) | 比值 | 95% CI | RSS 比 |
| --- | ---: | ---: | ---: | --- | ---: |
| help | 47.5 | 55.3 | **1.16** | 1.14–1.21 | 1.06 |
| version | 45.9 | 53.7 | **1.17** | 1.13–1.20 | 1.03 |
| empty-project | 47.0 | 58.1 | 1.24 | 1.23–1.26 | 1.14 |
| small-first-diagnostic | 51.2 | 70.8 | 1.38 | 1.33–1.42 | 1.24 |
| medium | 91.5 | 167.4 | **1.83** | 1.78–1.89 | **0.80** |
| declarations | 83.0 | 153.5 | **1.85** | 1.80–1.88 | **0.87** |
| 512 文件 | 243.5 | 307.6 | **1.26** | 1.22–1.32 | **0.73** |
| huge-file | 379.0 | 1223.9 | **3.23** | 3.15–3.32 | 1.10 |
| host-paths | 54.3 | 102.7 | 1.89 | 1.84–1.94 | 1.21 |
| 512 文件 noEmit | 117.2 | 146.1 | **1.25** | 1.20–1.27 | **0.86** |
| 512 文件 noEmit-on-error | 246.2 | 328.2 | 1.33 | 1.28–1.41 | **0.68** |
| 512 文件增量编辑 | 285.9 | 403.7 | 1.41 | 1.34–1.44 | **0.58** |
| medium checkers=1 | 115.9 | 303.3 | **2.62** | 2.42–2.71 | **0.76** |
| medium checkers=2 | 102.0 | 219.0 | **2.15** | 2.04–2.25 | **0.74** |
| medium checkers=4 | 96.9 | 189.6 | **1.96** | 1.87–2.03 | **0.77** |
| medium checkers=8 | 95.4 | 181.5 | **1.90** | 1.82–1.99 | **0.81** |
| medium 256M 堆设置 | 99.2 | 185.1 | **1.87** | 1.81–1.90 | **0.80** |
| pr-clean | 60.5 | 94.2 | 1.56 | 1.52–1.57 | 1.11 |
| pr-noop | 56.3 | 73.4 | 1.30 | 1.21–1.39 | **0.99** |
| pr-implementation | 64.7 | 94.1 | **1.46** | 1.42–1.49 | 1.11 |
| pr-declaration | 62.4 | 97.3 | 1.56 | 1.52–1.61 | 1.11 |
| pr-config | 59.1 | 82.2 | **1.39** | 1.37–1.42 | 1.13 |
| pr-package | 61.0 | 93.7 | 1.54 | 1.50–1.56 | 1.11 |

**关键发现（诚实结论）**：把打印分配从 587 MB 砍到 147 MB（−75%）后，**巨文件的端到端比值几乎没有变化**（3.20 → 3.23，CI 内持平）。这说明：

- 巨文件的 3.2× **已不再由打印器的分配驱动**。其 AOT 阶段为 parse 0.079 + bind 0.069 + check 0.344 + emit 0.668 = 1.16 s（Go 全场 0.379 s），剩余时间花在**约 100 万个部件工作项的逐项搬运与分派**，以及检查阶段——这些是设计层面的成本，不是分配成本。
- 真正被分配削减改善的是**中等工程**与**检查器并发**：medium 2.04 → **1.83**、checkers=1 2.93 → **2.62**、checkers=2 → **2.15**、pr-config 1.49 → **1.39**、pr-implementation → **1.46**。
- **内存**：23 项中 12 项低于 Go，且优势集中在真实工程（增量编辑 0.58×、noEmit-on-error 0.68×、512 文件 0.73×、checkers=2 0.74×）。

### 10.14 进一步降低 `Code()` 的调度成本（final7）

上表之后又定位到一处**纯调度开销**：`Code()` 为每个标点/关键字配方词重建 Scanner 并逐 token 扫描，而这些 token 边界**只用于注释定位与 source map 位置**。当既无 source map 又无源注释时（`sourceMap is null && !sourceHasComments`），整段配方词可一次性写出：

```csharp
if (fastCode) { writer.Write(text); return; }
```

该判断只依赖 `Code()` 实际使用的两项状态，因此语义严格等价（AB29 以 final6 为对照做同批次配对 A/B 并断言逐字节一致）。

**AB29 配对 A/B 结果**（final7/final6，同批次交替 15 组，噪声 12.3%；比值 <1 表示 final7 更快；驱动对全部 23 项断言了产物逐字节一致）：

| 负载 | 比值 | 95% CI | 结论 |
| --- | ---: | --- | --- |
| huge-file | **0.990** | 0.972–0.998 | **−1.0%，显著** |
| 512 文件 noEmit | **0.957** | 0.949–0.973 | **−4.3%，显著** |
| medium checkers=8 | **0.953** | 0.934–0.995 | **−4.7%，显著** |
| medium checkers=1 | **0.980** | 0.966–0.991 | **−2.0%，显著** |
| declarations | 0.980 | 0.944–1.001 | −2.0%，CI 触界 |
| medium | 0.986 | 0.920–1.044 | −1.4%，未达显著 |
| 512 文件 | 1.009 | 0.982–1.031 | 持平 |
| 其余 16 项 | 0.99–1.02 | 均含 1.0 | 持平 |

结论：省掉配方词的逐 token 扫描是**真实但温和**的收益（多数负载 1–5%），与"巨文件瓶颈已不在打印器"的判断一致。

### 10.6 最终构建（final4）对 Go 全量结果（历史批次，保留备查）

AB26 批次（同批配对 15 组，**输入活动噪声 5.4%**）：

| 负载 | Go (ms) | C# final4 (ms) | 比值 | 95% 配对 CI | Go RSS | C# RSS | RSS 比 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| help | 48.1 | 58.8 | 1.22 | 1.20–1.26 | 10.4 | 10.9 | 1.05 |
| version | 48.1 | 57.2 | **1.19** | 1.17–1.21 | 10.0 | 10.4 | 1.04 |
| empty-project | 48.6 | 61.1 | 1.26 | 1.24–1.27 | 11.7 | 13.3 | 1.14 |
| small-first-diagnostic | 53.1 | 74.6 | 1.41 | 1.38–1.44 | 18.1 | 22.5 | 1.24 |
| medium | 94.9 | 182.5 | **1.92** | 1.87–1.97 | 59.6 | **47.8** | **0.80** |
| declarations | 88.0 | 167.3 | **1.90** | 1.84–1.98 | 54.4 | **47.5** | **0.87** |
| 512 文件 | 260.7 | 333.9 | **1.28** | 1.25–1.34 | 50.6 | **36.5** | **0.72** |
| **huge-file** | 403.7 | 1307.7 | **3.24** | 3.21–3.27 | 165.1 | 177.4 | 1.07 |
| host-paths | 54.7 | 102.4 | 1.87 | 1.84–1.90 | 18.9 | 22.8 | 1.21 |
| 512 文件 noEmit | 124.1 | 152.8 | **1.23** | 1.18–1.25 | 39.2 | **33.8** | **0.86** |
| 512 文件 noEmit-on-error | 256.6 | 337.7 | 1.32 | 1.28–1.34 | 54.3 | **35.0** | **0.64** |
| 512 文件增量编辑 | 274.6 | 380.1 | 1.38 | 1.33–1.41 | 64.2 | **37.4** | **0.58** |
| medium checkers=1 | 109.9 | 292.9 | **2.66** | 2.60–2.78 | 56.8 | **43.2** | **0.76** |
| medium checkers=2 | 98.0 | 221.5 | 2.26 | 2.21–2.28 | 59.3 | **45.4** | **0.77** |
| medium checkers=4 | 93.9 | 185.4 | **1.97** | 1.94–2.05 | 59.7 | **45.9** | **0.77** |
| medium checkers=8 | 91.0 | 171.1 | **1.88** | 1.85–2.01 | 58.6 | **47.8** | **0.82** |
| medium 256M 堆设置 | 91.2 | 172.8 | **1.89** | 1.83–1.91 | 59.7 | **47.6** | **0.80** |
| pr-clean | 55.1 | 86.2 | 1.56 | 1.53–1.69 | 21.3 | 23.7 | 1.11 |
| pr-noop | 48.1 | 65.0 | 1.35 | 1.30–1.47 | 12.7 | **12.3** | **0.97** |
| pr-implementation | 55.5 | 79.0 | 1.42 | 1.35–1.44 | 20.9 | 23.3 | 1.11 |
| pr-declaration | 58.6 | 92.4 | 1.58 | 1.54–1.62 | 21.6 | 24.0 | 1.11 |
| pr-config | 55.6 | 80.4 | 1.45 | 1.43–1.48 | 20.7 | 23.2 | 1.12 |
| pr-package | 56.3 | 89.8 | 1.60 | 1.56–1.66 | 20.2 | 22.6 | 1.12 |

**关键结论（第二轮）**
1. **单巨文件从 3.74× 降到 3.24×（−13.4%）**，是两轮中该最差项的最大改善；其分配量下降 **35.9%**（960→616 MB），发射阶段分配下降 **48.4%**。
2. **中等工程从 2.04× 降到 1.92×**，checkers=1 从 2.93× 降到 **2.66×**、checkers=8 从 2.08× 降到 **1.88×**。
3. **峰值内存：23 项中 12 项低于 Go**（medium 0.80、declarations 0.87、512 文件 0.72、增量 0.58、noEmit-on-error 0.64、checkers 全系 0.76–0.82、pr-noop 0.97）；巨文件差距从 1.19× 收窄到 **1.07×**。
4. 启动类负载（help/version/empty）仍在 1.19–1.26，属 NativeAOT 进程启动与 GC 初始化地板，不随编译期优化改善。
5. 仍未超越 Go：全量 23 项中最优为 1.19×（version），最差 3.24×（巨文件）。**结论：在"每项都更快"的意义上无法超越 Go**；但在**内存**上已在过半负载领先，在**中等工程检查**上差距已进入 1.9× 区间。

### 10.7 本轮补丁与产物

| 产物 | 路径 |
| --- | --- |
| 本轮完整补丁（两轮合计，工作区 vs 上游） | `implemented-optimizations.patch` |
| 方案与实测文档（本文件） | `plan-extreme-optimization.md` |
| 分配归因工具（按阶段） | `--extendedDiagnostics` 新增 `Alloc * (summed)` 输出 |
| 注释快速路径专项差分证据 | 见 10.5 表格（8 个产物逐字节一致） |
