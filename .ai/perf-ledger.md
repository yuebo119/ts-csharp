# perf-ledger（typescript-cs · EPSL 三表账本）

> 建账 2026-10-11（EPSL 接入）。防重复提案的单一事实源：提任何性能建议前先比对三表；表2 否决必带分解数据，表3 翻案须先解决记载的前置障碍。
> 每行标注轮次与文档锚点（`docs/csharp-perf-*`）。轮次报告是原始证据，本账本是索引与裁决记录；冲突时以轮次报告为准并回改本表。

## 表1 已充分利用特性（已用，勿再建议"引入"）

| 特性/机制 | 落点 | 轮次锚点 |
| --- | --- | --- |
| `SearchValues` 字符集合 | 扫描器 | r20 确认（r30 §2 复核） |
| `runtime-async=on` + `OptimizationPreference=Speed` | `csharp/Directory.Build.props` | 工程配置 |
| NativeAOT 产品形态 + `IsAotCompatible` 全链路验证 | 同上 | 工程配置（P0 #3） |
| Server GC 编译期启用 + DATAS 关闭 | `GarbageCollectionAdaptationMode=0` | r18（重负载 +14~31%） |
| 单文件分段并行打印 + `SourceFeatures` 五趟跳过 + ImportElision 链接标记 | emit | r06 |
| `ConstAsync` 类型参数不可达跳过上下文查询 | checker | r08 |
| 同形匿名类型关系快路径 / `PropertyAsync` 同步快路径 | 关系引擎 | r10 / r12 |
| 惰性化家族：NameGenerator 跟踪映射、TypePredicates 工作栈、惰性约束表 + 索引循环、TypeRecursion 惰性工作栈 | 各处 | r07 / r13 / r15 / r23 |
| 成员表三处修复（静态循环替闭包、消二次拷贝、空合并早退） | `StructuredMembers` | r21（−3.5% 分配） |
| 成员表 `List<Symbol>` LIFO 栈租借（嵌套安全/异常自愈） | `StructuredMembers` | r27（setMembers 独占 −60%） |
| `TypeAlgebra.Filter` 计数+直填双遍 | 关系引擎 | r27 M1 |
| emit 复用诊断期 checker 池 | `IncrementalProgram.Emit.cs` | r28 F1（medium emit −3.5%，LinkStore creates −23%） |
| 每文件收尾分桶（未用作用域/重命名绑定/迭代诊断/缺失属性，F2~F5） | `Checker.{Iteration,Source,Access,MissingProperties,Function,Unused}.cs` | r28 |
| `EmitTextWriter` 单 `Utf8StringBuilder` 全量缓冲、每文件一次写 | 打印器 | r30 §2 取证健康 |
| r32 批次（`docs/csharp-perf-report-r32.md`，累计 CLR 分配 −22.4%/墙钟 −11.0%） | | |
| `EmitTextWriter.TrackLineStarts` + atLineStart O(1) 末码点判定 + 逐码点循环 ASCII 快路径 | 打印器 | r32 E1 |
| 注释路径实例 scratch + 原地压实 + `Comments(ReadOnlySpan)`；`CommentRanges` 静态入口供语言服务 | 打印器 | r32 E4 |
| `Utf16Length` ASCII 段一次向量化扫描 | source map | r32 E3 |
| `TypeCacheKey` 六值内联（栈缓冲构建，>6 回落数组） | checker 缓存 | r32 C1 |
| Apparent/iterator/JSX 建议名走 `Utf8Literals` 缓存静态量 | checker | r32 C2 |
| `NewSignature` 空类型参数列表共享空 `ReadOnlyCollection` | checker | r32 C3 |
| `EnvironmentScope`（含三 List）有界池 64 | transform | r32 M2 |
| `Peek` 40/41 处 static lambda（`Func<Parser,bool>` 重载，缓存委托） | 解析器 | r32 M3 |
| `Wtf8.DecodeString` ASCII 快路径（单遍转换；span 版 File API .NET 11 不存在已查证） | 文本/文件系统 | r32 S2 |
| `Utf8StringBuilder.DetachText()` 视图转交（emit writer 末次使用） | 文本/emit | r32 S3 |
| `TSHARP_PARSE_CONCURRENCY` 环境变量（parse+bind 槽位，默认 4） | 编排 | r32 S1 |
| JSDoc tag 单遍检测（deprecated/see/link 族一次遍历 + 早退） | 扫描器 | r32 P3-2 |
| r34 批次（`docs/csharp-perf-report-r34.md`，对象字面量上下文路径分配削减；配对 A/B：真实工程 −0.39%/medium −6.30%/huge-file −2.88%） | | |
| 上下文查询 spread 边界单遍循环（替 LINQ 链的 4 迭代器 + 2 数组） | `ExpressionContexts.GetAsync` | r34 F1 |
| `LiteralAsync` 非复合非实例化上下文一次旗标判定（避 Stack 分配） | `ExpressionContexts` | r34 F2 |
| `WidenLiteralAsync` 唯一符号加宽按联合与否分流（非联合免 MapAsync 闭包） | `ExpressionContexts` | r34 F3 |
| 对象字面量 `IndexInfo` 列表惰性构建（仅计算属性名需要） | `ObjectLiterals.CreateAsync` | r34 F4 |
| 数字字面量语法检查复用单个 Scanner（Reset 而非 new） | `Checker.LiteralGrammar` | r34 F5 |
| r35 批次（`docs/csharp-perf-report-r35.md`，.NET 原生形态第 0~2 期；真实工程 noEmit −0.90%/huge-file 两期 −2.96%/全量态 998.7 MB；墙钟中性） | | |
| 约束递归身份栈池化（每 checker 单缓冲容量 64 + (buffer,count) 视图，替每层数组快照） | `TypeConstraints.ResolvedBaseAsync` | r35 W6 |
| 内部存储消包装对 45 处（数组即 IReadOnlyList；UnionOrIntersectionType 双存并轨；空表单例 Array.Empty） | `Types`/`TypeContext`/`TypeReferences` 等 24 文件 | r35 W1 |
| checker 成员表统一 `Binding.SymbolTable`（内联小表 + 拷贝构造；ReadOnlyDictionary 包装清零；字面量表带容量提示） | `StructuredMembers`/`ObjectLiterals`/`ObjectSpreads` | r35 W2 |
| emit 输出缓冲按源文件字节长度预置容量（消倍增孤儿链；huge-file emitBufferGrow own 16.90→8.39 MB） | `EmitTextWriter`/`CompilerProgram.EmitMaps` | r35 W7-lite |
| 字面量物化属性排序 `List.Sort` 替 `Order()` LINQ（TypeOrder 全序无并列，稳定序等价） | `ObjectSpreads.ObjectAsync` | r35 |
| `emitBufferGrow` 分配探针（Utf8StringBuilder.Reserve 扩容分支） | `Diagnostics/AllocationProbes` #39 | r35 |
| 展开路径尾部定长元数手写倒扫（替 Reverse().TakeWhile().Count() 双迭代器） | `ExpressionContexts.ElementAsync` | r35 |

