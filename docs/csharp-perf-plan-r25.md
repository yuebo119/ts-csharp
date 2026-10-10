# r25 规划：全源码架构分析后的极致优化方案（2026-10-10）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-10 ｜ 轮次: r25 ｜ 主题: source-level-architecture-audit-and-optimal-plan
> 涉及 git 节点: `df639e9328`（r23 工作树基线，分支 `csharp-perf-extreme-optimization`）
> 数据来源: 本轮逐文件源码阅读（C# 侧 833 文件 / 212,527 行；Go 原实现 `tsc/internal/` 对照）+ r06~r24 全部实测报告
> 关联: `docs/csharp-perf-plan-r22.md`（P/S/R 四层）、`docs/csharp-perf-report-r23.md`（R 前提证伪）、`docs/csharp-perf-report-r24.md`（R 定价）、`docs/csharp-perf-report-r18-comparison.md`（三方表）
> 本文只做分析与规划，不含产品源码改动。每条结论标注 `[事实]`（本轮读到的源码或既有实测）或 `[推断]`（需测量）。

---

## 0. 结论摘要

本轮把 C# 侧从入口到产物的完整调用链读了一遍，并与 `tsc/internal/` 的 Go 原实现逐点对照。三条结论：

1. `[事实]` **并行架构已与 Go 等价，不是差距来源**。四阶段（解析+绑定 / 检查 / 变换 / 打印）的并行分解、checker 分片策略、emit 的按文件并发都与 Go 同构。差异只剩默认 checker 数（C# 8，Go 4）。此项排除。
2. `[事实]` **分配侧（r21 已判"收工"）仍有约 80 处"每次调用新建工作容器"的同族缺陷未扫描**，r23 明确指出该家族已复发两次（r13 的 `TypePredicates.Maybe`、r23 的 `TypeRecursion`）。按`长循环停止条件`规则，同族复发两次即应机械化，不再人肉逐轮找。
3. `[推断]` **本轮唯一的新发现是诊断基础设施自身在热路径上的固定开销**：`CompilationCapture.Current`（`AsyncLocal` 读）出现在每节点、每次建链、每次 emit 节点数据的路径上；r06 规划文档声称"未开诊断时无 AsyncLocal 读"，但那只对 `Mark()/Report()` 成立，计数器调用点直接读 `Current`，与该声明矛盾。

方案排序：先做一个能一锤定音的测量（GC 停顿占墙钟的比例，按 checker 数分列），再按结果在"机械化清理"与"S 层池化"之间二选一。R 层维持 r24 结论，不动工。

---

## 1. 架构层（源码实测）

### 1.1 四阶段流水线与并行模型

入口 `Execution/CompilerCommand.cs:51` → 配置解析 → `Programs/CompilerProgram.cs:180` 建程序图（解析 + 绑定）→ `Incremental/IncrementalProgram.cs` → 诊断 → 发射。各阶段并行方式：

| 阶段 | 驱动源码 | 并行方式 |
| --- | --- | --- |
| 解析 + 绑定 | `CompilerProgram.cs:526` `LoadPending` | 槽位 `parseSlots`，默认 4（`SingleThreaded` 时为 1），靠 `SemaphoreSlim` 限流 |
| 检查 | `Checking/CheckerPool.cs:61` `GetDiagnosticsAsync` | 文件按权重分片到 N 个 checker，`Task.Run` 每分片一线程，分片内串行 |
| 变换 + 打印 | `Programs/CompilerProgram.Emit.cs:125` `EmitAsync` | 单文件内 JS 打印与声明变换重叠（`ParallelTransformMinStatements = 512`） |
| 发射（跨文件） | `Incremental/IncrementalProgram.Emit.cs:89` | `Parallel.ForAsync`，工作者数 = `pool.Count`（≤8） |

`[事实]` 与 Go 对照：Go 的 checker 池默认 `checkerCount = 4`（`tsc/internal/compiler/checkerpool.go:305`），C# 默认 `Math.Clamp(ProcessorCount / 4, 4, 8)`（`CheckerPool.cs:12`）。Go 的 emit 用 `core.NewWorkGroup` 每文件一个 goroutine，但每文件 emit 全程持有所属 checker 的锁，实际并发仍被 checker 数限住。C# 的 `Parallel.ForAsync` 工作者数取 `pool.Count`，与之等效。此项不构成差距。

