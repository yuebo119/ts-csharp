# r32 计划：全链路重审后的极致优化方案（2026-10-12）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-12 ｜ 轮次: r32 ｜ 主题: fresh-audit-extreme-optimization
> 触发: 用户指令「不考虑以前的决策和分析，不考虑缓存，完全重新读取所有代码文件，整体综合分析」——全源码重审轮，无产品改动
> 方法: 主 agent 通读编排层/检查器核心/基础类型（ firsthand ），三个只读代理分审 parser/emitter/infra（82+58+80 次工具调用），关键论断逐条抽验；本场实测分阶段拆分；ledger 仅用于定稿前去重标注
> 关联: `docs/csharp-perf-method.md`（测量协议权威）、`perf-budgets.md`（门禁）、`.ai/perf-ledger.md`（去重对照）

## 1. 假设与依据

### 1.1 本场实测（新鲜数据，非沿用）

JIT 形态（`csharp/src/TypeScript.CommandLine/bin/Release/net11.0`，与 HEAD 源码一致），按 method.md §6 配置（`DOTNET_gcServer=0`、gen0 4 MiB、LOH 1 MiB）：

| 夹具 | Parse | Bind | Check | Emit(transform/print) | 墙钟 | GC 停顿 |
| --- | --- | --- | --- | --- | --- | --- |
| medium（67 文件/8140 行） | 0.229 s | 0.151 s | 1.816 s | 1.137 s（0.70/0.38 量级） | ~1.36 s（--noEmit） | — |
| huge-file（1 文件/16384 行 + lib） | 0.344 s | 0.262 s | 1.139 s | 0.707 s（0.702/0.380） | 2.781 s | 0.357 s（12.8%） |

分配（summed，确定性）：

| 夹具 | parse | bind | check | emit | 合计 |
| --- | --- | --- | --- | --- | --- |
| medium | 27.0 MB | 18.6 MB | 179.3 MB | 262.2 MB（transform 87.6 + print 164.0） | ~487 MB |
| huge-file | 42.2 MB | 20.9 MB | 116.9 MB | 193.0 MB（transform 165.6 + print 119.9） | ~373 MB |

medium 探针分解（check 179.3 MB 内）：object-literal 族（objectMutable 14.2 + objectLiteral 13.0 + objectProperty 10.3 + objectPropertyInit 9.0 + objectCheckExpr 8.2 + mutableContextual 4.2 + mutableWiden 1.9 ≈ 61 MB，34%）为最大家族；关系族（relationRelated 2.2 + relationCompare 1.8 + checkerRelated 1.8 + relRecurse 1.1 + relationExcess 0.6 ≈ 7.5 MB，4%）。语句级归属：VariableDeclaration 子树占 check 分配 72%（medium）/83%（huge-file）——即变量声明及其初始化表达式是 check 分配主体。[事实]

**结论 1（量级判断）**：墙钟时间 check ~55% / emit ~34% / parse+bind ~12%；分配 emit ~52% / check ~36% / parse+bind ~9%。与 Go 的 1.43× 墙钟差与 5.2× 分配差只能来自 check+emit 的每操作常数（占 89% 时间、88% 分配）。本方案主攻面由此定为 emit 与 check，parse/bind 只做并发度与条件性大项。[事实+推断]

### 1.2 结构性事实（源码通读 + 抽验）

