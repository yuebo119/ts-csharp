# r28 规划：执行流程逐项审计——移植偏离清单与健康流程的否定确认（2026-10-11）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-11 ｜ 轮次: r28 ｜ 主题: execution-flow-audit-port-deviations
> 涉及 git 节点: `27acbf7b4b`（r27，工作树基线，本轮无产品源码改动）
> 数据来源: Serena 符号级流程追踪（入口→产物逐阶段）；Go 原实现 `tsc/internal/` 对照；r27d 产品的阶段耗时与计数器实测（真实工程 noEmit + medium emit/noEmit 四组）
> 关联: `docs/csharp-perf-plan-r25.md`（架构审计）、`docs/csharp-perf-report-r26.md`（停顿首测）、`docs/csharp-perf-report-r27.md`（S 层关闭）

---

## 0. 结论摘要

把执行流程从入口到产物逐段读了三遍（C# 现状、数据流向、Go 参考实现对照），结论分两半：

1. `[事实]` **大额流程冗余不存在**。图构建（解析器/库路径/包缓存全部有缓存、DFS 单遍）、解析+绑定槽位、检查分片（权重为缓存计数非重走）、emit 并发与资格门控（r05~r07 已做）、诊断后处理（干净工程上近零成本）各阶段内部没有可摘的大块重复工作。剩余墙钟差距（对 Go x1.43）不在流程冗余，而在每操作常数与内存压力（r21~r27 已定界）。
2. `[事实]` **发现 5 处对 Go 参考实现的移植偏离**，全部集中在"每文件收尾流程"与"emit 的 checker 生命周期"，属于把 Go 的按文件分桶/池复用设计移植成了全局列表/新建池。单项都不大（合计 <1% 墙钟 [推断]），但修复便宜、语义向参考实现对齐、且消除每文件的闭包与 LINQ 分配。

阶段耗时锚点（r27d，真实工程 291 文件 noEmit）：Config 0.018s、Program 0.241s（含 Parse 0.094 + Bind 0.052，图构建净额约 0.095s）、Check 1.943s（8 checker 求和）、Total 1.063s、GC 停顿 0.209s。检查阶段占绝对主导，流程审计的主战场因此是检查的每文件/每节点固定流程。

---

## 1. 逐流程审计

### 1.1 入口与配置（健康）

`CompilerCommand.ExecuteAsync` → 命令行解析 → tsconfig 发现/解析 → 建程序图 → 诊断 → emit。Config 0.018s，无重复解析，无多余文件系统遍历。**无优化项。**

### 1.2 图构建 BuildGraph（健康，两处嫌疑排除）

| 嫌疑 | 排查结果 |
| --- | --- |
| `LibraryPath(lib)` 双调用（`CompilerProgram.cs:354/385`） | 默认路径是 O(1) 拼接；LibReplacement 路径有 `resolvedLibraries` 缓存（`Resolution.cs:113`）。首循环是预热缓存（供模块解析期 690 行的调用命中），**连贯设计非冗余** |
| `Resolver(config)` 连续两次调用（362/364 行） | `resolvers` 字典缓存 + 锁（300-318 行），第二次是字典命中。**非冗余** |
| `order` / `explanationOrder` 双列表 | 有实际差异：包重定向文件只进后者（480 行 `continue` 跳过 Exit 入栈）。**非冗余** |

DFS 排序单遍、模块解析按 import 一次、类型指令自动引入一次。**无优化项。**

### 1.3 解析 + 绑定（健康）

`LoadPending` 4 槽流水（`CompilerProgram.cs:526`），解析与绑定重叠。Parse 0.094s + Bind 0.052s 求和（291 文件）。**无优化项**（深度优化属扫描器/绑定器内部，r20 已审）。

### 1.4 检查分片（健康）与每文件收尾（4 处偏离，见 §2）