### 1.2 检查器是一个约百服务的组合对象

`Checking/Checker.cs:26` 的构造函数注入并新建约 100 个子服务（`Relations`、`Members`、`References`、`Inference`、`CallResolution` 等），每个 checker 实例一份。同一个 `program.Symbols.Program.SourceFiles.Select(f => f.Syntax)` 在构造里物化 4 次（行 31、50、113、146），另有 1 处惰性枚举（行 249）。`[事实]` 这是一次性开销（每 checker 一次），对单次编译可忽略，对 LSP 长驻会话值得一记。

### 1.3 异步形态已是最优

检查路径全 `ValueTask`，生产打开 `runtime-async`。r24 实测：异步状态机零分配、每帧 async 税约 2 ns、`await` 已完成的 `ValueTask` 为 1.30 ns（比同步等价 1.74 ns 更便宜）、栈守卫 0.22 ns。R 层（同步化重写）据此定价为墙钟上界 1~2%、分配收益 0，维持不动工。

### 1.4 仓库自带 Go 原实现，可做同源对照

`tsc/internal/compiler/` 是 Go 版本（18 文件 / 7,583 行核心，另有 `checker` 等包），与 C# 侧算法一致。后续任何"C# 比 Go 慢"的归因，都应先在这里找到对应的 Go 实现再下结论，避免把"实现差异"误判成"必然成本"。

---

## 2. 业务实现层（热路径源码）

### 2.1 关系引擎

`Checking/Relations.cs:31` 的 `RelationSession` 是关系比较的会话核心。`.NET` 侧每次递归做键构造、`maybe`/`maybeSet` 记账、`sourceStack`/`targetStack` 入栈。r14/r23 已量化：`RelationKeys.CreateAsync` 115,572 次、`GenericAsync` 探测 12,172 次、`RelationOperation` 分配 49,069 次、整条递归路径的纯调度自有分配 4.9 MB（占总分配 0.59%）。

`RelationKey`（`RelationKeys.cs:3`）是带缓存哈希的 readonly struct，`Equals` 同时比哈希与内容，没有可捡的便宜。r14 已证伪"`GenericAsync` 工作栈是热点"（0.98 MiB，0.2%）。这一层的分配是数据结构与合法工作本体，不是缺陷。

### 2.2 成员解析

`Checking/StructuredMembers.cs:53` 的 `ResolveAsync` 是最大独占分配帧（修复后约 77 MiB）。该文件已做过大量手工优化（容量提示、索引循环替代 LINQ、`TypeOrder` 以接口排序避免委托分配）。`[事实]` 仍有三处可省的小分配：

- 行 76 `[.. arguments, reference]` 每次实例化引用建一个新数组。
- 行 143 / 275 / 306 `members.Values.ToArray()` 仅为构造索引信息而物化整表。
- `SetCoreAsync`（行 354）为每张成员表新建 `declared`、`inherited` 两个 `List<Symbol>` 加一个结果数组，可先计数再直填结果数组，省两个 List 及其增长。

### 2.3 字符串键

`Text/Utf8String.cs:63` 的 `GetHashCode => Hash(Span)`，`Text/Utf8StringComparer.cs:17` 同。`Hash` 是 `XxHash3.HashToUInt64`，**每次查找都对整段字节重算，结构里没有缓存哈希字段**。成员表、符号表、模块表都是 `Dictionary<Utf8String, ...>`。`[推断]` 短键（标识符 8~15 字节）上 XxHash3 的固定开销占比高，缓存哈希可能有 1~3% 收益；但给 readonly struct 加哈希字段会在每次切片构造时付代价，需先测净值再决定。

### 2.4 诊断

`Diagnostics/Diagnostic.cs:113` 的 `Format` 用 `Utf8StringBuilder` 加手写占位符扫描，无正则；无 locale 时 `MatchLocale` 早退返回原文。单条诊断成本不高。`[事实]` 但 `host-paths` 负载对 Go 是 x1.87，且 r17 与 r18 两代表读数一致（x1.76 / x1.87），说明诊断密集场景有稳定差距，路径未被分析过。这是一个独立于检查本体的方向。

---

## 3. 流程层（端到端调用链）