**检查器（ firsthand 读码）**
- 逐节点 async 链：`CheckSourceElementAsync`（Checker.Source.cs:104-109）每条源元素一次 `await Task.CompletedTask.ConfigureAwait(栈守卫 ? None : ForceYielding)` + `cancellation.ThrowIfCancellationRequested()` + `Instantiation.Engine.ResetExpressionCount()` + try/finally。Checking 目录 1348 个 async ValueTask 方法、6688 处 await。同步完成时 async ValueTask **不产生堆分配**（struct state machine），成本是每帧 builder/awaiter 的 CPU 往返；仅栈将尽才 ForceYielding（装箱+线程池跳转）。[事实]
- `TypeCacheKey`（TypeContext.cs:426-506）每次联合/引用缓存探测都 `new long[...]`——**命中也分配**（TypeContext.cs:246/289/334）。[事实]
- `RelationOperation` 每次关系查询 `new`（TypeRelations.cs:159），session 已池化而 operation 没有。[事实]
- `NewSignature`（TypeContext.cs:381-390）每次 `typeParameters.ToArray()` + `parameters.ToArray()` + 两次 `Array.AsReadOnly`。[事实]
- `TypeViews.ApparentAsync`（TypeViews.cs:61-63）对 string/number 等 apparent 解析每次 `Utf8String.Copy("String"u8)` 等——**每次分配一个 byte[]**（Utf8Literals 有 "string" 无 "String" 缓存）。[事实]
- `LinkStore`（Links.cs:10-31）每 checker 15 张引用字典，每次建链 = 1 link 对象 + 1 字典条目 + 1 次 `ProbesEnabled` volatile 读。[事实]
- parse/bind 并发：`CreateAsync(concurrency = 4)`（CompilerProgram.cs:181），CLI 不传参（CompilerCommand.cs:129）；`parseSlots` 横跨 parse+bind 两阶段持槽（CompilerProgram.cs:785-801）。[事实]
- 文件系统边界：`File.Exists(path.ToString())`（FileSystem.cs:49-57）→ `Wtf8.DecodeString` = `Utf8.IsValid` 全扫 + `Encoding.UTF8.GetString` 再扫并分配 UTF-16 string。模块解析每次 import 多次探测。[事实]
- 诊断分组：`GroupDiagnosticsByFile`/`DetailedDiagnosticsForFile`（Checker.DiagnosticCodes.cs:17-29）每次全量 LINQ 重放；CheckerPool.cs:72-85 对分区内每文件调一次 → O(文件×诊断)；`IncludeDiagnostics.Contains` 线性扫描。[事实]
- `CheckerDiagnostic`（CheckerDiagnostic.cs:22-27）调用方已持数组仍 `[.. arguments]` 整数组再拷。[事实]

**解析器（代理审计 + 抽验属实）**
- 顶层 await：`possibleAwaitSpans.Count != 0 && ExternalModuleIndicator != null` 时**整文件二次解析**（Parser.cs:118-125，抽验属实）；Go 只重解析 span 区间、区间外语句复用（tsc/internal/parser/parser.go:452-456,517-610）。[事实]
- 每节点 async + 栈探针（Parser.Stack.cs:22-23，68 处 `await ParseStack`）；`Next()` 每 token 一次取消检查（Parser.cs:258，抽验属实）。[事实]
- Scanner 主循环先试 `ScanIdentifier` 再试标点（Scanner.cs:247/269）；JSDoc tag 检测对同一注释最多 5 次全量 `IndexOf('@')`（Scanner.cs:191-199）；空白逐字符 `CodePoint`（Scanner.cs:140-148）。[事实]
- `Peek(() => ...)` 闭包分配（Parser.cs:378-380 + 17 调用点，抽验 Parser.Expressions.cs:192 属实）；`NodeList` 每次 `ToArray()` + wrapper 双分配（Parser.Stack.cs:77）。[事实]

**发射器（代理审计 + 抽验属实）**
- `EmitTextWriter.RawWrite`（EmitTextWriter.cs:75-87）对**每个写入 value 的每个码点**调 `Wtf8.Decode`（→ `Rune.DecodeFromUtf8`）只为换行跟踪；Go 对 ASCII 是内联字节 switch（core.go:433-466）。`Line`/`Column` 仅 source map 读取（SyntaxPrinter.cs:415/426），`atLineStart` 全工况需要。[事实]
- `fastCode = map is null && !sourceHasComments`（SyntaxPrinter.cs:199）：注释文件 + 无 map 时每个 recipe token 走源码重扫对齐（SyntaxPrinter.cs:454-464，抽验属实）；braceMap 位置数学与 `MapPosition` 在无 map 时仍执行（:490-494，MapPosition 本体 :407 no-op）。[事实]
- `EnvironmentScope` 每作用域 3 个空 List（EmitContext.Environments.cs:9-13）；注释路径每节点 `Where().ToArray()`（SyntaxPrinter.Comments.cs:40-81）；`BlockBody` 每函数体 `.Any(谓词)` 闭包（SyntaxPrinter.cs:773/780）。[事实]
- 写盘两次全量拷贝：`writer.Text` → Utf8String.Copy（EmitMaps.cs:58-60）→ `File.WriteAllBytes`（FileSystem.cs:70）。[事实]
- 已优化确认（勿动）：transform 惰性重建、Part 打包、NodeState 池、常量 token 缓存、单 Utf8StringBuilder 全量缓冲。[事实]