## 全量重读轮（2026-10-14/15，独立会话；原始证据 `docs/csharp-perf-report-fresh-2026-10-14.md`；锚点：入库量具 `csharp/tools/perf-{fixtures,verify,measure}.mjs` 与 8 个提交 f14ff4b…e264e59）

已实施（均已过 6 夹具逐字节产物门禁 + Release 0/0；对 Go 锚未重测，维持 r34/r35 带）：

| 项 | 落点 | 数据 |
| --- | --- | --- |
| 无变更轮次跳过 buildinfo 构建与序列化（`CurrentErrorFlags` 抽出复用；先判变更后建信息） | `IncrementalProgram.{Emit,BuildInfo}.cs`（f14ff4b、9bc8966） | 空转轮确定性分配：inc512 50.44→49.6 MB、medium 41.25→41.05 MB；medium 空转墙钟 0.639→0.623 s |
| 类型节点解析消冗余容器与 LINQ（NodesAsync 精确数组、Local 去包装、别名实参四拷→一拷、条件类型去 LINQ） | `TypeNodes`/`TypeReferences`/`TypeParameterScopes`/`TypeContext`/`Types`（4eca9f8） | check 分配：medium −0.7~1.8%、dtsheavy −1.5~2.7%；Types 计数不变 |
| 打印器列号增量维护（生成侧 O(1) 列、源侧单调推进缓存） | `EmitTextWriter`/`SyntaxPrinter`（f4fd9a3） | longline（单行 65 万字节 + sourceMap）emit summed 2.60→1.29 s（−50%）、总墙钟 5.43→3.96 s（−27%）；medium/huge 噪声内 |
| 增量签名复用声明产物（签名相位与发射相位共享同一次声明变换+打印） | `IncrementalProgram.{AffectedFiles,Emit}.cs`、`Emission/EmitResult.cs`、`Programs/CompilerProgram.Emit.cs`（e264e59） | 编辑轮 editbig（64×22KB 声明+增量）：emit 分配 1452→356 MB（−75%）、emit summed 2.89→1.46 s（−49%）、墙钟 −11~13%（三对交替）；medium 编辑轮：emit 分配 301→102 MB（−66%）、墙钟 −5.3%。逐字节：129/196 产物（含全部 .d.ts 与 tsbuildinfo）全等 |
| safety 套件默认 harness 路径修复（旧值指已删除的外仓布局，首次直跑必假红） | `csharp/tools/run-safety-suite.mjs`（a568797） | 不传参直跑：90/93、失败集合等于文档基线、content-mappers 通过 |
| 验证设施入库：夹具生成器 + 逐字节门禁 + 确定性测量（本轮全部数字可由这三支脚本复现） | `csharp/tools/perf-fixtures.mjs`、`perf-verify.mjs`、`perf-measure.mjs` | `perf-verify --label pre/post` 端到端 BYTECHECK-OK（6 夹具）；`perf-measure` 复现 medium 全量与 inc512 空转数字 |