```
Program.cs
  -> CompilerCommand.ExecuteAsync(arguments)                     执行/CompilerCommand.cs:51
     -> CommandLineParser.Parse                                   命令行
     -> ConfigParser.Parse / FindConfig                           tsconfig
     -> CompilerProgram.CreateAsync                               Programs/CompilerProgram.cs:180
        -> Builder.BuildGraph                                    含 lib、roots、依赖遍历
        -> LoadPending: ParseAndBind（解析+绑定，4 槽并行）        CompilerProgram.cs:526
     -> IncrementalProgram.CreateAsync
     -> IncrementalProgram.GetDiagnosticsAsync                   Incremental/IncrementalProgram.Diagnostics.cs:9
        -> CheckerPool.CreateAsync（4~8 checker）                 Checking/CheckerPool.cs:36
        -> CheckerPool.GetDiagnosticsAsync（分片并行检查）         CheckerPool.cs:61
           -> Checker.CheckSourceFileAsync（单文件串行）           Checking/Checker.Source.cs:40
              -> CheckSourceElementAsync（每 AST 节点递归）        Checker.Source.cs:97
     -> IncrementalProgram.EmitAsync                             Incremental/IncrementalProgram.Emit.cs:13
        -> Parallel.ForAsync 按文件发射                          同文件:89
           -> CompilerProgram.EmitCoreAsync                      Programs/CompilerProgram.Emit.cs:19
              -> FileEmitter.EmitAsync（JS 打印/声明变换重叠）     同文件:125
```

### 3.1 穿插全链的诊断基础设施

`Diagnostics/CompilationCapture.cs` 是可选的按编译统计层。设计上 `Mark()`（行 147）与 `Report()`（行 163）都有零成本门控：

```csharp
internal static ProbeMark Mark()
{
    if (!ProbesEnabled) return default;   // 静态读，未开诊断时不碰 AsyncLocal
    ...
}
```

`[事实]` 但这个门控只覆盖了探针帧。计数器调用点直接读 `Current`，而 `Current => ambient.Value` 是 `AsyncLocal` 读（行 16）。出现在热路径上的有：

| 位置 | 频度（按源码调用点性质） | 代码 |
| --- | --- | --- |
| `Checking/Links.cs:26` | 每次首次建链（`symbolTypesGet` 类路径，71 万次量级） | `CompilationCapture.Current?.NoteLinkCreate()` |
| `Checking/Checker.Source.cs:111` | **每个被检查的 AST 节点一次** | `var capture = CompilationCapture.Current;` |
| `Emission/EmitContext.cs:57,150,157,164,171` | 每次节点数据/注释读取 | `CompilationCapture.Current?.Note...()` |
| `Emission/SyntaxRewriter.cs:37` | 每次改写访问（先 `InTransformPhase` 又一次 `Current`） | `InTransformPhase ? CompilationCapture.Current : null` |

`[推断]` `AsyncLocal.Value` 读约 5~15 ns，`Checker.Source.cs:111` 每节点一次是大头。按真实工程 12.5 万标识符量级的节点数估算，这层固定开销落在 0.5~2% 墙钟区间。`docs/csharp-perf-plan-r06.md:286` 声称"未开诊断时只有一次静态 bool 判断，无 `AsyncLocal` 读"，与该实现矛盾，属于文档与代码不一致。

---

## 4. 现状坐标与已否定假设（防重探）

| 维度 | 现状 | 出处 |
| --- | --- | --- |
| 重负载耗时（11 项平均，对 Go 默认） | x1.46（最好 declarations x1.23，最差 checkers-1 x2.07） | r18 表 |
| 轻负载耗时 | x1.22~1.32（约 55 ms Main 前启动地板） | r18 表 |
| 真实工程累计分配 | 827.2 MB（Go 同负载约 155 MiB，倍数 5.2） | r23 |
| peak RSS 巨文件 | 375.6 MiB 对 Go 165.0（x2.28） | r18 表 |
| 阶段 CPU 占比 | 检查占 summed CPU 91% | r22 规划 |

已否定、不再投入的方向（本轮复核源码后确认仍然成立）：

