# C# 版 TypeScript 编译器 vs Go 版：全面性能对比、归因与优化方案

> 测量日期：2026-10-06 · 主机：AMD Ryzen 9 8945HX（16 核 / 32 逻辑处理器）、32 GiB RAM、Windows、高性能电源方案
> 被测代码：`C:\ai\projects\TypeScript`（main = Go 实现）与 worktree `C:\ai\projects\typescript-cs`（分支 `origin/typescript-cs` = C# 实现，HEAD `6ed638d3a5`）
> 工具链：Go 1.27.1 windows/amd64；.NET SDK 11.0.100-rc.1.26425.128（net11.0 / C# 15 / runtime-async）

---

## 0. 摘要

> **后续更新（已执行）**：优化方案已落地到代码并通过实测验证 —— 见 [plan-extreme-optimization.md](plan-extreme-optimization.md) 第 9 节。落地内容：**发射并行化**、**检查器池自适应（4→≤8）**、**Workstation GC + gen0size/LOHThreshold（含启动器环境变量）**，共 5 个文件 +125/−39 行。最终态对 Go 的比值：**medium 3.14×→2.04×、declarations 2.54×→1.95×、512 文件 1.81×→1.29×、512 文件增量 1.89×→1.40×、启动 1.09–1.30×→1.17×**；**峰值内存 8/23 项低于 Go**（512 文件 37.0 vs 51.1 MiB、medium 48.7 vs 60.4 MiB、增量 37.8 vs 64.4 MiB），仅单巨文件仍为 3.74×/1.19×。

**结论先行**

1. **开箱即用的默认配置下，Go 在所有 23 项 CLI 负载上都更快。** 最公平的对比（Go 1.27.1 `GOAMD64=v1` vs C# NativeAOT + Server GC，同机配对、21 组样本）比值区间为 **1.15×–3.61×**：
   - 启动类（`--version`/`--help`/空工程）：**1.09×–1.41×**
   - 多文件编译（64–512 文件）：**1.81×–3.14×**
   - 单巨文件（16,384 个导出声明）：**3.61×**
   - 512 文件 `--noEmit`（不发射）：**1.15×**
   - **真实工程**（`packages/typescript`，186 文件 / 51,665 行，含 2.3 MB `lib.dom.d.ts`，`--noEmit`）：NativeAOT 为 **2.28–2.50×**，ReadyToRun 4.83×，纯 JIT CoreCLR 8.44×；**且 C# 的总 CPU 时间与峰值内存都不高于 Go**（281 vs 297 ms、64.8 vs 72.5 MiB）
2. **差距的主因不是“每核算得慢”，而是“没有并行起来”。** 在 medium 负载上 C# 消耗的 CPU 时间只有 Go 的 **1.2–1.3 倍**，但墙上时间是其 **3.1 倍**；Go 的 CPU/墙上并行度为 2.8×，C# 只有 1.2×。512 文件负载更极端：Go 2.8×，C# **1.07×（基本串行）**。
3. **差距集中在两个阶段：发射（emit）与检查（check）。** 用两个编译器自带的 `--extendedDiagnostics` 做阶段归因（huge-file）：解析 1.45×、绑定 2.0×、检查 **3.3×**、发射 **6.2×**（发射占 C# 总时间的 66%）。而 C# 的发射循环是**单线程 `foreach + await`**，Go 是**每文件一个 goroutine**。
4. **同样代码，仅改发布/运行配置就能拿到可观收益**：工作站 GC 让启动从 1.30× 降到 **1.09×**、内存减半（medium 峰值 127 MiB → 55 MiB）；ReadyToRun 让 CoreCLR 启动从 4.76× 降到 **1.65×**、medium 从 15.4× 降到 8.3×。**Server GC 在本机 32 逻辑核上是负收益**（速度持平、内存翻倍、CPU 记账翻倍）。
5. **指令集（SIMD）不是杠杆。** Go `GOAMD64=v3` 相对 v1 **没有变快**（版本 55.2 vs 54.3 ms，medium 104.7 vs 104.4 ms）；C# `IlcInstructionSet=native` 相对 x64 便携基线同样只有 0–3% 量级差异。编译器负载是分支/指针密集型，不是向量密集型。
6. **一项被源码分析高度看好、但实测证伪的优化**：C# 把“解析+绑定”并发硬编码为 4（`SemaphoreSlim(4)`），而 Go 无上限。实测把该上限改为 4/8/32 **对 512 文件负载没有可测收益**（167 ms vs 173 ms），因为该负载里 512 个文件的解析总耗时只有 8 ms。**该方向不必投入。**
7. **能否超越 Go？** 分场景回答：
   - **启动 / 单文件 / 冷进程 CLI**：**已经可以打平甚至反超**（`--version` 1.09×，`--noEmit` 512 文件 1.15×）。
   - **多文件完整编译（含发射）**：当前 1.8×–3.6×；**如果把发射并行化（Go 已有的做法）并把分配量压下来，工程上有把握把多数负载推进到 1.0×–1.4×；在 ≥8 核机器上有超过 Go 的现实路径**，因为 C# 侧的“有用 CPU 时间”已经不高于 Go。
   - **单巨文件检查**：当前 3.3×，属于真正的每核吞吐差距，需要分配/GC 与检查器实现层面的系统优化，**短期难以反超**，中期可望进入 1.5×–2×。
   - 一句话：**“全面超越”不成立；“在多数真实工程（多文件、多核）上追平并在部分负载上超越”是可达目标，前提是补齐并行度这一结构性短板。**

---

## 1. 项目全景

### 1.1 仓库结构：一套输入契约，两个后端

| 位置 | 内容 | 规模 |
| --- | --- | --- |
| `main` 分支 | TypeScript 原生移植的 **Go 实现**（`tsc/`），另含 byte-coordinate 的 JS 客户端与 API（`packages/typescript/`） | 5,128 个 `.go` 文件 |
| `origin/typescript-cs` 分支 | 在**同一棵代码树**上新增 **C# 实现**（`csharp/`），并把 C# 设为默认后端，Go 退化为“钉住版本的 oracle” | 830 个 `.cs` 文件，5,192 个 `.go` 文件 |
| 共享资产 | 108 个 `lib.*.d.ts`（`tsc/internal/bundled/libs`）、诊断目录与本地化资源（`tsc/internal/diagnostics/loc`）、baseline 测试数据（`tsc/testdata`） | 两侧必须逐字节一致 |

C# 侧只有两个工程：

- `csharp/src/TypeScript.Compiler/TypeScript.Compiler.csproj`（698 个 `.cs`）——编译器库、语言服务、LSP、API
- `csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj`（4 个 `.cs`）——`tsc` 可执行文件（CLI / `--lsp` / `--api`）

### 1.2 模块映射（Go → C#）

| 阶段 | Go | C# |
| --- | --- | --- |
| 扫描 | `tsc/internal/scanner` | `Syntax/Scanner.cs` |
| 解析 | `tsc/internal/parser` | `Syntax/Parser.*.cs` |
| AST | `tsc/internal/ast` | `Ast/Nodes.generated.cs`（约 192 种节点） |
| 绑定 | `tsc/internal/binder` | `Binding/Binder.*.cs` |
| 检查 | `tsc/internal/checker` | `Checking/Checker.*.cs`（286 个文件） |
| 发射 | `tsc/internal/printer`, `transformers`, `execute` | `Emission/SyntaxPrinter.*.cs`（78 个文件） |
| 程序/工程 | `tsc/internal/compiler`, `project`, `execute` | `Programs/`, `Projects/`, `Execution/` |
| 语言服务 | `tsc/internal/ls`, `lsp`, `api` | `LanguageServices/`, `LanguageServer/`, `Api/` |
| 文本 | Go `string` + 字节切片 | `Utf8String` over `ReadOnlyMemory<byte>`（WTF-8，字节坐标） |

### 1.3 构建与发布形态

| 形态 | 命令要点 | 结果（本机实测） |
| --- | --- | --- |
| Go（对照基线） | `CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -ldflags="-s -w" -tags=noembed` | 24.1 MB，构建 128 s |
| Go（CPU 特化） | 同上，`GOAMD64=v3` | 24.0 MB，构建 69 s |
| C# CoreCLR（框架依赖） | `dotnet publish -p:PublishAot=false --self-contained false` | `tsc.exe` + `TypeScript.Compiler.dll`（8.6 MB IL），发布 47 s |
| C# ReadyToRun | 同上 + `-p:PublishReadyToRun=true` | `TypeScript.Compiler.dll` 26.8 MB（含本机代码），启动显著改善 |
| C# NativeAOT | `dotnet publish -r win-x64 -p:PublishAot=true` | 28–30 MB 原生可执行文件，ILC 编译仅 **62–95 s** |
| C# NativeAOT（Server GC / native ISA） | `-p:ServerGarbageCollection=true` / `-p:IlcInstructionSet=native` | 同上 |