本轮证伪（数据留档，勿重提案）：

| 项 | 证伪数据 |
| --- | --- |
| 「多 checker 分配 ×3.3」 | 假象：`Alloc X (summed)` 在并行相位重叠重复计数。进程总量口径：medium 8 checker 315.5 MB vs 1 checker 284.0 MB（+11%），tiny512 245.5 vs 231.7 MB（+6%）。真实代价是 CPU（summed check 2.2 s→3.6~4.0 s）与类型对象（+31%）；墙钟 8 checker 反而 −19%（medium）/持平（tiny512） |
| 自适应下调 checker 数（小项目 1~4） | 反向：small3（3 文件）默认 8 checker 2.77 s vs `--checkers 1` 3.07 s（比值 1.11）。每 checker 的 lib 推导可并行摊薄，下调反而更慢 |
| checker 数上调（>8） | tiny512 c8 2972 ms → c32 2789 ms（−6.2%）但 medium c8 2830 → c32 2985 ms（+5.5%）；文件数重负载可作旋钮选项，默认不动 |
| checker 数下调（扫描读数 → 配对推翻） | 未配对扫描（3 次中位）曾显示 c4/c2 常胜 c8（medium 2658 vs 2897、dtsheavy 2334 vs 2835）；按仓库配对协议交替 5 对复测：medium c8 比 c4 快 4.7%（比值 0.9526），dtsheavy c2/c8 比值 1.0401、tiny512 1.0017、huge 1.0044，均落在噪声带内。结论：默认 8 检查器成立，不调；扫描式（非配对）读数的漂移量再次被实测标定为 ~±10% |
| `S()`/`Scoped()` 元数特化省分配 | 前提不成立：`parts.ToArray()` 即 Parts 容器的唯一必要分配，特化后仍是同一份数组 |
| 增量轮文件 stat/哈希复用 | 前提不成立：`InitializeAsync` 的哈希是对已解析的内存文本做（不重复读盘）；`-b` 状态检查与初始化的重叠面仅为"比输出更新的文件" |
| 配方（recipe）token 切点缓存 | 收益面窄：容器免分配路径已覆盖多数节点，recipe 扫描不分配；缓存键须处理切片文本，风险大于收益 |
| `IncrementalSnapshot.Copy` 惰性化 | 量级不足：512 文件 ~60 KB/轮，万级文件 ~1 MB/轮，COW 改造风险不成比例 |
| 巨文件打印工作栈容量按节点数预置 | 峰值栈深实测（临时探针，已还原）：huge 65,575 parts（64 B/个 ≈ 4 MB 链）、longline 60,017、medium 102；huge 打印 76.6 MB 分配为弥散构成（输出缓冲按源长预置 + 映射存储 + 映射 JSON + 部件流转），栈链占比 ~5%，低于投入线 |
| 诊断分组一次成型（触发条件已建立） | 新夹具 errdense（200 文件 × 25 个类型错误 = 5,000 诊断，含 clean 双胞胎；生成器 `csharp/tools/perf-fixtures.mjs`，`perf-measure --fixture errdense` 可复现）实测：相对 clean 双胞胎，进程分配 +58.7 MB（+25%，≈12 KB/诊断）、check CPU +25%，**墙钟无可测差异**（2.33/2.47 s vs 2.50/2.15 s）。该密度下诊断管线（分组/排序/去重/打印）不构成墙钟瓶颈，维持推迟；夹具已入库，未来错误形态成为目标负载时直接可用 |