| 方向 | 否定依据 |
| --- | --- |
| R 层检查器同步化 | r23 栈守卫 874,660 次零触发、r24 异步状态机零分配、每帧税 2 ns，墙钟上界 1~2% |
| AST 结构体 arena 重写 | 节点尺寸已与 Go 相当（`IdentifierNode` 约 80 B 对 Go 约 72 B） |
| 跨 checker 共享关系结果缓存 | Go 亦未做，依赖 checker 隔离假设 |
| AVX-512 / 裁剪开关 / 完整 LINQ | r20 三批实测零收益或更差 |
| 启动地板代码投入 | 93% 在 Main 前，属运行时初始化 |
| emit / 检查并行度不足 | 本轮源码对照 Go 后排除（§1.1） |

---

## 5. 剩余可量化杠杆

### 5.1 第一优先：一个能一锤定音的测量（GC 停顿占墙钟的比例）

`[推断]` 目前所有报告都只报了**分配字节**，没有报**GC 停顿占墙钟的比例**。这是整场战役最大的测量缺口，也是决定后续路线的唯一未知量：

- 若 GC 停顿占重负载墙钟 >10%，则分配侧不是"收工"，而是"小步微调无效、需要一次大力度的结构性削减"（S 层池化，甚至面向临时分配的 arena），因为 3.5% 的分配削减只带来 0.35% 的墙钟，本来就沉在噪声里。
- 若 GC 停顿 <5%，则分配侧确实收工，剩余墙钟差距只能来自每操作常数因子与内存局部性，可捡的便宜极少。

`[推断]` 还有一条机制被忽略：837 MB 的工作集相对 Go 的 155 MB 是 5 倍，这本身就是 cache/TLB 压力，会以"代码变慢"的形式出现，而不是以"GC 停顿"的形式。这解释了为什么大幅削减分配可能同时改善执行速度，而不只是 GC。这一条也需要在测量里区分。

**便宜的测法**：负载 `medium-checkers-1`（x2.07，单人检查、停顿无处隐藏）对 `medium-checkers-8`（x1.29，停顿被并行掩盖）的差异，本身就是"GC 停顿被并行掩盖"的间接证据。用一个进程 CPU 时间与墙钟的差来定位：CPU 时间接近墙钟说明线程在忙，墙钟显著大于 CPU（单线程形态）说明有 STW 停顿。harness 已经在采集进程 CPU（`csharp-perf-report-r18-comparison.md:146`），无需新插桩。若单 checker 的墙钟减 CPU 达到数十毫秒，GC 假设成立。

### 5.2 第二优先：机械化清理同族缺陷（低风险）

`[事实]` `Checking/` 下 `new Stack<` 有 80 处、`new List<` 213 处、`new Dictionary<` 57 处。r13 修了 `TypePredicates.Maybe`，r23 修了 `TypeRecursion.MatchesAsync`/`IsDeeplyNestedAsync`，两次都是同一家族（方法入口就建工作容器，而常见输入根本不需要）。r23 自己把 `Stack<Type>`/`Stack<SyntaxNode>` 字面构造列为"下一次扫描的词法线索"。

按`长循环停止条件`规则，同族复发两次即转机械门禁。做法：写一个脚本扫描 `new Stack<` / `new List<` / `new HashSet<` / `new Dictionary<` 位于方法体早段、且后续有早退分支的站点，输出候选清单；逐个确认"常见路径是否需要该容器"，需要才保留。这一步是防复发，不是本轮收益主力。

同批可做（都是机械等价改写，逐字节门禁覆盖）：

- `StructuredMembers.cs` 三处小分配（§2.2）。
- 诊断基础设施的 `AsyncLocal` 热路径读改为先判静态 `ProbesEnabled`（§3.1）。这是新增项，安全且可测。

### 5.3 第三优先：S 层池化（取决于 5.1 的结果）

`docs/csharp-perf-plan-r22.md` 第二层 S 未做：`RelationOperation` 池化（49,069 次分配、生命周期为单次顶层查询）、泛型关系键的 `List<Part>` 与 `Dictionary<Type,int>` 改 checker 级暂存池、`TypeMapper.MapAsync` 已有的暂存栈模式推广。预期分配 −60~120 MB。**只有在 5.1 证明 GC/局部性是双位数墙钟占比时才值得做**，否则是纯粹的峰值内存改善（有产品价值，但不是墙钟）。

### 5.4 被忽略的独立方向：诊断密集路径