## 2. 方法

1. **排序原则**：影响面（时间/分配占比 × 覆盖面）× 置信度 × 低风险；每项带 file:line 证据与验证方式。
2. **门禁**（每项落地前）：`csharp/` 下 `dotnet build TypeScript.slnx -c Release` 0 警告 0 错误；产品改动逐字节 25/25 + safety 90/95（失败集合=已知基线）。
3. **测量**：分配收益用 `--extendedDiagnostics` 分阶段求和（★★★ 确定性，交错 ≥3 组带宽 <0.5 MB）；墙钟用 `tools/perf-cli.mjs` AB 交替批次（噪声下限 1.1%，本机分辨率 ~±1.5%）；关系链触碰项先过隔离巨文件批次（r27 教训）。跨批次禁比绝对耗时。
4. **S2 单变量**：每项独立提交、独立批次；禁止多项混改后一次测量。
5. **红队**：每项实施前写「什么证据会证伪它」；负结果同样入报告。

## 3. 方案（分级）

### P0 — 零风险逐字节/每 token 项（先行，预计 1-2 轮落地）

| # | 项 | 证据 | 机制与预期 | 风险 |
| --- | --- | --- | --- | --- |
| E1 | **RawWrite 换行跟踪 O(1) 化**：无 source map 时 `atLineStart` 改为末字节判定（`\n`/`\r`，或末 3 字节 `E2 80 A8/A9` 判 U+2028/2029），整条逐码点循环消失；有 map 时保留循环但加 ASCII 快路径（与 Go `ComputeECMALineStartsSeq` 同构） | EmitTextWriter.cs:68-89；Line/Column 仅 map 读（SyntaxPrinter.cs:415/426）；atLineStart 公式 = 末码点为行终止符 [事实] | emit print 每个写入 value 每码点一次 `Wtf8.Decode`（含 `Rune.DecodeFromUtf8` 非内联调用）。print 占 huge-file 墙钟 13.7%（0.380/2.781）[事实]；逐码点循环是其中与输出字节数成正比的成分 [推断：占 print 10-30%] | 极低。atLineStart 语义逐分支等价（含 \r\n、 lone \r、U+2028/29）；bytecheck 25/25 锁定 |
| E2 | **braceMap/MapPosition 位置数学 gate 在 `sourceMap is not null`**：无 map 时 `Code()` 内 braceMap 布尔链、`SkipTrivia(position)`、`MapPosition` 全部跳过（MapPosition 本体已 no-op，位置数学纯浪费） | SyntaxPrinter.cs:490-494 与 :407 | 注释文件（默认主力）每 emit 一次的隐性成本；SkipTrivia 是真实扫描（ResetPosition+Scan） | 低。需确认 braceMap 分支无注释副作用（LeadingComments 在 :465 独立于 braceMap） |
| E3 | **Utf16Length ASCII 快路径**：先扫非 ASCII 字节，纯 ASCII 直接 `return value.Length` | EmitTextWriter.cs:98-115；Go core.go:484-498 同构 | 仅 source map 开启时每 mapping 一次；默认负载零收益，列为 map 形态卫生 | 极低 |
| E4 | **注释路径 LINQ → 手写循环**：LeadingComments/TrailingComments/DetachedComments 的 `Where().ToArray()` 合并为一次遍历；`BlockBody` 的 `.Any(谓词)` 改 for | SyntaxPrinter.Comments.cs:40/51/69/81；SyntaxPrinter.cs:773/780 | 每带注释节点/每函数体一次迭代器+闭包+数组；分配确定性下降 | 极低 |

### P1 — 确定性分配削减（check+emit 占分配 88%，主战场）