P2-11（跨 checker 共享声明语义）判定数据（2026-10-15 补，`--checkers 1/2/4/8` 全量构建，每格 3 次中位；复现：`perf-measure --fixture <名> -- ... --checkers N`）：

| 夹具 | 墙钟 c1/c2/c4/c8 (ms) | check CPU c1→c8 | 进程分配 c1→c8 | Types c1→c8 |
| --- | --- | --- | --- | --- |
| medium | 3235 / 3277 / 2658 / 2897 | 2.11→4.38 s（+108%） | 282.6→313.6 MB（+11%） | 32,853→43,066（+31%） |
| dtsheavy | 2656 / 2334 / 2450 / 2835 | 1.73→2.53 s（+46%） | 220.0→232.1 MB（+5.5%） | 29,742→34,383（+16%） |
| tiny512 | 2871 / 2539 / 2655 / 2879 | 1.96→2.92 s（+49%） | 230.2→244.4 MB（+6.2%） | 28,550→33,007（+16%） |
| inc512 | 3361 / 3126 / 2855 / 2752 | 1.91→2.42 s（+27%） | 284.0→298.8 MB（+5.2%） | 28,550→33,007（+16%） |
| huge | 6345 / 5714 / 5385 / 5741 | 4.35→5.51 s（+27%） | 553.5→565.4 MB（+2.1%） | 125,608→130,300（+3.7%） |

判定：重复推导真实存在（CPU +27~108%、类型 +4~31%），但进程分配代价温和（+2~11%），且墙钟在 c8 与 c2/c4 之间仅 ±4%（配对复测，见上表证伪行）。结论：P2-11 的价值主张是"墙钟上限"而非分配，开工前仍需真实工程夹具的重复推导占比（本检出无 `packages/typescript`）与 `RequireOwned` 所有权解耦设计，维持不立项。附带定标：本机 `Program time` 固定成本 ~0.29 s，其中默认 lib 层（lib.es2017.full 链，30 文件）占 ~0.15 s；模块解析密度不影响该值（64 文件 × 20 import 与 × 2 import 的 Program time 相同）。

skipLibCheck 口径校准（2026-10-15 补，比较本报告数字前须对齐）：medium 未开 skipLibCheck 时 check 3.86 s summed / 670 MB、总墙钟 2.38 s；开启后 check 1.86 s / 270 MB、总墙钟 1.13 s（lib 与 .d.ts 检查占 check ~52%、总墙钟 ~53%）。dtsheavy 开启后 check 0.13 s（全部 .d.ts 被跳过）。