`CheckerPool.CreateAsync` 分片用 `file.Syntax.NodeCount`（缓存计数，非 AST 重走）+ 字节数权重；组内串行、组间并行。每文件 `CheckSourceFileAsync` 的主干（`queryGate`、`checkedFiles` 去重、deferred 节点二轮、外部导出）与 Go 同构。每节点 `CheckSourceElementAsync` 的固定流程（栈守卫、`CurrentSourceNode`、`ResetExpressionCount`、unreachable 检查）经读码均为廉价旗标/集合操作。

### 1.5 诊断后处理（干净工程上近零）

`GroupDiagnosticsByFile` + `DetailedDiagnosticsForProgramFile` 每文件一次 Distinct/排序物化，仅在诊断非空时付出；真实工程 0 诊断时为空列表开销。**无优化项**（诊断密集场景另立项，见 r25 阶段 3 的 host-paths 方向）。

### 1.6 emit 流程（1 处偏离，见 §2 F1；其余健康）

`EmitCoreAsync` 的资格门控（PendingEmit 位、`SourceFileMayBeEmitted`、noEmitOnError 前置诊断）语义必要；并发路径 r05 已建（按文件借 checker 锁）；变换跳过/分段打印/链接标记跳过 r06 已做。

### 1.7 增量与 watch（本轮不展开）

BuildInfo 读 0.000s、Changes 0.006s（真实工程无 buildinfo 形态）；增量语义的正确性依赖快照机制，性能非当前瓶颈。

---

## 2. 发现的移植偏离（按代价排序）

### F1：emit 阶段无条件重建 checker 池，丢弃诊断期的全部每-checker 状态 ★主项

- **现状**：诊断阶段把池缓存在 `IncrementalProgram.checkerPool`（`Diagnostics.cs:34` 的 `??=`）；emit 的并发路径却 `pool = await Program.CreateCheckerPoolAsync(false, …)`（`Emit.cs:84`）无条件新建，串行路径同样新建单 checker（`Emit.cs:110`）。
- **Go 参考**：emit 每文件 `program.GetTypeCheckerForFile(ctx, file)`（`emitHost.go:39`、`program.go:1858`）——借用**诊断期同一个池里检查过该文件的那个 checker**，链接库与类型缓存全热。
- **代价实测（r27d，medium 夹具 67 文件，emit vs noEmit 两组）**：emit 形态多分配 **+31.0 MB**、墙钟 +12~28 ms；其中"重建份额"的直接证据是 emit 期在全新 checker 上**多创建了 497 个类型（+8.6%）**（Types 计数 6,287 对 5,790），链接库同理从零重建（medium 全进程 27,123 次建链，含 emit 期重做份额；noEmit 侧计数行被 `NodeDataCalls != 0` 门控无法直读，修复后 A/B 可得精确差值）。真实工程（46 万建链）emit 形态下重建份额按比例放大 [推断]。
- **修法**：`EmitCoreAsync` 两分支改用 `checkerPool ??= await Program.CreateCheckerPoolAsync(…)`（单线程配置下池为 1 checker，emit 并行度自然降为 1，语义不破）。风险：池跨阶段复用的状态残留（gates 保证每 checker 独占；分片表不变）；门禁用 emit 负载逐字节 + 全套 safety + AB 配对（含 `--declaration` 夹具）。
- **预期**：emit 负载分配 −5~15%（按 medium +31MB 的重建份额估计）、墙钟小个位数百分比 [推断]；更重要的是消除一个 O(全程序) 的重复类型解析流程。

### F2：`UnusedIdentifierScopes` 全局列表 × 每文件全量过滤扫描