| # | 项 | 证据 | 机制与预期 | 风险 |
| --- | --- | --- | --- | --- |
| C1 | **TypeCacheKey 内联小键**：≤4 类型走 struct 内联存储（long×4 + count），>4 回落 long[]；消除每次联合/引用缓存探测的 `new long[]`（**命中也分配**） | TypeContext.cs:246/289/334/431-437 | 联合缓存是 checker 最热缓存之一；每次探测一桶垃圾 [事实]。真实工程联合探测次数需实施时用计数器定标 [推断：数 MB 级] | 中。键语义必须逐字节保持（Equals 全序列比较）；先加计数器探针测定频次再动工 |
| C2 | **Apparent 常量驻留**：TypeViews.cs:61-63 等 5 处 `Utf8String.Copy("String"u8)` 家族改 Utf8Literals 缓存静态量（补 "String"/"Number"/"BigInt"/"Boolean"/"Symbol" 五项） | TypeViews.cs:61-63；Checker.RelationMessages.cs:443-444；Checker.Iteration.cs:45；Checker.CallDiagnostics.cs:23 | 每次 primitive apparent 解析一次 byte[] 分配；属性访问是 checker 最高频操作 [事实] | 极低。逐字节门禁锁定 |
| C3 | **NewSignature 免二次拷贝**：span 入参直存（内部数组一次分配），消 `ToArray()`+`Array.AsReadOnly` 双包装 | TypeContext.cs:381-390 | 每次建签名 2 数组 + 2 包装；签名随声明与实例化大量创建 [事实] | 低。Signature 是公开面，需保持 IReadOnlyList 语义 |
| C4 | **RelationOperation 池化——暂缓，勿动** | TypeRelations.cs:159 | **r27 已实测否决**：生命周期/重置/尺寸全匹配的池在巨文件三批次稳定 +2.27~3.04% 墙钟，机制指向 AOT 对关系调用链的内联/布局扰动。ledger 表3。翻案前置 = 先解决布局归因（EventPipe 本机 .NET 11 RC 不可用）。本方案明确不重开 | — |
| M1 | **NodeList 单分配**：`RentNodeList` 直租 `SyntaxNode[]` 原地增长，NodeList 只存 (array, count, pos, end)，消 `ToArray()`+wrapper 双分配 | Parser.Stack.cs:77/133；SyntaxNode.cs:140-164（AsSpan/枚举已按数组形态） | 每节点列表少 1 次对象分配；文件级数千列表 [事实] | 低。NodeList 语义不变 |
| M2 | **EnvironmentScope 池化**：复用后清空三 List，或改 null 懒初始化（readonly 字段需先改属性） | EmitContext.Environments.cs:9-13 | transform 期随函数体/块数量线性分配 [事实] | 低 |
| M3 | **Peek 闭包零分配化**：17 处 `Peek(() => ...)` 改元组+静态 lambda（仓库已有先例 Parser.cs:564、Parser.Stack.cs:101、NextIs） | Parser.Expressions.cs:192/239/242/266/362/374/398/485/486/683/730；Parser.Statements.cs:149/162/252/261/281/291 | 每次 lookahead 一次 48-64B 分配；每文件数千次 [事实] | 极低 |
| M4 | **CheckerDiagnostic 零拷贝重载**：调用方已持数组时免 `[.. arguments]` | CheckerDiagnostic.cs:22-27 | 每条诊断一次整数组拷贝；诊断多时显著 [事实] | 极低 |

### P2 — 调度、I/O 边界与诊断分组