## 表2 明确不做（否决必留数据，防下轮重提案）
| 项 | 否决理由（带数据） | 锚点 |
| --- | --- | --- |
| S 层剩余回收（`members.Values.ToArray()` ×3） | ~3.9 MB（<0.5%），低于投入线 | r27 §1 |
| S2 泛型关系键池化 | 前提不成立：键载荷随关系缓存整编译期存活 | r27 §1 |
| `checkerRelated` 42 MiB 的 normalization/Simple/Weak 分解 | 三项合计 0.5 MB，主体是递归调度本体 | r22（r23 §4） |
| 跨 checker 链接唯一化 | 上限 ~10 MB（1.2%），需共享每 checker 可变表 | r22 P3（r23 §4） |
| AST 结构体 arena 重写 | 节点尺寸已与 Go 相当（IdentifierNode ~80 B vs ~72 B）；**r34 定价补强**：全量态 77.6% 分配是垃圾（check 72.7%/emit ~99%），但 GC 通道上限已由 no-GC region 实验定价为墙钟 −0.9%（停顿 81.5→3.9ms，低于噪声下限），分配器通道 .NET 已是 bump pointer 量级很小，局部性通道不建原型测不出；arena 不改对象数，碰对象数的结构体化是月级重写且带 r27 布局敏感风险 | r23 §4 + r34 探针（`docs/csharp-perf-report-r34-probes.md` §2） |
| 同步化重写（分配收益） | 异步状态机实测 0 字节/次调用 | r24 |
| 同步化重写（墙钟收益） | 每调用 2.0~2.3 ns（V2 下），热帧折算 0.22%；**r34 定价补强**：经典异步税实测为串行行 +23.75%、并行行 +12.3~12.7%（async on/off 双构建 10 对配对），但 Runtime Async V2 已把这部分全量拿走（`runtime-async=on` 自 2026-09-22 移植二期即在，campaign 全轮次带着），同步化只剩 V2 残差 0.22% < 噪声下限 | r24 + r34 探针（`docs/csharp-perf-report-r34-probes.md` §3） |
| AVX-512 / 裁剪开关 / 完整 LINQ | 三批实测零收益或更差 | r20 |
| 存储身份哈希 / 打印器 `Part[]` / 实参位置记忆化 | 三个历史假设分别被实测否掉 | r23 §4 |
| Kind 跳转表分派（类型模式链改造） | 实测上限 0.02~0.3% 检查墙钟（微基准差价 +0.46~2.73 ns/节点） | r30 §0 P1 |
| Utf8String 构造期缓存哈希 | 实测上限 0.3~0.5%（省 ~6ns/查找 × 40~60 万次），且有净负风险 | r30 §0 P3 |
| 诊断 params span（专项） | 目标市场不成立：host-paths 是启动地板负载（196/203 ms 为进程启动）；降级为触碰诊断文件时的顺手卫生项 | r30 §0 P2 |
| host-paths 诊断归因 | 负载形态为启动地板；x1.87 是 .NET AOT 运行时初始化对 Go 二进制初始化的 substrate 差距，本仓不可修 | r30 §0 |
| recStamp 25.3 MB / resolveMembers 78 MB 回收 | 内部是保留结构本体（成员表/类型对象），非临时容器 | r27 §1 |
| watch/LSP 长驻形态深审计 | r28 F1 已让每次触发复用池；深审计超出 CLI 战役范围（记录，非永久否决） | r30 §2 |
| sourceMap 形态 Track 片段级 span 分类 | 仅 sourceMap 编译付费；该形态成为目标负载再议 | r30 §2 |
| GC 堆数（HeapCount 4/8） | 双臂否决：heap4 停顿三轮同向 +20~49%；heap8 停顿持平但巨文件墙钟 +8.5%（CI [1.045,1.108]）、cpuMs +53%，RSS −21% 不构成理由；方向与 r18 多堆结论同族。csproj 保留条件 bake 管线（默认关） | r31（`docs/csharp-perf-report-r31.md`） |
| CA1849/CA2012 全量改写（57 处） | 2026-10-11 逐点分类：零真实缺陷（同步纯函数 ~26 处逐个读码验证零阻塞 / runtime-async 桥接 ~16 处 / CTS.Cancel 8 处关闭语义 / 收尾打印 3 处 / 守卫 .Result 2 处）；改写触碰关系链，r27 先例风险（−4 MB 分配换 +2.3% 墙钟）超过全部确定收益。规则降 suggestion，依据在 `csharp/.editorconfig` 段内注释 | 本轮清点日志 + Maybe/Add/Access/Loop/CheckerEnvironment 读码 |
| 245 容器候选队列 | 2026-10-11 频度分诊执行完毕关账：探针上限临时 16→64 发产品实测（`pkgs/epsl-probe64`），top-64 帧全部有分量帧（帧 #64 仅 28 KB）均属 r26 §1.2 与 r13/r23 已审计家族，无一未审计热帧命中队列站点；队列总值上限 3~4 MB（0.4%，r30 源码定界）< 墙钟分辨率 ±1.5%，单点均值 ~15 KB，修复风险（关系链布局）> 单点价值 2 个数量级。触发条件：量级越界 10× 或新负载类型时重开 | 本轮 top-64 帧表 + r30 §2 |
| 扫描器内部深挖 | 边界定界关账：解析 summed 0.095 s / 墙钟 1.14 s = 8.3%，扫描器内部 ⊂ 解析；即使 10% 内部优化 < 0.9% 墙钟 < 噪声下限 1.1%，现实预期 <0.5%（与 r30 判断一致）；SearchValues 已用（r20） | 本轮 epsl-a1 实测 + r30 §2 |
| braceMap 位置数学 gate 在 sourceMap | 前提被证伪：braceMap 不只喂 MapPosition，还喂 `state.Cursor`（Code() 末尾），决定下一次注释扫描起点；gate 后带注释文件发射字节改变（token 间多空格，medium 复现）。MapPosition 无 map 时已 no-op，原实现无浪费 | r32（`docs/csharp-perf-report-r32.md` §3） |
| no-GC region（`GC.TryStartNoGCRegion`） | **r34 复测再否决**（推翻 r33 的否决前提，但结论不变）：r33 的「产品配置 0.0ms 停顿」测于 check 恢复态（374MB 家族，method.md §7.1）；全量 check 态实测停顿 81.5ms、gen0 3 次，region（2048MB）可压到 3.9ms 且编译期零 collection。但 ① 停顿与并行 checker 重叠：全量负载墙钟 10 对中位仅 −0.90%（低于 1.1% 噪声下限，判不可分辨）；② `--version` 51.1→109.2ms（+113%，击穿启动类预算）；③ 峰值 RSS 826→945MB（+14%）。当日回退。**「产品配置不触发 GC」表述作废；「停顿不是墙钟差距主因」因并行重叠仍成立** | r34（`docs/csharp-perf-report-r34.md` §4） |
| R2R 自包含（动态 PGO + 分层编译）替代 NativeAOT | 实测慢 2~2.6 倍：medium 454 vs 237ms、huge-file 1664 vs 640ms（AOT，配对）。AOT 全优化码生成胜过 R2R+PGO 的稳态收益，JIT 热在此类短命进程 Warmup 成本压倒性。NativeAOT 形态保持 | r33 实验3 |
| gen0 预算 pin / GCLatencyMode.SustainedLowLatency |  moot：全量态 GC 触发但停顿与并行工作重叠（见 no-GC region 行，r34 修正），预算与延迟模式无可测作用对象；复测前提（恢复态零停顿）已作废，若重提案须在全量态配对 | r33 实验2/4（r34 修正前提） |
| parse/bind 槽位默认 4→8 | 产品配置下实测反向：真实工程 5 对交错 c4 中位 616ms vs c8 650ms（−5.2%），builder 共享字典争用超过并行收益。此前 JIT+工作站 GC 下的「8 槽 −1.6%」同属环境假象。旋钮 `TSHARP_PARSE_CONCURRENCY` 保留，默认 4 确认 | r33 实验4 |
| NodeList 单分配（池化缓冲免 ToArray） | 所有权分析证伪：池化 List 的缓冲会被下一个列表复用，`ToArray()` 是 AST 长期属主所必需；NodeList 包装器随 AST 永生无法归还。双分配是该设计下限 | r32 §3 |
| `CheckerDiagnostic.Create` 免参数数组拷贝 | 契约违反：`checker-program-safety` 逐字钉死「调用方可在 Create 后修改传入数组，diagnostic 必须保留原 arguments」。当日回退 | r32 §3 + safety 套件 |
| parse/bind 默认并发 4→8 | 10 对交错：8 槽 7/10 对占优、中位 −1.6% 墙钟，但 summed parse CPU +45%（builder 共享字典争用），tiny-files −0.6% 噪声带内；信号处于 ±1.5% 批次分辨率边缘。旋钮 `TSHARP_PARSE_CONCURRENCY` 已留，默认 4 | r32 §3 |
| 诊断分组一次成型（CheckerPool 字典直传 + IncludeDiagnostics HashSet） | 推迟：目标负载（错误/include 密集型诊断）不在测量语料（夹具全 clean），O(文件×诊断) 无对象可测；诊断管线输出顺序敏感。触发条件：错误密集型工程夹具 | r32 §3 |
| 顶层 await span 级重解析（Go 1:1 移植） | 推迟：真实工程 113 个非声明文件中顶层 await 为 0，收益不可测；语句拼接微妙（扫描器重定位/JSDoc/错误恢复）。触发条件：语料出现 TLA 文件 | r32 §3 |
| 扫描器微结构三项（标点优先分发/空白向量化/取消检查降频） | 承接上行定界：per-token 取消检查约 1ms（低于噪声两个数量级）且移除降低 Ctrl-C 粒度（语句级无现存检查）；标点优先与空白向量化合计预期 <0.5% 墙钟 | r32 §3 |
| emit 缓冲 ArrayPool 池化（W7 原形态） | 所有权审计否决：`DetachText` 视图跨越 `emitOptions.WriteFile` 钩子与可替换 `IFileSystem`（LSP 内存文件系统可保留文本），归还池即悬垂。同源收益已由容量预置拿走（huge-file emitBufferGrow own 16.90→8.39 MB，孤儿链消除），不动所有权 | r35（`docs/csharp-perf-report-r35.md` §4） |
| API 边界结果的 `Array.AsReadOnly` 去包装 | `module-program-specifiers-safety` 钉死 `((IList<T>)result.Specifiers)[0]=x` 必须抛 `NotSupportedException`，裸数组 IList 写入会成功（实测两测试新失败后回退）。界线：内部存储包装是冗余（45 处已去），API 边界包装是不可变契约（ModuleSpecifierGenerator/SemanticTokens/ProjectSnapshot 保留） | r35 §5 教训 1 |