`host-paths` 对 Go x1.87，两代读数稳定。候选：诊断位置/上下文计算、类型名格式化（`TypeDisplay`，TS 公认热点）、`reportHost` 的逐诊断开销。`[推断]` 需要先用探针把这一负载的耗时拆到诊断子帧，再决定。受影响的不只是 CLI，LSP 的诊断路径同样受益。

---

## 6. 最优方案（分阶段）

| 阶段 | 内容 | 预期 | 风险 | 门禁 |
| --- | --- | --- | --- | --- |
| **0. 测量** | 用现有 harness 单 checker 形态的"墙钟 − 进程 CPU"定位 GC STW 占比；必要时补一个 `GC.GetTotalPauseDuration()` 的 `--extendedDiagnostics` 行 | 决定路线，无收益本身 | 无 | 两个 checker 形态各 ≥15 配对 |
| **1. 机械清理** | 诊断基础设施 `AsyncLocal` 热读改静态门控；`StructuredMembers` 三处小分配；同族容器扫描脚本 + 候选确认 | 分配 −10~20 MB；墙钟 0.5~2% | 低（全为等价改写） | 逐字节 25/25 + safety 95 项基线比对 + AB 配对 |
| **2. 分叉决策** | 若阶段 0 显示 GC/局部性为双位数占比，进 S 层池化；否则跳到阶段 3 | S 层分配 −60~120 MB、墙钟 1~3% | 中（池化可变状态漏重置） | 池化后关系族 safety 全套 + 逐字节 |
| **3. 诊断路径** | 探针拆 `host-paths` 的耗时构成，按归因优化 | 待归因 | 低 | 该负载 AB 配对 + 诊断输出逐字节 |
| **4. 收尾** | 刷新三方对比表；把同族容器扫描并入 CI 门禁 | 防复发 | 无 | 门禁脚本带 mutation probe |

不做（维持既有结论）：R 层同步化、AST arena 重写、跨 checker 缓存共享、AVX/裁剪开关。

### 6.1 与 r22 四层的关系

r22 的 P 层（确定性修复）部分未完成，本方案阶段 1 收口其中残留项。r22 的 S 层原样保留为阶段 2。r22 的 R 层由 r23/r24 关闭。r22 的 N 层（明确不做）不变。本方案新增的是阶段 0 的关键测量与阶段 3 的诊断方向。

---

## 7. 决策点与验收

1. **阶段 0 做完即出裁决**：GC 停顿占重负载墙钟的百分比是这次规划唯一能改变路线的事实。高于 10% 走阶段 2，低于 5% 直接跳阶段 3 并宣布分配侧与检查本体收工。
2. **阶段 1 完成后**：若墙钟改善落在噪声内（likely，因为量级小），按分配轮惯例只记分配改善，不宣称墙钟。
3. **验收动作**：每个阶段按战役惯例出独立 report，附确定性分配（真实工程 + 巨文件两侧）、逐字节门禁、safety 套件、AB 配对四项。

### 7.1 本轮未做与未验证

- 未测量：GC 停顿占比、`AsyncLocal` 读的确切频度与成本、`Utf8String` 缓存哈希的净值、诊断路径的耗时构成。全部标 `[推断]`。
- 未改动任何产品源码，本文是规划文档。
- `Utf8String` 缓存哈希（§2.3）暂列观察，不进入阶段 1，理由是它可能净负（构造期付哈希、切片多、命中共用少），需先做一个 10 分钟探针测命中率再定。

---

## 8. 参考

- 架构与并行：`Programs/CompilerProgram.cs`、`Checking/CheckerPool.cs`、`Incremental/IncrementalProgram.Emit.cs`
- 热路径：`Checking/Checker.Source.cs`、`Checking/StructuredMembers.cs`、`Checking/Relations.cs`、`Checking/RelationKeys.cs`
- 基础设施：`Diagnostics/CompilationCapture.cs`、`Diagnostics/Diagnostic.cs`、`Text/Utf8String.cs`
- Go 对照：`tsc/internal/compiler/checkerpool.go`、`tsc/internal/compiler/program.go`、`tsc/internal/core/workgroup.go`
- 历史实测：`docs/csharp-perf-plan-r22.md`、`docs/csharp-perf-report-r23.md`、`docs/csharp-perf-report-r24.md`、`docs/csharp-perf-report-r21.md`、`docs/csharp-perf-report-r18-comparison.md`
