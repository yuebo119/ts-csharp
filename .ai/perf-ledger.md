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

## 表2 明确不做（否决必留数据，防下轮重提案）

| 项 | 否决理由（带数据） | 锚点 |
| --- | --- | --- |
| S 层剩余回收（`members.Values.ToArray()` ×3） | ~3.9 MB（<0.5%），低于投入线 | r27 §1 |
| S2 泛型关系键池化 | 前提不成立：键载荷随关系缓存整编译期存活 | r27 §1 |
| `checkerRelated` 42 MiB 的 normalization/Simple/Weak 分解 | 三项合计 0.5 MB，主体是递归调度本体 | r22（r23 §4） |
| 跨 checker 链接唯一化 | 上限 ~10 MB（1.2%），需共享每 checker 可变表 | r22 P3（r23 §4） |
| AST 结构体 arena 重写 | 节点尺寸已与 Go 相当（IdentifierNode ~80 B vs ~72 B） | r23 §4 |
| 同步化重写（分配收益） | 异步状态机实测 0 字节/次调用 | r24 |
| 同步化重写（墙钟收益） | 每调用 2.0~2.3 ns，热帧折算 0.22% | r24 |
| AVX-512 / 裁剪开关 / 完整 LINQ | 三批实测零收益或更差 | r20 |
| 存储身份哈希 / 打印器 `Part[]` / 实参位置记忆化 | 三个历史假设分别被实测否掉 | r23 §4 |
| Kind 跳转表分派（类型模式链改造） | 实测上限 0.02~0.3% 检查墙钟（微基准差价 +0.46~2.73 ns/节点） | r30 §0 P1 |
| Utf8String 构造期缓存哈希 | 实测上限 0.3~0.5%（省 ~6ns/查找 × 40~60 万次），且有净负风险 | r30 §0 P3 |
| 诊断 params span（专项） | 目标市场不成立：host-paths 是启动地板负载（196/203 ms 为进程启动）；降级为触碰诊断文件时的顺手卫生项 | r30 §0 P2 |
| host-paths 诊断归因 | 负载形态为启动地板；x1.87 是 .NET AOT 运行时初始化对 Go 二进制初始化的 substrate 差距，本仓不可修 | r30 §0 |
| recStamp 25.3 MB / resolveMembers 78 MB 回收 | 内部是保留结构本体（成员表/类型对象），非临时容器 | r27 §1 |
| watch/LSP 长驻形态深审计 | r28 F1 已让每次触发复用池；深审计超出 CLI 战役范围（记录，非永久否决） | r30 §2 |
| sourceMap 形态 Track 片段级 span 分类 | 仅 sourceMap 编译付费；该形态成为目标负载再议 | r30 §2 |

## 表3 勿重开（实施后被证伪回退，翻案须先过前置障碍）

| 项 | 证伪数据 | 翻案前置 |
| --- | --- | --- |
| RelationOperation 对象池 | 生命周期/重置清单/尺寸全匹配的池，巨文件墙钟 +2.27~3.04%（三个独立批次重现），分配收益 −4.3 MiB 完全不成比例；机制指向 AOT 对关系调用链的内联/布局扰动（本战役第三个布局敏感样本） | 先解决布局扰动归因（EventPipe 在本机 .NET 11 RC 不可用）；任何触碰关系调用链的改动必须先过隔离巨文件批次 | r27 §2 |
| 大栈专用检查器线程 | 栈守卫 874,660 次调用零让出；默认 1 MB 与 64 MB 栈结果相同且 +0.33 MB；已回滚 | 无：结论是确定性的 | r23 §4 |

## 待勘区（未否决、未做完，勿重复立项评估）

| 项 | 状态 | 锚点 |
| --- | --- | --- |
| GC 堆数（HeapCount 4/8 两档） | 唯一剩余可测配置杠杆，r31 首选（bake + AB 配对 + 停顿行直读） | r30 §2/§3 |
| 245 项容器候选队列 | 已消化 4 例（r26/r27），剩余 ~241 项按探针频度分诊，每轮顺手批，上限 ~3~4 MB | r30 §2 |
| 三方对比表刷新（r28 节点） | r28 墙钟收益需 23 负载全量表确认位置 | r28 §4 |
| 扫描器内部深挖 | 低期望值（预期 <0.5%），可选勘区 | r30 §2 |