## 表3 勿重开（实施后被证伪回退，翻案须先过前置障碍）

| 项 | 证伪数据 | 翻案前置 |
| --- | --- | --- |
| RelationOperation 对象池 | 生命周期/重置清单/尺寸全匹配的池，巨文件墙钟 +2.27~3.04%（三个独立批次重现），分配收益 −4.3 MiB 完全不成比例；机制指向 AOT 对关系调用链的内联/布局扰动（本战役第三个布局敏感样本） | 先解决布局扰动归因（EventPipe 在本机 .NET 11 RC 不可用）；任何触碰关系调用链的改动必须先过隔离巨文件批次 | r27 §2 |
| 大栈专用检查器线程 | 栈守卫 874,660 次调用零让出；默认 1 MB 与 64 MB 栈结果相同且 +0.33 MB；已回滚 | 无：结论是确定性的 | r23 §4 |
| 「checker 并行效率不足」三候选：(a) 每 checker 固定构造成本 / (b) 内存带宽或 GC 饱和 / (c) 并行区串行尾巴 | **三条同批全部证伪**（r37 P0，`docs/csharp-perf-plan-r37.md` §3/§4）：(a) checkConstruct 墙钟 ≤55 ms、constructEach 8 checker 求和 0.154 s；(b) 进程分配 c8/c1 仅 +26%（76→96 MB）、GC 暂停 0.06→0.14 s，而 check 线程时间 ×3.4~4.7，且并行效率已 6.6~6.9×；(c) diagnosticsTotal−checkPool = 20~50 ms、globalDiag/fileDiag/affected ≈ 0。**真因是 (d) 每 checker 重复派生（check ×3.39~4.73、emit ×2.73~3.37，parse/bind ×1.0）+ (e) 单文件关键路径** | 翻案前提：先做 §5 L1「共享只读派生缓存」原型；若 L1 落地后净收益仍 <1.3× 再议并行度本身 | r37 §3/§4 |