> 说明：两侧都编译了 `-tags=noembed` / `-p:EmbedTypeScriptLibraries=false`，即**都从磁盘读取同一批 108 个 `lib.*.d.ts`**，把标准库 I/O 对等化（这也是仓库既有对比采用的口径）。

### 1.4 结构性差异（性能相关）

| 维度 | Go 实现 | C# 实现 |
| --- | --- | --- |
| AST 分配 | 51 种高频节点使用**类型化 arena**，符号/签名/索引信息也在 arena 中 | 全部 192 种节点 `new` 到托管堆（每个对象含 16 B 对象头 + 引用字段） |
| 文本 | `string`/`[]byte`，零拷贝切片 | `Utf8String` over `ReadOnlyMemory<byte>`，显式所有权模型 |
| 并发原语 | goroutine + `WorkGroup`（**每文件一个 goroutine，无上限**） | `Task` + `SemaphoreSlim(4)`（**解析/绑定并发写死为 4**） |
| 检查器池 | `MaxCheckers` 默认 **4**（FENNEL 分区） | `DefaultCheckerCount` 默认 **4**（FENNEL 分区，与 Go 对齐） |
| 发射 | **每文件一个 goroutine**，按 checked-file 分区取用池化 checker，`sync.Pool` 复用 `EmitTextWriter` | **单个 `foreach + await` 串行**，每文件新建 writer/scanner，emit 期间共用一个 checker |
| 启动 | 静态链接、无运行时初始化 | CoreCLR：JIT + 类型初始化；NativeAOT：编译期静态初始化 |

---

## 2. 测试方法

### 2.1 驱动器

使用仓库自带的官方配对基准驱动 `csharp/tools/performance-cli.mjs`（以及 `performance-common.mjs`、`performance-metrics.ps1`），它提供：

- 9 个合成夹具 + 项目引用夹具（`empty/small/medium/declarations/tiny-files/tiny-incremental/huge-file/host-paths/build`），两侧生成**完全相同**的输入树；
- 每个工作负载 **3 组预热 + N 组实测**，同一对内**交替先后顺序**（偶数轮 go→csharp，奇数轮反向），消除顺序偏差；
- 用 `performance-metrics.ps1`（`GetProcessMemoryInfo` / `GetProcessIoCounters`）采集**墙上时间、进程 CPU 时间、峰值工作集**；
- 对每一对做**普通产物逐字节比对**（退出码、stdout、发射文件字节），不一致即断言失败；
- 中位数 + 4000 次成对 bootstrap 95% 置信区间。

**唯一的、已记录的偏离**：上游会用 `GetLastInputInfo` 丢弃“有键盘/鼠标活动”的配对。本机存在**每秒一次的合成输入**（实测 12 次采样 `GetLastInputInfo` 每次都 +1000 ms，系统空闲时间从未超过 1 s），该门禁会拒绝 100% 的配对。因此本地副本把该判定改为**记录**（`pair.inputActivity`）而非拒绝，其余逻辑逐字未改；可靠性改用“同二进制参照控制”和进程 CPU 时间来刻画。

### 2.2 配置矩阵

| 代号 | 运行时 | GC | 指令集 | 备注 |
| --- | --- | --- | --- | --- |
| `go-v1` | Go 1.27.1 | Go GC | `GOAMD64=v1`（发行基线） | 主对照 |
| `go-v3` | Go 1.27.1 | Go GC | `GOAMD64=v3` | 量化 Go 的 ISA 上限 |
| `naot-svr` | NativeAOT | Server GC | x64 便携基线（SSE2） | C# 主候选 |
| `naot-wks` | NativeAOT | Workstation GC | x64 便携基线 | 内存/启动更优 |
| `naot-svr-native` | NativeAOT | Server GC | **host native** | ISA 对照 |
| `r2r` | CoreCLR + ReadyToRun | Workstation（默认） | 运行时默认 + tiered PGO | 托管中间态 |
| `coreclr` | CoreCLR（纯 JIT） | Workstation（默认） | tiered + 动态 PGO | 最差启动 |
| `naot-svr-patched` | NativeAOT | Server GC | x64 便携基线 | 仅用于“解析并发”单变量实验（见 6.6） |

### 2.3 噪声与可靠性（必须先看）

- 每个批次内部都跑一段“**同一个 Go 二进制 vs 自己**”的 `--version` 参照控制，其**成对相对差 p95** 在 8.9%–30.9% 之间（R1 8.9%、R2 19.6%、R3 16.6%、R4 16.9%、R5 30.9%）。短进程受调度/磁盘影响很大。
- 同一份 `go-v1 vs naot-svr` 对比做过一次**子集复现**（R6，11 组样本）：medium 349.2 → 354.7 ms（+1.6%），tiny-files 552.6 → 769.7 ms（**+39%**，该批次整体变慢，Go 侧也同步从 305.9 → 398.5 ms）。**绝对值在批次之间可漂移 30%，因此本报告以“同批次内配对比值”为准，跨批次绝对值仅作描述。**
- 本机为笔记本级 HX 平台且长期有 IDE/桌面程序占用（测量期间仍可观测到 ZCode、VBCheck 等外部 CPU），绝对数字明显高于仓库既有报告所用的 i7-13700K 台式机（例如 Go `medium` 本机 111 ms vs 该机 55 ms）。**比值可迁移，绝对值不可迁移。**
- 进程 CPU 时间由 `TotalProcessorTime` 得到，量化步长 15.625 ms，短负载（<100 ms）的 CPU 数字只能粗看。

### 2.4 与分析口径的对应

| 本报告 | 仓库既有证据 |
| --- | --- |
| `--extendedDiagnostics` 阶段归因 | 仓库未发布过 emit 阶段的独立数据（本项目首次给出） |
| NativeAOT Server/Workstation GC 同机配对 | `docs/csharp-go-performance.md` 有跨批次表格 |
| ReadyToRun、native ISA、tiering 开关 | 仓库“完全未测”清单中的项目 |
| 真实项目负载（`packages/typescript`，113 文件 / 1.63 MB） | 仓库只用合成夹具 |

---

## 3. 测量结果