| # | 项 | 证据 | 机制与预期 | 风险 |
| --- | --- | --- | --- | --- |
| S1 | **parse/bind 并发解封 A/B**：parseSlots 4 → 拆 parse/bind 两池或提帽至 ProcessorCount；CLI 暴露/环境变量控参 | CompilerProgram.cs:181/276-277/785-801 | parse+bind 占 summed 12% [事实]；16 核机器 4 槽可能欠利用（Go 每任务一 goroutine 无帽）[推断]。先用现有 `--checkers` 同族环境变量做 4/8/16 三臂 AB，阳性再改默认 | 低。纯调度参数，产物不变 |
| S2 | **FileSystem ASCII 快路径**：`Utf8.Ascii.IsValid` 命中走单遍解码（消 `Utf8.IsValid`+`GetString` 双扫）；RealPath/Stat 的 `ToString` 同处理 | FileSystem.cs:49-57/115-136；Wtf8.cs:102-106 | 模块解析每 import 多次存在性探测，每次双扫+UTF-16 分配 [事实] | 低。注意 .NET span 版 File API 可用性需先查证（P0 #4），不可用则保留 string 分配只消双扫 |
| S3 | **写盘单拷贝**：Utf8StringBuilder → 写盘路径消中间 `Utf8String.Copy` | EmitMaps.cs:58-60；Utf8StringBuilder.cs:86；FileSystem.cs:70 | 每文件 2× 输出大小拷贝 [事实] | 低 |
| S4 | **诊断分组一次成型**：CheckerPool 并行分组直接回传 `Dictionary<SourceFileNode, Diagnostic[]>`，删 IncrementalProgram 侧 ToLookup 与每文件串行租借；IncludeDiagnostics 预建 HashSet | CheckerPool.cs:72-92；Checker.DiagnosticCodes.cs:17-29；IncrementalProgram.Diagnostics.cs:44-65 | clean build 成本≈0（基准夹具全 clean）；诊断上千的项目 O(文件×诊断) [事实] | 低 |

### P3 — 条件性大项（依赖语料，实施前先定标）

| # | 项 | 证据 | 机制与预期 | 风险 |
| --- | --- | --- | --- | --- |
| P3-1 | **顶层 await span 级重解析**（Go 1:1 移植）：第二遍以 `topLevelAwaitSpans` 为界，区间外语句从第一遍 statements 数组索引复用，仅区间内调 `ParseStatementCore` | Parser.cs:118-125；Go parser.go:452-456/517-610 | 含 TLA 的模块当前 2× 解析 + 2× AST 分配 [事实]。对无 TLA 文件零影响；真实工程（packages/typescript 291 文件）TLA 占比需先 grep 定标 [推断：占比低则优先级下降] | 中。reparse 路径已有 `reparsedStatements` 机制（Parser.cs:181-211），缺区间外复用 |
| P3-2 | **JSDoc tag 单遍检测**：一次 `IndexOf('@')` 循环内同时判 deprecated 与 see/link 族，双 flag 齐备早退 | Scanner.cs:191-199；Go scanner.go:358-390 | 每个 `/**` 注释最多 5 次全量扫描 [事实]；.d.ts/库文件收益大，普通源码小 | 极低 |
| P3-3 | **Scanner 主循环首字节分发**（标点优先）+ **空白段向量化跳过** + **每 token 取消检查降频** | Scanner.cs:247/269、140-148；Parser.cs:258 | 与 Go 同构；**注意 ledger 表2「扫描器内部深挖」已定界**：解析 summed 占墙钟 8.3%，即使扫描器内部 10% 优化 <0.9% 墙钟 < 噪声下限 1.1%。本场实测独立复算一致（parse 0.229/3.33=6.9%）[事实]。定位为 CPU/分配卫生项，不作主攻 | 低 |

### 明确不做（本轮 fresh 复核后维持，附理由）

| 项 | 理由 |
| --- | --- |
| 检查器同步化重写（R 层） | fresh 复核：同步完成时 async ValueTask 零堆分配（struct builder），每调用成本是 ns 级 CPU 往返；153 处 ForceYielding 仅在栈将尽时触发。1348 async 方法的全面同步化 + 专用大栈线程的投入，按本场读码与 ledger r24 微基准定价（2.0~2.3 ns/调用、热帧折算 0.22%）都低于投入线。**不列为主攻**；若未来 P1 项把 check 墙钟压到新基线后可重估 |
| RelationOperation 池化 | r27 三批次 +2.27~3.04% 墙钟（AOT 布局扰动），分配收益 −4.3 MiB 完全不成比例；ledger 表3 |
| GC 堆数 4/8 | r31 双臂否决（heap4 停顿 +20~49%；heap8 巨文件墙钟 +8.5% CI [1.045,1.108]）；ledger 表2 |
| Utf8String 构造期哈希缓存 | r30 定价上限 0.3~0.5% 且有净负风险；Go map[string] 同样每次现算，属中性差异 |
| Kind 跳转表分派 | r30 实测上限 0.02~0.3% 检查墙钟 |
| AST struct arena | 节点尺寸已与 Go 相当（r23）；fresh 复核 SyntaxNode 字段集无冗余 |
| 跨 checker 链接唯一化 | 上限 ~10 MB（1.2%），需共享每 checker 可变表 |
| 245 容器候选队列、S 层 members.Values.ToArray ×3 | r30/本轮清点已关账（总值 <0.5%） |
| watch/LSP 深审计、sourceMap span 分类 | 超 CLI 战役范围 / 仅 map 形态付费；ledger 表2 |