## 待勘区（未否决、未做完，勿重复立项评估）

**r37 移交四件（2026-10-15，`docs/csharp-perf-plan-r37.md`）**：①**L1 checker 去重（首位）**——每 checker 重复派生共享结构（全局/lib 作用域 + 惰性类型解析）：官方口径 medium check 线程时间 c1→c8 = 0.52→1.76 s（×3.39）、`partitionSum/checkPool` 并行效率已达 6.6~6.9× 但净收益仅 1.96×；`tiny512`（512 个互不导入文件）同样 ×5.7，证明重复来自每 checker 的全局/lib 解析而非跨文件导入。候选路径：以共享 `Symbol`/`SyntaxNode` 为键的读穿共享只读缓存（原 checkpoint P2-11 的通用化）。预期两口径 Total −13~17%。②**L2 emit 去重（新晋）**——`Emit time (summed)` c1→c8 = 0.44→1.21 s（×2.73），占 c8 Total ~28%；假设是 emit 借池 checker 与「该文件当初的 checker」不亲和、缓存冷而重复派生。**emit 侧当前零探针，先补探针后动工。** ③**L3 单文件关键路径（口径相关）**——夹具默认口径（检查声明文件）下 `lib.dom.d.ts`（110,506 节点，权重 10× 次大文件，`limit=maxWeight` 使其独占一个 checker）检查耗时 = 整个 check 墙钟（medium 1.50 / dtsheavy 1.60 / tiny512 1.42 s）；`huge` 的 `big.ts` 固定 2.87 s。r35 W1–W3 在此获得明确靶点与度量；**单文件内并行切分只留评估、不动工**。④**L4 默认 lib 层固定成本**——Config 0.13 + Program 0.21~0.48 s/进程，对小负载是单进程最大固定项；预解析+预绑定 lib 只读产物。
**口径纪律（r37 新增，必须遵守）**：官方 harness workload 生成器写死 `skipLibCheck: true, lib: ["es5"]`（`csharp/tools/performance-cli.mjs:50`），本仓 perf 夹具默认不设（`csharp/tools/perf-fixtures.mjs`）——(e) 只在后者可见，(d) 两口径都在。**任何 checker 相位数字必须带口径**，否则不可比。