![C# 各发布形态相对 Go 的差距，以及差距的主因（并行度）](charts/csharp-vs-go-summary.png)

左图：C# 各发布形态相对 Go 1.27.1 的墙上时间比（同批次配对中位数，红线为 Go=1.00×）。右图：并行度 = 进程 CPU 时间 / 墙上时间；C# 的总 CPU 时间在多文件负载上**低于** Go，但并行度只有 1.0–1.2×。

### 3.1 主对比：Go 1.27.1 (v1) vs C# NativeAOT + Server GC（R1，21 组样本）

单位 ms（中位数）。`ratio` 为成对中位数比值，CI 为成对 bootstrap 95%。

| 工作负载 | Go | C# NAOT-SVR | ratio | 95% CI | Go CPU | C# CPU | Go MiB | C# MiB |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| help | 58.1 | 71.0 | 1.22 | 1.17–1.33 | 31.2 | 31.2 | 10.8 | 14.8 |
| version | 55.1 | 71.3 | 1.30 | 1.25–1.34 | 15.6 | 46.9 | 10.5 | 14.3 |
| empty-project | 58.1 | 76.6 | 1.32 | 1.28–1.42 | 15.6 | 46.9 | 12.2 | 17.1 |
| small-first-diagnostic | 62.0 | 87.5 | 1.41 | 1.39–1.46 | 31.2 | 46.9 | 18.6 | 23.8 |
| medium（64 模块） | 111.2 | 349.2 | **3.14** | 2.98–3.19 | 312.5 | 421.9 | 60.2 | 126.8 |
| declarations | 104.6 | 265.9 | 2.54 | 2.50–2.60 | 218.8 | 312.5 | 55.0 | 119.8 |
| tiny-files（512 文件） | 305.9 | 552.6 | 1.81 | 1.75–1.85 | 859.4 | 593.8 | 50.7 | 49.1 |
| huge-file（16,384 声明） | 450.1 | 1625.1 | **3.61** | 3.51–3.73 | 468.8 | 2578.1 | 163.4 | 322.2 |
| host-paths（非 ASCII 深路径） | 65.1 | 129.8 | 1.99 | 1.88–2.05 | 46.9 | 109.4 | 19.4 | 24.2 |
| tiny-files-noemit | 147.6 | 170.2 | **1.15** | 1.12–1.23 | 328.1 | 218.8 | 39.9 | 36.3 |
| tiny-files-noemit-on-error | 309.2 | 587.3 | 1.90 | 1.81–1.97 | 843.8 | 609.4 | 55.7 | 48.2 |
| tiny-files-incremental-edit | 316.0 | 596.8 | 1.89 | 1.79–1.97 | 1093.8 | 625.0 | 64.7 | 53.2 |
| medium-checkers-1 | 128.8 | 386.7 | 3.00 | 2.94–3.17 | 437.5 | 375.0 | 57.1 | 125.3 |
| medium-checkers-2 | 112.0 | 345.3 | 3.08 | 2.99–3.17 | 375.0 | 375.0 | 59.7 | 125.8 |
| medium-checkers-4 | 109.4 | 346.9 | 3.17 | 3.06–3.28 | 359.4 | 406.2 | 60.2 | 126.7 |
| medium-checkers-8 | 106.8 | 337.4 | 3.16 | 2.99–3.23 | 390.6 | 375.0 | 59.5 | 127.6 |
| medium-256m-heap-setting | 106.3 | 294.7 | 2.77 | 2.71–2.89 | 328.1 | 406.2 | 60.2 | 68.4 |
| project-references-clean | 68.5 | 110.6 | 1.62 | 1.56–1.70 | 46.9 | 78.1 | 21.8 | 27.6 |
| project-references-noop | 54.7 | 78.5 | 1.44 | 1.34–1.58 | 15.6 | 46.9 | 13.0 | 16.1 |
| project-references-implementation | 61.4 | 89.0 | 1.45 | 1.40–1.48 | 31.2 | 46.9 | 21.4 | 24.8 |
| project-references-declaration | 65.1 | 103.7 | 1.59 | 1.51–1.65 | 31.2 | 62.5 | 22.1 | 27.7 |
| project-references-config | 66.2 | 96.4 | 1.46 | 1.41–1.52 | 31.2 | 62.5 | 21.2 | 24.7 |
| project-references-package | 63.4 | 106.8 | 1.69 | 1.59–1.83 | 46.9 | 62.5 | 20.7 | 26.3 |

**立刻可见的三件事**

1. `tiny-files-noemit` **1.15×** 与 `project-references-noop` **1.44×** 说明：当“发射”被排除后，C# 与 Go 的距离一下缩小一个数量级。
2. `medium-checkers-N` 从 1 到 8：Go 128.8→106.8 ms（−17%），C# 386.7→337.4 ms（−13%）。**增加检查器数量对双方都只有温和帮助**，C# 并没有因为“默认 4 个检查器”而在这一项吃亏（Go 默认同样是 4）。
3. `medium-256m-heap-setting` 让 C# 从 349.2 → 294.7 ms（−16%），说明**内存压力/GC 直接参与了 C# 的耗时**。

### 3.2 配置矩阵（同负载、不同发布/运行配置）

比值 = C# / 同批次 Go。四个代表性负载：

| 配置 | version | medium | tiny-files | huge-file | 峰值内存（medium / huge，MiB） |
| --- | ---: | ---: | ---: | ---: | --- |
| **NAOT + Workstation GC** | **1.09** | **3.02** | **1.77** | 3.83 | **55.5 / 238** |
| NAOT + Server GC | 1.30 | 3.14 | 1.81 | **3.61** | 126.8 / 322 |
| NAOT + Server GC + native ISA（对手为 `go-v3`） | 1.32 | 3.11 | 1.68 | 3.48 | — |
| CoreCLR + ReadyToRun | 1.65 | 8.27 | 3.11 | 8.09 | 87.7 / 277.8 |
| CoreCLR（纯 JIT） | 4.76 | 15.39 | 5.17 | 10.30 | 100.9 / 287.5 |

完整（10 项）CoreCLR / R2R 结果：

| 工作负载 | Go | ReadyToRun | ratio | CoreCLR | ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| help | 59.5 | 105.8 | 1.78 | 299.8 | 5.08 |
| version | 59.4 | 98.1 | 1.65 | 277.0 | 4.76 |
| empty-project | 55.9 | 177.3 | 3.17 | 481.1 | 7.78 |
| small-first-diagnostic | 60.1 | 251.5 | 4.19 | 784.4 | 11.98 |
| medium | 109.6 | 906.7 | 8.27 | 1766.8 | 15.39 |
| declarations | 101.7 | 562.3 | 5.53 | 1235.5 | 13.44 |
| tiny-files | 300.5 | 935.2 | 3.11 | 1340.5 | 5.17 |
| huge-file | 458.4 | 3708.0 | 8.09 | 4291.8 | 10.30 |
| tiny-files-incremental-edit | 356.0 | 1178.1 | 3.31 | 1634.7 | 5.25 |
| project-references-noop | 62.6 | 164.9 | 2.63 | 363.0 | 6.62 |

**发布形态的结论**：NativeAOT 是 C# 的唯一有竞争力的默认形态；ReadyToRun 只能把托管版从“不可用”拉回“明显落后”；纯 JIT CoreCLR 在 CLI 场景没有竞争力（但见 3.4，它在**稳态吞吐**上反而是 C# 家族最强的）。

### 3.3 阶段归因（`--extendedDiagnostics`，双方自带）

C# 的阶段是“summed（跨并行任务求和）”，Go 报告的是各阶段耗时；两者的**相位总和与总时间的关系本身**就暴露了并行度：

**huge-file（16,384 声明，单文件）**

| 阶段 | Go (s) | C# (s) | 比值 |
| --- | ---: | ---: | ---: |
| Config | 0.001 | 0.006 | 6.0 |
| Parse | 0.049 | 0.071 | 1.45 |
| Bind | 0.031 | 0.063 | 2.03 |
| Check | 0.098 | 0.324 | **3.31** |
| Emit | 0.171 | 1.064 | **6.22** |
| 相位和 | 0.350 | 1.528 | 4.37 |
| Total（墙上） | 0.350 | 1.621 | 4.63 |
| 内存 | 峰值 85 MB / 1,263,824 次分配 | 存活 93.9 MB / **累计分配 931 MB** | — |

**medium（64 模块）**

| 阶段 | Go (s) | C# (s) | 比值 |
| --- | ---: | ---: | ---: |
| Parse | 0.016 | 0.017 | 1.06 |
| Bind | 0.003 | 0.008 | 2.67 |
| Check | 0.005 | 0.095 | 19.0* |
| Emit | 0.021 | 0.190 | 9.05* |
| 相位和 / Total | 0.045 / 0.045 | 0.310 / 0.264 | 并行度 1.00 vs 1.17 |
| 累计分配 | — | 160.5 MB | — |

**tiny-files（512 文件）**

| 阶段 | Go (s) | C# (s) | 备注 |
| --- | ---: | ---: | --- |
| Parse | 0.070 | **0.008** | C# 在这项**远快于** Go（并行 + 小文件） |
| Bind | 0.002 | 0.009 | |
| Check | 0.001 | 0.003 | |
| Emit | 0.134 | **0.329** | C# 串行发射，占其总时间 78% |
| 相位和 / Total | 0.207 / 0.209 | 0.389 / 0.423 | 并行度 0.99 vs 0.92 |

\* medium 的 check/emit 比值受 Go 侧“检查可能被并入发射统计”的口径影响，只能作方向性参考；huge-file 与 tiny-files 的表征是一致的：**C# 的瓶颈阶段是 emit，其次是 check。**

**关键推论：解析不是瓶颈——但这条只对“小文件极多”的负载成立。** 512 个一行的文件在 C# 侧（并行求和）解析只要 8 ms，在 Go 侧要 70 ms，这直接解释了 6.6 节“解析并加上限”实验为何没有收益。**对真实工程（186 文件 / 51,665 行，含 2.3 MB 的 `lib.dom.d.ts` 与真实模块图），结论相反：C# 的解析+绑定求和耗时是 Go 的 3.5–3.7 倍（见 6.8）。**

### 3.4 并行度：把差距归因到“没有并行”

用 R1 每项的进程 CPU 时间 / 墙上时间：

| 工作负载 | Go CPU/墙上 | C# CPU/墙上 | 结论 |
| --- | ---: | ---: | --- |
| medium | 312.5 / 111.2 = **2.81×** | 421.9 / 349.2 = **1.21×** | C# 少用 1.6 个核 |
| declarations | 218.8 / 104.6 = 2.09× | 312.5 / 265.9 = 1.18× | 同上 |
| tiny-files | 859.4 / 305.9 = **2.81×** | 593.8 / 552.6 = **1.07×** | C# 几乎串行，且**总 CPU 比 Go 少 31%** |
| tiny-files-noemit | 328.1 / 147.6 = 2.22× | 218.8 / 170.2 = 1.29× | C# 总 CPU 只有 Go 的 67% |
| tiny-files-incremental | 1093.8 / 316.0 = 3.46× | 625.0 / 596.8 = 1.05× | C# 总 CPU 只有 Go 的 57% |
| huge-file（单文件） | 468.8 / 450.1 = 1.04× | 2578.1 / 1625.1 = 1.59× | 单文件无法用文件级并行，C# 需要**5.5× 的 CPU** |
| huge-file（Workstation GC） | — | 1656.2 / 1648.5 = 1.00× | 说明 Server GC 多出的 CPU 是 GC 线程 |

这张表是本报告最重要的证据：

- **在多文件负载上，C# 的“有用功”不超过 Go（甚至只有 57%–67%），但墙上时间更长——因为 Go 把工作铺到了约 3 个核上，而 C# 只用了约 1.1 个核。**
- **只有单巨文件负载体现了真实的单核吞吐差距**（C# 5.5× CPU、3.6× 墙上），这里没有并行度可借。

### 3.5 内存与 GC

| 指标 | Go | C# NAOT-WKS | C# NAOT-SVR | C# CoreCLR |
| --- | ---: | ---: | ---: | ---: |
| medium 峰值 RSS | 60.2 MiB | **55.5** | 126.8 | 100.9 |
| huge-file 峰值 RSS | 163.4 MiB | 238 | 322 | 287 |
| tiny-files 峰值 RSS | 50.7 MiB | 41.3 | 49.1 | 88.6 |
| version 峰值 RSS | 10.5 MiB | 10.9 | 14.3 | 88.6 |
| huge-file 累计分配 | 1.26 M 次分配（arena 为主） | **931 MB**（存活 93.9 MB） | 同左 | — |
| medium 累计分配 | — | 160.5 MB | 同左 | — |

- **工作站 GC 在本机是严格优于 Server GC 的选择**：速度相同（medium 3.02× vs 3.14×，huge 3.83× vs 3.61×），内存减半（medium 55.5 vs 126.8 MiB），启动更快（1.09× vs 1.30×）。这与仓库既有报告（在 24 核 i7 上 Server GC 略优）不同，原因是 **Server GC 会按逻辑核数（32）建堆，而该 loader 并不 GC 吞吐受限**；这属于“配置必须随机器规模标定”的典型例子。
- `huge-file` 每行源码的累计分配 ≈ **43 KB/行**（931 MB / 21,389 行），是 C# 端 GC 压力的直接来源。
- Go 侧 1.26 M 次分配但峰值只有 85 MB，说明其分配以 **arena bump-pointer** 为主，回收成本极低；这正是 C# 缺少的结构性优势。

### 3.6 单变量 A/B 实验（同批次配对，均在同一批次内交替测量）

> 见 6.1–6.7 的完整说明与数值；此处先给出结论摘要。

| 实验 | 变量 | 结论 |
| --- | --- | --- |
| AB1 | Go `GOAMD64` v1 → v3 | 无收益（−0.5%~+1.7%），**指令集不是杠杆** |
| AB2 | C# `IlcInstructionSet` 便携基线 → native | 无收益（−0.5%~+2.8%），结论同上 |
| AB3 | C# Workstation GC ↔ Server GC（同代码、烘焙配置） | **WKS 在 3/4 负载上快 5–11% 且内存减半**；SVR 只在单巨文件上快 7.2% |
| AB4 | CoreCLR 纯 JIT → ReadyToRun | **启动 −60~64%、吞吐 −18~48%**，托管形态必选 |
| AB5 | CoreCLR tiered 编译开 → 关 | 关闭后启动 +36%、medium +30%、tiny +44%；但单巨文件 −26% |
| AB6/AB7 | 解析并发上限 4 → 32 / 8（补丁版） | **无收益（±2.4% 内）= 证伪**，见 6.6 |
| AB8 | 同一 Go 二进制自我配对（真实负载） | 偏差/噪声 **≤1.1%**（CI 全部覆盖 1.0）→ 本报告可靠性下界 |
| AB9 | 未打补丁 vs “解析并发自动”补丁端到端 | 无收益（CI 全部覆盖 1.0） |

### 3.7 真实项目负载

见 6.8：`packages/typescript`（113 个 TS 文件 / 1.63 MB，仓库自身的 byte-coordinate 客户端）在 7 种配置上的完整编译对比。

### 3.8 与仓库既有证据的一致性

| 维度 | 仓库既有报告 | 本次测量 | 判断 |
| --- | --- | --- | --- |
| Go 是否全面领先 | 是（每个负载、每轮） | 是（23/23 项） | 一致 |
| NativeAOT 启动 ≈ Go | NAOT 30.7 vs Go 28.1–29.5（1.075×） | 60.2 vs 55.2（1.09×，WKS） | 一致（比值几乎相同） |
| CoreCLR 启动极慢 | 179.8 vs 28.1（6.4×） | 277.0 vs 58.3（4.76×） | 一致 |
| medium / huge-file 差距 | CoreCLR 15–21×、NAOT 1.08–3.88× | CoreCLR 15.4×/10.3×、NAOT 3.1×/3.6× | 一致 |
| Server GC 优于 WKS | 24 核 i7：huge-file 995.9 vs 1100.7 | 32 逻辑核：1625 vs 1648（持平），内存翻倍 | **不一致 → 需按机器规模标定 GC** |
| 默认检查器数 | 未记录 | Go 4 / C# 4（两侧一致） | 新增事实 |
| emit 阶段耗时 | 未发布 | emit 是 C# 最大且差距最大的阶段（6.2×） | **本次新增的关键事实** |
| 指令集基线 | “完全未测” | 两侧均无收益 | **本次新增的关键事实** |

---

## 4. 差距归因（按贡献排序）

### 4.1 第一性原因：C# 的并行度只有 Go 的 1/3

- 多文件负载上 C# 的 CPU/墙上并行度 1.05–1.21×，Go 为 2.09–3.46×；C# 的**总 CPU 时间反而更少**（tiny-files 为 Go 的 69%、incremental 为 57%）。
- 具体机制（源码级）：
  1. **发射完全串行**：`Programs/CompilerProgram.Emit.cs:44-55` 是 `foreach (var source in targets) await emitter.EmitAsync(...)`；Go 在 `tsc/internal/compiler/program.go:1845-1880` 与 `tsc/internal/execute/incremental/emitfileshandler.go:124-167` 为每个文件排队一个 goroutine，并从池中借出该文件分区的 checker。
  2. **每文件新建 writer/scanner**，Go 用 `sync.Pool` 复用 `EmitTextWriter`（`program.go:1834-1837`）。
  3. 解析/绑定并发被 `SemaphoreSlim(4)` 限死（`CompilerProgram.cs:181,207,276-277,787-800`），Go 无上限（`workgroup.go:34-42` —— 每任务一个 goroutine）。**但实测该项不是瓶颈**（解析本身只占 C# tiny-files 总时间的 2%）。
- 该原因可以解释 medium / tiny-files / incremental / noemit-on-error 上的绝大部分差距（这三类负载在排除 emit 后差距从 1.8–1.9× 掉到 1.15×）。

### 4.2 第二原因：单文件/单核吞吐（3.3–6.2×）

`huge-file`（单文件，无法用文件级并行）暴露真实差距：解析 1.45×、绑定 2.0×、检查 3.3×、发射 6.2×，累计分配 931 MB（43 KB/行源码）。这里没有并行度可借，只能靠**减少分配、复用缓冲、去掉热路径上的重复查找**来收敛。

### 4.3 第三原因：启动期成本（仅托管形态）

- CoreCLR 纯 JIT：`--version` 277 ms，其中绝大多数是运行时初始化 + 8.6 MB IL 的分层 JIT 编译；`--help` 的 CPU 时间 281 ms 几乎全部消耗在启动。
- ReadyToRun 把 `--version` 降到 98 ms（−65%），说明**“JIT 编译这套大 IL”本身就是启动成本的主体**。
- NativeAOT 把它压到 60–71 ms（与 Go 的 55 ms 同量级），剩下的是进程创建 + 只读数据分页 + 静态初始化。

### 4.4 第四原因：托管堆分配与 GC 记账

- 单巨文件累计分配 931 MB（存活 93.9 MB，约 10× churn）；medium 160 MB。
- Server GC 在 32 逻辑核上产生 32 个堆，多出的 CPU 记账（huge-file 2578 ms vs WKS 1656 ms）几乎全是 GC 线程开销，而墙上时间没有变快。
- `DOTNET_GCHeapHardLimit=256 MiB` 一档让 medium 从 349.2 → 294.7 ms（−16%），说明 GC 压力直接表现为时间。

### 4.5 不是原因的因素（已排除）

- **指令集/向量化**：Go v1→v3、C# 便携基线→native 都没有收益（≤3%，落在噪声内）。编译器负载以指针追逐、哈希表探测、分支为主。
- **解析性能**：C# 侧 512 文件解析（并行求和）8 ms，反而远快于 Go 的 70 ms。
- **检查器默认数量**：两侧都是 4，且 1→8 的扩展性都只有 13%–17%。
- **算法/语义差异**：两侧产物逐字节一致（驱动器对每组配对都做普通产物比对），诊断计数一致，因此差距不是“C# 少做了事”。

---

## 5. C# 优化方案（按性价比排序）

> 每项标注：**预期收益**（基于本次实测或仓库既有实验的可比数字）、**工作量**、**风险**。预期收益是工程判断，不是承诺；标注“实测”的项已在本次或仓库既有测量中直接验证。

### Tier A — 零代码/低风险配置（建议立即执行）

| # | 改动 | 证据 | 预期收益 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- |
| A1 | CLI 发行默认改为 **NativeAOT + Workstation GC**（或在 ≥16 逻辑核时限制 Server GC 堆数） | 实测：启动 1.30→**1.09**×，medium 峰值 126.8→**55.5** MiB，速度不变 | 启动 −16%，内存 −56% | 低 | 低 |
| A2 | 保留 ReadyToRun 作为“框架依赖托管发行”形态 | 实测：`--version` 277→**98** ms，medium 1766→**907** ms | 托管形态启动 −65%，吞吐 −49% | 低 | 低 |
| A3 | 显式设置 GC 参数：`GCHeapHardLimit`/`GCConserveMemory`/`GCHeapCount`/`GCNoAffinitize`，并在 CLI 路径按机器规模选择 | 实测：256 MiB 硬限制让 medium −16%；32 堆 SVR 无收益 | 5–20%（视负载） | 低 | 低 |
| A4 | `--checkers` 默认值由常量 4 改为 `max(4, min(ProcessorCount, 8))`（含 FENNEL 分区复核） | 实测：medium checkers 4→8 为 346.9→337.4 ms（−3%），1→8 为 −13% | 5–13% | 低 | 低（内存 +2×） |
| A5 | 削减启动期静态初始化：2213 条诊断消息的字段初始化 + `ToFrozenDictionary`、4 个从字面量构造的 `FrozenSet`、595 个 UTF-8 字面量 | 源码审计（`Diagnostics/Messages.generated.cs:205,2219`、`Configuration/LocaleIdentifier.generated.cs:10-444`、`Text/Utf8Literals.cs:6-601`） | 启动 −10~30 ms | 低 | 低 |

### Tier B — 并行化（收益最大，建议作为主攻方向）

| # | 改动 | 证据 | 预期收益 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- |
| B1 | **发射并行化**：`EmitCoreAsync` 按文件分区并行；每分区借用 `CheckerPool` 租约；池化 writer/scanner；把 build-info/输出回调/诊断合并串行化 | 实测：tiny-files emit 占 C# 总时间 **78%**，emit 阶段差距 **2.5–6.2×**；排除 emit 后整体差距降到 **1.15×** | **tiny-files 1.81→1.1×、medium 3.14→1.6×、incremental 1.89→1.2×** | 中高 | 中（输出顺序、诊断去重、内存峰值） |
| B2 | 检查器池扩容 + 分区均衡（A4 的延伸：按文件规模而非文件数分区） | 实测：1→8 checker 双方都只改善 13–17%，说明分区/合并开销在抵消 | 5–15% | 中 | 中 |
| B3 | ~~解析/绑定并发上限 4 → ProcessorCount~~ | **实测证伪**：4 vs 32 无差异（167 vs 173 ms） | **0%** | — | — |

### Tier C — 分配与内存（决定单巨文件/单核吞吐的天花板）

| # | 改动 | 证据 | 预期收益 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- |
| C1 | 高频 AST 节点/符号采用**分段 arena 或对象池**（对齐 Go 的 51 种 arena 节点） | 实测：huge-file 累计分配 931 MB / 存活 93.9 MB；Go 1.26 M 次 arena 分配仅 85 MB 峰值。**注意仓库 phase-1 原型测得 arena 慢 18.5%，必须重新设计实验（按种类分段、保持引用可见性）** | 分配 −30~50%，墙上 10–25% | 高 | 高 |
| C2 | 去掉签名/类型参数构造中的 `ReadOnlyCollection` 包装（每签名 2×`ToArray` + 2×`AsReadOnly`，42 处） | 同类改动（符号声明列表）仓库实测分配 −3.0~5.7% | 分配 −4~8% | 低 | 低 |
| C3 | 数字字面量文本缓存（Go 有 `numberCache`/`hexNumberCache`），并消除 `Scanner.Char()` 每次派生 span | huge-file 有 16,384 个数字字面量；Go `scanner.go:2190-2202` | 1–3% | 低 | 低 |
| C4 | 打印器热路径：`EmitContext` 每节点 5 次字典探测 → 1 次；`Part`（~120 B）工作列表缩小/池化；writer/scanner 复用 | `Emission/EmitContext.cs:33-169`、`Emission/SyntaxPrinter.cs:34-385` | emit 5–15% | 中 | 中 |
| C5 | `GetChild(i)`/`ChildCount` 的 O(C²) 访问改为生成式直接遍历 | `Ast/SyntaxNode.cs:75-77`、`Ast/Nodes.generated.cs:198-205`；被 binder 与 22 处 checker 子树扫描使用 | 1–4% | 中 | 中 |
| C6 | **program construction（模块解析 + 绑定）路径专项优化** —— 真实工程上 C# 的 parse+bind 求和耗时是 Go 的 3.5–3.7 倍（6.8），而这段负载不触发检查与发射 | 6.8 的 `--noEmit` 阶段数据；`Programs/CompilerProgram.cs` 的 resolver/`Program` 构建路径 | 真实工程 1.5–2.5× → 1.1–1.5× | 高 | 中 |

### Tier D — 检查器每核吞吐（3.3× 的真实差距，长线）

| # | 改动 | 证据 | 预期收益 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- |
| D1 | `CheckerSymbols.Binding(node)` 的父链遍历 + 双字典探测改为节点内联槽位（307 处调用点） | `Checking/CheckerSymbols.cs:102-115`；Go 为一次接口调用 + 字段读 | 1–3% | 中 | 中 |
| D2 | 检查器内部容器去 `ImmutableArray`/`ReadOnlyCollection` 化（数组 + 长度） | `Checking/Types.cs:43,202,278-279,403` | 2–6% | 中 | 中 |
| D3 | 对齐 Go 的“按文件池化 checker + 状态复用”模型（尤其增量场景） | Go `checkerpool.go` 租约模型 | 5–20%（增量/LSP 更明显） | 高 | 高 |
| D4 | 用 `dotnet-trace` CPU 采样 + `dotnet-counters` 对 huge-file 做定点剖析，替换本报告的“按代码频次推断” | 本报告未做（工具已就绪） | 定位性收益 | 低 | 低 |

### Tier E — 已证伪/已关闭，不要重复投入

- 在 parser/binder/checker 引入 async（runtime-async 已开启且编译器生成状态机为 0；常规 async 在 AOT 下慢 30–53%；同步 binder 无收益并被回滚）。
- 递归栈池化、`NodeList` 结构体枚举、每扫描器标识符驻留（仓库既有实验均为“更慢”或“无收益”）。
- 打开 AVX/AVX-512 或 `IlcInstructionSet=native`（实测无收益）。
- 无条件启用 Server GC（本机负收益）。
- 单纯提高解析并发（实测无收益）。

---

## 6. 单变量 A/B 实验（同批次配对）

> 本节数值由 `bench/AB*/summary.json` 与 `logs/AB*.log` 支撑；`before`/`after` 在同批次内交替测量，CI 为成对 bootstrap 95%。

### 6.1 Go 的指令集上限（AB1：`GOAMD64=v1` → `v3`）

| 工作负载 | v1 | v3 | 变化 |
| --- | ---: | ---: | ---: |
| version | 54.29 | 55.23 | +1.7% |
| medium | 104.37 | 104.72 | +0.3% |
| declarations | 93.22 | 93.66 | +0.5% |
| tiny-files | 273.16 | 271.73 | −0.5% |
| huge-file | 417.24 | 422.44 | +1.2% |

**结论**：把 Go 从 SSE2 基线切到 AVX2（v3）**没有收益**。编译器负载是分支/指针密集型；这也说明仓库“未发布的 native ISA”研究价值有限。

### 6.2 C# 的指令集上限（AB2：`IlcInstructionSet` 便携基线 → native）

| 工作负载 | 便携基线 | native | 变化 |
| --- | ---: | ---: | ---: |
| version | 65.22 | 67.02 | +2.8% |
| medium | 327.49 | 325.95 | −0.5% |
| declarations | 223.37 | 222.71 | −0.3% |

**结论**：与 Go 侧一致，**host-native 指令集不构成优化杠杆**（差异落在噪声内，`--version` 因二进制更大而更慢）。

### 6.3 GC 模式：Workstation vs Server（AB3，同一份代码，各自使用编译期烘焙的 GC 配置）

`before` = `naot-wks`（编译时 `ServerGarbageCollection=false`），`after` = `naot-svr`（`=true`）；本批次额外传入 `--no-gc-env`，避免驱动用环境变量把两侧统一成同一模式。

| 工作负载 | WKS | SVR | SVR 相对变化 | 95% CI | WKS 峰值 | SVR 峰值 |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| medium | 306.8 | 328.3 | **+7.0%** | 1.05–1.12 | **55.5 MiB** | 126.5 MiB |
| declarations | 228.4 | 252.8 | **+10.6%** | 1.06–1.16 | **55.7 MiB** | 119.6 MiB |
| tiny-files | 483.2 | 507.7 | +5.1% | 1.00–1.10 | 41.4 MiB | 48.5 MiB |
| huge-file | 1508.0 | 1399.2 | **−7.2%** | 0.92–0.95 | 238.1 MiB | 320.7 MiB |

**结论**：**在这台 32 逻辑核机器上，Workstation GC 在 3/4 负载上更快，并且内存只有 Server GC 的约 44%–66%；Server GC 只在“单个大文件”上快 7%（代价是 +83 MiB 峰值内存）。** 与仓库既有报告（24 核 i7 上 Server GC 略优）相反 —— 说明 **GC 模式必须按机器核数标定**，不能当作固定结论。若采用 Server GC，应同时用 `GCHeapCount`/`GCNoAffinitize` 限制堆数。

### 6.4 ReadyToRun 对托管形态的价值（AB4，CoreCLR → ReadyToRun）

| 工作负载 | 纯 JIT | R2R | 变化 | 95% CI | RSS JIT → R2R |
| --- | ---: | ---: | ---: | --- | --- |
| version | 221.8 | **79.8** | **−64.0%** | 0.33–0.37 | 88.6 → 26.5 MiB |
| empty-project | 376.1 | **149.1** | **−60.3%** | 0.39–0.40 | 88.6 → 34.1 MiB |
| medium | 1530.3 | **789.6** | **−48.4%** | 0.50–0.55 | 100.9 → 87.8 MiB |
| tiny-files | 1296.1 | **805.6** | −37.8% | 0.59–0.64 | 88.6 → 73.3 MiB |
| huge-file | 4008.7 | **3295.5** | −17.8% | 0.80–0.83 | 287.2 → 277.6 MiB |

**结论**：ReadyToRun 是“必须托管运行时”场景下的**低成本、确定性收益**（启动 −60%、吞吐 −18~48%），但仍显著慢于 NativeAOT（见 3.2）。若发行必须框架依赖，应把 R2R 设为强制项。

### 6.5 tiered 编译 + 动态 PGO 开关（AB5，CoreCLR，`DOTNET_TieredCompilation` 1 → 0）

| 工作负载 | tiering 开 | tiering 关 | 变化 |
| --- | ---: | ---: | ---: |
| version | 218.1 | 296.6 | **+36.0%** |
| medium | 1469.4 | 1912.6 | **+30.2%** |
| tiny-files | 1264.9 | 1816.9 | **+43.6%** |
| huge-file | 4043.9 | **2975.3** | **−26.4%** |

**结论**：默认的 **tiered + 动态 PGO 是正确选择**（关掉会让启动和中小负载全面变慢 30%–44%）；唯一的例外是**长时单文件编译**——此时“一上来就用全优化代码”反而更快（−26%）。这提示一个可落地的自适应策略：**短任务保持 tiering，长时批量编译可考虑关闭 tiering**（但需与 R2R/AOT 组合验证）。

### 6.6 解析/绑定并发上限（AB6/AB7，补丁版：4 → 32 / 8）：**证伪**

`before` 强制 `TSHARP_PARSE_CONCURRENCY=4`（等价上游行为），`after` 分别为 32 和 8。

| 工作负载 | 并发 4 | 并发 32（AB6） | 变化 | 并发 8（AB7） | 变化 |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium | 288.5 | 295.5 | +2.4% | 287.0 | −1.0% |
| declarations | 219.0 | 220.9 | +0.9% | 211.4 | −1.9% |
| tiny-files | 441.6 | 442.3 | +0.2% | 440.0 | −0.7% |
| huge-file | 1379.8 | 1389.4 | +0.7% | 1384.4 | +0.2% |
| host-paths | 99.1 | 99.0 | −0.2% | 99.2 | −0.8% |
| tiny-files-noemit | 142.6 | 140.4 | −1.5% | 141.5 | +1.5% |

**结论**：把解析/绑定并发从 4 提到 8 或 32 **没有任何可测收益（全部落在 ±2.4% 内）**。原因是阶段归因已经显示：512 个文件的解析在 C# 侧（跨任务求和）只需 **8 ms**，解析根本不是瓶颈。**这是一个由源码审计高度看好（“20–30% 收益”）、但被实测否定的方向，不应投入。** 真正需要并行化的是**发射**。

### 6.7 同二进制噪声控制（AB8）：本报告的可靠性下界

把**同一个 Go 可执行文件**放在 `before`/`after` 两侧，在真实负载上配对测量 11 组：

| 工作负载 | 第一次 | 第二次 | 比值 | 95% CI |
| --- | ---: | ---: | ---: | --- |
| version | 48.37 | 48.35 | 1.000 | 0.879–1.030 |
| medium | 94.22 | 94.46 | 1.003 | 0.943–1.046 |
| declarations | 88.45 | 89.46 | 1.011 | 0.975–1.028 |
| tiny-files | 244.39 | 240.54 | 0.984 | 0.953–1.017 |
| huge-file | 390.38 | 393.78 | 1.009 | 0.985–1.024 |

**结论**：在**真实工作负载**上，配对交替 + 中位数 + 成对 bootstrap 的偏差与噪声 **≤1.1%**（全部 CI 覆盖 1.0）。这为后续所有结论提供了可靠性下界：
- 主对比里 1.15×–3.61× 的差距远超噪声；
- AB3 的 +7%~+10.6%（GC）、AB5 的 +30%~+44%（tiering）都超出噪声，可信；
- AB6/AB7/AB9 的 ±2% 提升落在噪声内，**应判定为无效果**；
- 注意：驱动内置的“同一二进制 `--version`”控制之所以给出 8.9%–30.9% 的噪声上限，是因为 `--version` 只有 48–60 ms，受进程创建/调度影响极大；一旦负载进入 100 ms 以上，配对设计的精度就提升一个数量级。

### 6.8 真实项目负载（`packages/typescript`：186 个文件 / 51,665 行，含 `lib.dom.d.ts` 2.3 MB）

驱动 `C:\ai\projects\tsbench\realworld.mjs`：7 个后端轮流测量、2 组预热 + 11 组实测、使用同一套 `performance-metrics.ps1` 指标采集器，`tsc --project packages/typescript --noEmit`（该工程本身完全干净，只产生 1 条诊断，7 个后端的诊断计数一致）。

| 后端 | 中位数 | 相对 go-v1 | CPU 时间 | 峰值 RSS | 并行度(CPU/墙上) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **go-v1** | **95.0 ms** | 1.00× | 296.9 ms | 72.5 MiB | 3.13× |
| go-v3 | 94.9 ms | 1.00× | 328.1 ms | 71.8 MiB | 3.46× |
| **naot-svr** | 216.4 ms | **2.28×** | 312.5 ms | 79.7 MiB | 1.44× |
| **naot-svr-native** | 218.2 ms | 2.30× | 328.1 ms | 80.9 MiB | 1.50× |
| naot-wks | 237.2 ms | 2.50× | **281.3 ms** | **64.8 MiB** | 1.19× |
| r2r | 459.2 ms | 4.83× | 640.6 ms | 89.5 MiB | 1.39× |
| coreclr | 802.0 ms | 8.44× | 1218.8 ms | 107.0 MiB | 1.52× |

**这张表比合成夹具更接近“真实工程”**，并且给出三个与合成负载不同的结论：

1. **真实项目的差距比 `medium` 合成夹具小**（2.28–2.50× vs 3.14×），因为真实工程里解析/模块解析占比更高，而这一段的差距小于发射段。
2. **C# 的总 CPU 时间与 Go 相当甚至更低**（naot-wks 281 ms vs go-v1 297 ms），**峰值内存也更低**（64.8 MiB vs 72.5 MiB）——输的仍然是**并行度**（1.19× vs 3.13×）。
3. `--noEmit` 阶段归因显示这段负载几乎不触发检查与发射：C# 报告 Config 18 ms + Program 153 ms（其中 Parse 求和 118 ms、Bind 求和 80 ms），Go 报告 Config 1 ms + Parse 32 ms + Total 44 ms。**在“解析+绑定+模块解析”这一侧 C# 的求和耗时是 Go 的 3.5–3.7 倍**（注意两者阶段口径不同，Go 的 Total 44 ms 明显未涵盖全部实际工作——其 CPU 时间 297 ms 远大于 44 ms），因此这里只能确认方向：**真实工程的瓶颈从 emit 转向了 program construction**。

> 这也修正了 4.5 节的说法：**“解析不是瓶颈”只对“512 个一行的文件”成立**（那种负载里 512 个文件的解析求和只要 8 ms）。对真实工程（含 2.3 MB 的 `lib.dom.d.ts` 与真实模块图），program construction 才是主要成本。

### 6.9 补丁端到端验证、Go 分配量与批次 3 汇总

**AB9：未打补丁的 `naot-svr` vs 打了“解析并发自动 = ProcessorCount”补丁的构建**

| 工作负载 | 未打补丁 | 补丁版 | 比值 | 95% CI |
| --- | ---: | ---: | ---: | --- |
| medium | 291.2 | 293.9 | 1.009 | 0.996–1.049 |
| declarations | 216.0 | 219.4 | 1.016 | 0.972–1.037 |
| tiny-files | 458.1 | 454.5 | 0.992 | 0.963–1.010 |
| huge-file | 1396.4 | 1390.8 | 0.996 | 0.991–1.023 |
| tiny-files-noemit | 153.9 | 164.9 | 1.072 | 0.913–1.105 |

**结论**：端到端也确认该补丁无效（CI 全部覆盖 1.0）。**“提高解析并发”应从优化清单中删除。**

**Go 的分配与 GC 成本（`GODEBUG=gctrace=1`，huge-file）**

```
gc 1 @0.006s 0%: 0+0.53+0 ms clock, ...  4->4->3 MB,   4 MB goal, 32 P
gc 2 @0.011s 0%: ...  6->7->5 MB,   7 MB goal
gc 3 @0.021s 0%: ... 11->12->11 MB, 12 MB goal
gc 4 @0.041s 0%: ... 22->22->22 MB, 23 MB goal
gc 5 @0.061s 3%: ... 42->43->40 MB, 44 MB goal
gc 6 @0.149s 2%: ... 76->77->71 MB, 81 MB goal
gc 7 @0.320s 1%: ... 139->140->89 MB, 142 MB goal
```

- 整个 huge-file 编译只触发 **7 次 GC**，累计分配约 **300 MB**（各周期堆起始值之和），存活峰值约 89 MB；
- **GC 占用的 CPU 只有 0%–3%**，且并发标记几乎不阻塞；
- 对比 C#：累计分配 **931 MB（约 3.1×）**，且 Server GC 下进程 CPU 从 1656 ms（WKS）膨胀到 2578 ms，说明 GC 记账/线程成本显著。

**批次 3 一句话汇总**：同二进制控制证明测量精度 ≤1.1%；解析并发补丁是无效改动；Go 的 GC 成本可以忽略，而 C# 的分配量是 Go 的 3 倍并直接转化为时间与 CPU 成本 —— 这正是 5.C 组优化项（减少分配/arena 化）的量化依据。

---

## 7. 能否超越 Go 的实现？

### 7.1 分维度判定

| 维度 | 当前 | 目标可达性 | 判定 |
| --- | --- | --- | --- |
| 冷启动 / 短命令（`--version`、`--help`、空工程） | 1.09×（AOT+WKS） | A1 + A5 → **1.0–1.10×** | **可以打平** |
| 多文件不发射（`--noEmit`、纯检查） | 1.15× | A4 + B2 + C2/C3 → **1.0–1.10×** | **可以打平** |
| 多文件完整编译（含发射） | 1.77–1.89× | B1（发射并行）+ A4 + C → **1.1–1.6×** | **可以逼近；在核多、文件多的负载上存在反超路径** |
| 单巨文件（16k+ 声明） | 3.6–4.6× | C1（arena）+ D1/D2 → **2.0–2.8×** | **短期难以反超** |
| 峰值内存 | WKS 配置下 ≈ Go（medium 55 vs 60 MiB） | 维持即可 | **可以打平** |
| 服务 / 语言服务（LSP、API、watch） | 仓库既有 1.3–14.2× | AOT + B1/B2 + D3 → 多数进入 **1.1–2×** | **可以逼近，启动类负载可打平** |

### 7.2 为什么“反超”不是空话：把差距拆开看

对多文件负载，把 R1 的墙上时间与 CPU 时间对齐后有：

| 负载 | C# 有用 CPU / Go 有用 CPU | C# 并行度 / Go 并行度 | 若 C# 达到 Go 的并行度 |
| --- | ---: | ---: | --- |
| tiny-files | 593.8 / 859.4 = **0.69** | 1.07 / 2.81 | 593.8 / 2.81 ≈ **211 ms vs Go 305.9 ms（反超 31%）** |
| tiny-files-incremental | 625.0 / 1093.8 = **0.57** | 1.05 / 3.46 | 625.0 / 3.46 ≈ **181 ms vs Go 316.0 ms（反超 43%）** |
| tiny-files-noemit | 218.8 / 328.1 = **0.67** | 1.29 / 2.22 | 218.8 / 2.22 ≈ 99 ms vs Go 147.6 ms（反超 33%） |
| medium | 421.9 / 312.5 = 1.35 | 1.21 / 2.81 | 421.9 / 2.81 ≈ 150 ms vs Go 111.2 ms（仍落后 35%） |

也就是说：**在 512 文件这类“宽而浅”的负载上，C# 现在的总工作量本来就比 Go 少（0.57–0.69×），它输在只用了约一个核。** 这类负载的并行化收益上限足以把结果翻成正数；而 `medium` 这种“文件少、每文件重”的负载，即使用满并行度也只能到 ~1.35×，瓶颈回到每核算力。

> **这是理想上界，不是预测。** 该算式隐含假设：(a) 这部分工作可以按文件完全并行；(b) 并行化不会引入额外 CPU（实际会：并发 GC、内存压力、锁竞争、诊断合并）；(c) 单核效率保持不变。真实收益一定低于上界——发射并行化后合理的预期是**先追平到 1.3×–1.8×，再通过减少分配把 1.8× 推向 1.2×**。真正的结论是方向性的：**在同一批负载上，C# 的问题是可并行化的，而不是“算得比 Go 慢”。**

### 7.3 反过来看：Go 的优势究竟是什么

1. **默认全核并行**（每文件一个 goroutine，解析与发射都是）；
2. **arena 分配**（1.26 M 次分配只换来 85 MB 峰值堆）；
3. **静态链接的即时启动**（本机 55 ms）。

其中第 1 条是**纯工程实现**（.NET 侧只需把 `foreach+await` 改成按文件分区并行 + 从 `CheckerPool` 借租约）；第 2 条是**架构级但可局部化**（先做高频节点分段 arena，风险最高）；第 3 条 .NET 已用 NativeAOT 补齐（1.09×）。

### 7.4 结论

- **“C# 全面超越 Go”不成立**，在单巨文件与单核吞吐维度上短期内没有现实路径。
- **“C# 在多数真实工程负载上追平 Go，并在宽而浅的负载上超越 Go”是有数据支撑的可达目标**：本次测量证明（a）启动只差 9%，（b）多文件负载的 C# 有用 CPU 只有 Go 的 0.57–0.69×，（c）差距集中在“发射串行”这一个明确的、Go 已经解决过的工程问题上。
- 两个前提：**发行形态必须是 NativeAOT（并按机器规模标定 GC）**；**必须完成发射并行化**。只做 Tier A 而不做 B1，C# 会停在“启动打平、编译仍落后 1.8–3.1×”。

---

## 8. 复现方法与附录

### 8.1 二进制与版本

| 名称 | 路径 | 大小 | SHA-256（前 16 位） |
| --- | --- | --- | --- |
| Go 1.27.1 `GOAMD64=v1` | `C:\ai\projects\tsbench\go-v1\tsc.exe` | 24.1 MB | `5E46CD5D15187A3C` |
| Go 1.27.1 `GOAMD64=v3` | `C:\ai\projects\tsbench\go-v3\tsc.exe` | 24.0 MB | `F2DBD3DBF8C2C2D1` |
| C# CoreCLR | `pkgs\coreclr\lib\` | apphost 0.1 MB + `TypeScript.Compiler.dll` 8.6 MB | apphost `32693664ED563FDD` |
| C# ReadyToRun | `pkgs\r2r\lib\` | `TypeScript.Compiler.dll` 26.8 MB | — |
| C# NativeAOT 便携（WKS / SVR） | `pkgs\naot-wks\lib\tsc.exe` / `pkgs\naot-svr\lib\tsc.exe` | 27.9 / 28.2 MB | `E6E1E0ABE3B81341` / `13E2FB1F876EC9C9` |
| C# NativeAOT host-native（WKS / SVR） | `pkgs\naot-wks-native\lib` / `pkgs\naot-svr-native\lib` | 28.0 / 28.2 MB | `F01134BAED74DC84` / `F574B205BFA9EA21` |
| C# NativeAOT + 解析并发补丁 | `pkgs\naot-svr-patched\lib\tsc.exe` | 28.2 MB | — |

源码版本：worktree HEAD `6ed638d3a5c8098dbdb8281a1cc58f4ddc67d515`（分支 `origin/typescript-cs`）。

### 8.2 关键命令

```powershell
# Go（对照），并把 108 个 lib.*.d.ts 复制到可执行文件同目录（-tags=noembed 会从磁盘读取）
cd C:\ai\projects\typescript-cs\tsc
$env:CGO_ENABLED='0'; $env:GOAMD64='v1'
go build -trimpath -ldflags="-s -w" -tags=noembed -o C:\ai\projects\tsbench\go-v1\tsc.exe ./cmd/tsc

# C# NativeAOT（推荐形态）
dotnet publish csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj -c Release -r win-x64 `
  -p:PublishAot=true -p:ServerGarbageCollection=true -p:TypeScriptExecutableName=tsc `
  -p:EmbedTypeScriptLibraries=false -o <out>

# 官方配对基准（本地副本，唯一行为改动是关闭输入门禁）
node C:\ai\projects\tsbench\tools\perf-cli.mjs `
  --manifest C:\ai\projects\tsbench\manifests\naot-svr.json `
  --go-executable C:\ai\projects\tsbench\go-v1\tsc.exe `
  --server-gc --samples 21 --directory C:\ai\projects\tsbench\bench\<name>

# 阶段归因
tsc.exe --project <fixture> --extendedDiagnostics --pretty false
```

### 8.3 相对上游的两处记录在案的改动

1. **基准驱动**：`C:\ai\projects\tsbench\tools\{perf-cli.mjs,perf-common.mjs}` 是 `csharp/tools/` 的副本，唯一行为改动是把 `GetLastInputInfo` 输入污染门禁从“拒绝配对”改为“记录在配对里”（本机每秒产生合成输入，否则 100% 配对被丢弃），并新增 `--csharp-env/--go-env/--before-env/--after-env/--no-gc-env` 以便不重新发布即可做单变量实验。其余（配对交替、产物逐字节比对、bootstrap、指标采集）逐字未改。
2. **被测源码补丁**（仅用于 6.6 实验，工作树 `git diff` 可见）：`csharp/src/TypeScript.Compiler/Programs/CompilerProgram.cs` —— `CreateAsync` 的 `concurrency` 默认值 `4` 改为 `0`（自动），Builder 把 `0` 解释为 `ProcessorCount`，并允许 `TSHARP_PARSE_CONCURRENCY` 覆盖。**该改动只用于测量，未被计入任何“当前性能”结论。**

### 8.4 原始数据位置

| 内容 | 路径 |
| --- | --- |
| 基准批次 R1–R6、AB1–AB9 | `C:\ai\projects\tsbench\bench\<run>\{summary.json,*.jsonl}` |
| 运行日志 | `C:\ai\projects\tsbench\logs\` |
| 阶段归因原始数据 | `C:\ai\projects\tsbench\phase-attribution\phases.json` |
| 真实项目负载 | `C:\ai\projects\tsbench\realworld\realworld.json` |
| C# 热点源码分析（29 项，带 file:line） | `C:\ai\projects\tsbench-notes\cs-hotpath-analysis.md` |
| 仓库既有性能证据编目（含 26 项已做实验） | `C:\ai\projects\tsbench-notes\cs-perf-history.md` |

### 8.5 局限

- 仅 Windows x64；无 Linux/macOS 数据（仓库既有证据同样未测跨平台）。
- 本机存在持续桌面负载与每秒合成输入，绝对时间不可与其他机器直接比较；同批次配对比值可信，跨批次绝对值需谨慎（实测复现漂移可达 30%）。
- 阶段归因使用两个编译器**各自报告**的口径（Go 为阶段耗时，C# 为跨任务求和），只能作方向性比较；`medium` 的 check/emit 比值受口径影响最大。
- 未做 CPU 采样剖析（`dotnet-trace`）与 Go pprof 对照；4.2 节“每核吞吐”结论来自 CPU 时间与阶段求和，而非热点函数级证明。
- 优化方案的百分比是工程推算：标注“实测”的来自本次或仓库既有直接测量，其余按热点频次与阶段占比推断。

---

## 附录 B：第二轮极限优化（分配归因驱动）—— 结果摘要

第二轮不再"按猜测优化"，而是先建立**确定性分配地图**（`--extendedDiagnostics` 新增按阶段分配字节数），再定点消除。完整推导见 `plan-extreme-optimization.md` 第 10 章。

### B.1 定位到的三个真实缺陷

| 缺陷 | 证据（huge-file） | 修复 |
| --- | --- | --- |
| `Code()` 每写一个标点/关键字都新建 `SourceText`（**复制整段文本**）+ `Scanner`（内含 2 个 `List<>`） | text 分支分配 **120 MB** | 复用一个 scratch `SourceText` + `Scanner`（新增 `Reset` API） |
| 每个被访问节点新建一个 `NodeState` 对象 | `BeginNode` 409,602 次、分配 **100.6 MB** | 池化复用（栈纪律 LIFO） |
| 无注释文件仍对每个节点扫描注释（每次 `new List<>` + LINQ `.ToArray()`） | other 分支 **89 MB** | 无 `//`/`/*` 时跳过源注释扫描（合成注释语义保留） |
| `Part` 工作项约 120 B，巨文件约 100 万个 | 元素存储 ≈ **120 MB** | 压到 64 B（flags 折叠 + 哨兵 + 稀有引用按需 payload） |

### B.2 确定性分配结果（同一夹具，字节数可复现）

| 夹具 | 第二轮前 | 第二轮后 | 变化 |
| --- | ---: | ---: | ---: |
| huge-file 总分配 | 960.1 MB | **615.7 MB** | **−35.9%** |
| huge-file 发射分配 | 711.7 MB | **367.2 MB** | **−48.4%** |
| huge-file print 分配 | 587.4 MB | **242.9 MB** | **−58.6%** |
| medium 总分配 | 167.7 MB | **113.1 MB** | **−32.6%** |
| huge-file Emit 阶段（AOT） | 1.064 s | **0.688 s** | **−35.3%** |
| huge-file 总时间（AOT） | 1.621 s | **1.254 s** | **−22.6%** |

### B.3 端到端比值（AB26：同批配对 15 组，噪声 5.4%）

| 负载 | 优化前 | 第二轮后 | 变化 |
| --- | ---: | ---: | ---: |
| **huge-file** | 3.74 | **3.24** | **−13.4%** |
| medium | 2.04 | **1.92** | −5.9% |
| declarations | 1.95 | **1.90** | −2.6% |
| medium checkers=1 | 2.93 | **2.66** | −9.2% |
| medium checkers=8 | 2.08 | **1.88** | −9.6% |
| 512 文件增量编辑 | 1.40 | 1.38 | −1.4% |
| 512 文件 | 1.29 | 1.28 | −0.8% |

**峰值内存**：23 项中 **12 项低于 Go**（优化前为 8 项）；巨文件差距由 1.19× 收窄到 **1.07×**。

### B.4 结论修正

- 第一轮结论"无法全面超越 Go"**不变**：23 项中最优仍是 1.19×（`--version`），启动地板由 NativeAOT 进程初始化决定。
- 但**巨文件的差距不再由打印器分配主导**：发射分配已砍掉近一半，剩余时间集中在工作项（约 100 万个 `Part`）的搬运与调度，以及检查阶段（0.339 s，3.5× Go）。
- **内存维度已过半领先**，且优势集中在真实工程负载（中等工程 0.80×、增量编辑 0.58×）。

### B.5 第二轮后段补充（final5，AB27）

按节点种类的分配归因（新增方法）显示打印器分配集中在**列表容器型节点**：ObjectLiteralExpression 40.4 MB、TypeLiteral 38.9 MB、VariableDeclarationList 35.2 MB（合计 47%）。对热点列表加**安全上界预分配容量**、并给 `Scoped` 加**免拷贝重载**后：

| 指标 | 数值 |
| --- | --- |
| 三个热点种类分配 | 40.4/38.9/35.2 MB → **26.9/25.1/26.7 MB（−33%/−35%/−24%）** |
| 打印分配 | 243 → **218 MB** |
| 巨文件总分配 | 616 → **590 MB（第二轮累计 −38.5%）** |
| 巨文件比值 | 3.24 → **3.20**（第二轮累计 3.74 → 3.20，−14.4%） |
| 中等工程比值 | 1.92 → **1.84**（第二轮累计 2.04 → 1.84，−9.8%） |
| 声明比值 | 1.90 → **1.84** |

另有一个**被实测否决**的改动已回退：移除检查器热路径 41 处冗余 `Array.AsReadOnly` 包装器（编译通过、语义等价），但检查分配 180.0 → 183.3 MB，在噪声内、无可测收益。