## 4. 验证协议（逐项）

1. **构建红线**：每项落地 `dotnet build TypeScript.slnx -c Release` 0/0（含 analyzer 段）。
2. **分配**：`--extendedDiagnostics` 分阶段求和，交错 ≥3 组、带宽 <0.5 MB 才有效；C1 动工前先加联合缓存探测计数器（探针形态，随提交保留开关）。
3. **墙钟**：AB 交替批次 ≥11 对；小于 1.1% 的结论必须带 CI；关系链触碰项（C1 若改 RelationKey 路径则触发）先过隔离巨文件批次。
4. **产物等价**：bytecheck 25/25 + safety 90/95（失败集合=已知基线）。
5. **反事实**：删除/清理类改动（E1 循环移除）全绿不构成充分验证——需恢复对照一次确认退化，或逐分支等价性证明 + bytecheck。
6. **门禁验证门禁**：新探针/计数器上线前用已知坏输入证明会红（mutation probe）。

## 5. 出口

- 采纳项按 P0→P1→P2 顺序逐项落入产品，每项独立提交 + 独立批次数据入轮次报告。
- P0 四项若全部达到预期（print 逐码点循环消失 + braceMap 数学 gate + 两处 LINQ），emit 阶段墙钟应有可测下降；分配应有确定性下降（E4/M2/M3/M4 合计可测）。
- C1/C3 若计数器定标显示低于投入线（<0.5% 分配），降级为卫生项或入 ledger 表2 带数据。
- S1 若 4/8/16 三臂无差异，入 ledger 表2（并发面关闭）。
- P3-1 若真实工程 TLA 占比 <1%，入 ledger 表2（条件不成立）。
- 全部结束后刷新三方对比表（当前口径 r28 表）并按 perf-budgets §2 核对 SLO 防回潮线。

## 6. ledger 去重标注（定稿前对照，2026-10-12）

本方案全新发现（ledger 无记载）：E1/E2/E3/E4、C1、C2、C3、M1、M2、M3、M4、S1、S2、S3、S4、P3-1、P3-2。
与 ledger 交集及处置：C4（RelationOperation 池化）= 表3 已否，本方案明确不重开；P3-3（扫描器微结构）= 表2 已定界，降级为卫生项；同步化重写 = 表2 已定价，列入明确不做；GC 堆数 = 表2 已否；Utf8String 哈希 = 表2 已否；AST arena = 表2 已否。

## 7. 实施处置（2026-10-12 晚，报告见 `docs/csharp-perf-report-r32.md`）

9 个产品提交。落地：E1/E3/E4、C1/C2/C3、M2/M3、S2/S3、S1（仅旋钮）、P3-2。回退/放弃/推迟：E2（braceMap 喂 `state.Cursor`，gate 改字节，当日回退）、M1（池化缓冲需拷贝，所有权证伪）、M4（`checker-program-safety` 钉死拷贝契约，当日回退）、S4（错误密集型语料缺失，待夹具）、P3-1（真实工程 TLA 0/113，无语料）、P3-3（低于噪声下限 + 取消检查降粒度）。终态：CLR 分配 −22.4%、墙钟 −11.0%、25 夹具逐字节全过、safety 91/95（失败集合 ⊆ 已知基线）。ledger 表1/表2 已同步。