- **现状**：登记进 checker 级全局 `HashSet<SyntaxNode>`（块/循环/类/函数/文件，真实工程千级 [推断]），`CheckUnusedSource`（`Checker.Unused.cs:34-38`）**每个文件**全量扫描并按 `Binding(node)?.SourceFile != file` 过滤——O(文件数 × 作用域数) 的字典查找。
- **Go 参考**：未用作用域存在**每文件**的 `links.identifierCheckNodes`（`checker.go:2271`），文件结束直接检查本文件桶，**无全局扫描**。
- **修法**：登记时已知所属文件（登记点都在该文件的检查流程内），改为 `Dictionary<SourceFileNode, HashSet<SyntaxNode>>` 分桶；`CheckUnusedSource` 只遍历本文件桶。预期 <0.5% 墙钟 [推断]，收益主要是结构对齐与每文件扫描的常数。

### F3：`RenamedBindingElements` 全局列表 × 每文件过滤

- **现状**：`Checker.Unused.cs:15-16` 每文件全表扫 `RenamedBindingElements`（列表本身小）。
- **Go 参考**：`renamedBindingElementsInTypes` **每文件开头置 nil、结尾检查**（`checker.go:2244/2255`）——文件局部列表。
- **修法**：同 F2 分桶（或按 Go 置空语义）。预期微小，随 F2 一起做。

### F4：`DeferredIterationDiagnostics` 每文件 Where+ToArray+RemoveAll（含闭包分配）

- **现状**：`Checker.Source.cs:56` 每文件 `Where(d => Source(d.Node) == file).ToArray()`（枚举器+数组分配，即使列表为空）；`:77` `RemoveAll(…)` 每文件分配一个捕获 `file` 的闭包。
- **Go 参考**：deferred 诊断是**每文件回调表**，文件结束执行后置 nil（`checker.go:2257/14206-14210`）。
- **修法**：改为每文件桶（登记时入桶）。预期微小（每文件约百字节级分配 × 文件数），随 F2/F3 一起做。

### F5：`DeferredMissingProperties` 每文件 RemoveAll

- **现状**：`Checker.MissingProperties.cs:193` 每文件全列表 `RemoveAll` 过滤，与 F4 同族。
- **修法**：同上分桶。预期微小。

---

## 3. 逐项否定确认（防止重探）

| 流程/假设 | 否定依据 |
| --- | --- |
| 图构建有重复文件系统遍历/重复解析 | 解析器字典缓存、库路径缓存、DFS 单遍（本轮读码） |
| 检查分片权重需要重走 AST | `NodeCount` 为缓存计数（`CheckerPartitions.cs:29`） |
| 每节点 unreachable 检查是重流程 | 旗标 + 小集合 Contains，`UnreachableAsync` 仅在终止语句上展开（`Statements.cs:16-46`） |
| 诊断后处理在干净工程上昂贵 | 空诊断路径近零成本（本轮读码 + 0 诊断实测） |
| emit 并行度/资格门控不足 | r05/r06 已做，剩余差距在常数（r18 表） |
| `explanationOrder` 双列表冗余 | 与 `order` 有实际差异（包重定向只进前者） |

## 4. 实施队列（建议 r28 执行序）

| 序 | 项 | 改动量 | 门禁 |
| --- | --- | --- | --- |
| 1 | F1 emit 池复用 | ~4 行 + 注释 | emit 负载逐字节（含 declaration 夹具）+ safety 95 + AB 配对（medium/declarations/huge-file/tiny-files）+ 分配配对（Types/Links 计数差值作直接证据） |
| 2 | F2+F3+F4+F5 每文件分桶 | ~40 行 | 逐字节 25/25 + safety + 分配配对；墙钟预期噪声内，只记分配 |

全部完成后刷新三方对比表。预期合计：emit 负载 −5~15% 分配、全部负载 <1% 墙钟 [推断]。

## 5. 本轮未做与未验证

- 未改任何产品源码；F1 的重建份额精确值需修复后 A/B（本轮 medium 实测给出的是上界证据：+31MB/+497 类型）。
- `UnusedIdentifierScopes` 的确切规模未插桩（按登记点性质估计千级）。
- watch/LSP 会话内的流程（长驻形态）未审计，F1 对其收益更大（每次 watch 触发都重建池）[推断]。