**r35 移交三件（2026-10-13，`docs/csharp-perf-report-r35.md` §7）**：①W3 字面量形状结构体化（方案主攻）——弹性已放行（AOT huge-file 1:1.1 / medium 1:4.2 / 串行 1:7.6，AB140/AB141 实测矩阵，JIT 臂 1:3.5~1:10.9）、W2 使能器已落地、逐站点分配普查在方案 §4.W3 表；预期 medium −30% 分配 ≈ −7% 墙钟、真实工程侧 ≤3%（普查：字面量族在真实工程 check 相位仅 7.7%）；r27 布局敏感先例覆盖，隔离巨文件批次强制。②W4 closed 整链 + union（union 是 preview 特性，GA 前语法可变；墙钟 <0.5%，正确性动机为主，独立会话执行）。③W5 FrozenDictionary（<0.5%，触碰全局只读表的轮次顺手做，不单独立项）。观测面移交：真实工程下一个有斜率的分配面是关系引擎族（单 checker inclusive relationCompare 185 M / checkerRelated 170 M），受 r27 表3 勿重开约束，除非布局扰动归因先行解决，此面保持关闭。

两项待触发器（均已在表2 记录数据与触发条件）：诊断分组一次成型（待错误密集型夹具）、顶层 await span 级重解析（待语料出现 TLA）。对 Go 的 AB 批次刷新已于 2026-10-13 完成（r34-comparison，四批 AB129~AB132；重负载对 Go 默认 x1.423，AB132 对批证实 r34 与 r32 墙钟等价，与 r32 表 x1.397 的差为批间漂移）；分层协议实验（--tier）当日落地后按用户指令全额还原。**同节点二次全量复测（AB134~AB136，还原后的原始协议）：重负载对 Go 默认 x1.398、对基线 +47.6%，与首批 x1.423/+47.1% 的差 ~1.8% 即批间漂移的实测幅度，区间 x1.398~x1.423 已回写 perf-budgets。** Go 侧 155 MiB 的分配口径（GOGC=off 提交峰值，r15）未随夹具态重测，"分配相对 Go"预算行待 Go 侧重测后重设。r35 轮墙钟中性（AB143/AB144 全 CI 跨 1.0），未触发对 Go 全量批次，墙钟锚点维持。

**从零重建基线 + 全量复测（2026-10-13，`docs/csharp-perf-report-r34-rebaseline.md`，批 AB137~AB139）**：三侧全部从源码重建（Go 参考 sha256 与历史逐字节一致；C# 基线与当前产物输出逐字节一致）。fresh 全量结果：重负载对 fresh 基线 +46.2%、对 Go 默认 x1.396；分配 1,221.7 → 1,001.7 MB（−18.0%，与历史二进制测量差 0.02%）。**关键发现：历史 naot-svr 二进制带着旧工具链签名（fresh 重建后小 275KB，轻负载性能签名系统性不同）——轻负载 12 项对 fresh 基线读 −4.9%，而历史批读 +3.4%，说明轻负载的既存"改善"部分是工具链假象；重负载 +46% 不受影响。后续对比一律以 `pkgs-fresh/naot-svr` 为基线，历史 naot-svr 退化为史料。**

**独立仓库基线重锚（2026-10-14，docs/csharp-perf-report-r36-standalone-baseline.md，批 AB146）**：C# 侧基线节点自 pkgs/r35p2 移交 pkgs/nrb1（typescript-csharp 仓 c01f552 产物，manifests/nrb1.json）。全量 23 工作负载配对 A/B：比值 0.9924~1.0120 全落噪声带内、RSS 批内 0.998~1.005、逐字节输出全等、对照 CI [0.972,1.026] 含 1.0。后续轮次 --baseline-manifest 用 nrb1.json；对 Go 比值沿用 r34/r35 锚（重负载 x1.398~x1.423 漂移带），源码同源不重测。驱动自此批起记录为独立仓库路径 csharp/tools/performance-cli.mjs。

**对 Go 全量批次 AB147 与机器态异常（2026-10-14，docs/csharp-perf-report-r36-comparison.md）**：nrb1-vs-go-default 全量 23 行有效（逐字节全等、p95/min≤1.29），但当日机器态对 C# AOT 侧系统性劣化且 Go 侧稳定：同一 r35p2 二进制隔日 wall 542.5→729.3（+34%，cpu 812.5→921.9、并行度 1.50→1.26），r34 二进制当日复测 782.6 与 nrb1 767.3 同批等价（AB148 判别批）→ 全部 C# 二进制共同 +45%，非代码回归。当日比值（huge-file x2.032）不得写入锚；对 Go 口径维持 r34/r35 锚（重负载 x1.398~x1.423），空闲机器复测单批 nrb1-vs-go-default 后再重锚。
