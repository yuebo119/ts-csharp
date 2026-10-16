# r39 L1 原型方案：checker 共享只读派生缓存（缓存键与接口签名，待评审）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-16 ｜ 轮次: r39（L1 原型设计，未动工）｜ 主题: checker-shared-readonly-derivation-cache
> 触发: 用户令「为 L1 写原型方案（先出缓存键与接口签名过评审，不动产品代码）」
> 关联: `docs/csharp-perf-plan-r37.md` §5 L1（本方案的前身与优先级来源）、`docs/csharp-perf-report-r38.md`（本轮锚点）、`.ai/perf-ledger.md` 待勘区
> 状态: **待评审**。本文只定义缓存键、接口签名、分期与门禁；任何产品代码改动以评审通过后的单独提交进行。

## 1. 结论摘要

L1 的目标（消除每 checker 对共享结构的重复派生）在本轮重新量产后**规模比 r37 的读数小一个层次，但方向成立，且与「墙钟受最重分区约束」的事实相容**。本方案给出四族缓存键（K1~K4）与一组接口签名，分四期推进，P0 探针未产出分解数据前不承诺收益数字。最重要的新事实：r37 在 2026-10-15 测得的 check 线程时间 ×3.39~4.73 **未能在干净机器上复现**（今天同二进制血统：真实工程 ×1.46、官方 medium ×1.67），L1 的一切收益预期按今天的数据标定。

## 2. 锚点与本轮新测

### 2.1 r38 配对锚（干净机器，产品配置）

真实工程 11 对配对：当前/Go 默认 **x1.382 [1.353, 1.413]**（全量态）、**x1.286 [1.249, 1.317]**（noEmit）；合成 23 负载重负载族对 Go 默认 x1.384，最差 medium-checkers-1 x1.973。真实工程不在合成平均之外，x1.50 预算线对两种口径都成立。

### 2.2 本轮 c1~c8 相位探针（2026-10-16，产品配置，每次 fresh copy）

真实工程（291 文件图，noEmit，`--extendedDiagnostics`）：

| c | Check(summed) | checkPool 墙钟 | Total | Types | CLR 分配 | 最重分区 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.377 s | 1.378 s | 2.027 s | 93,380 | 700.3 MB | 1.377 s |
| 2 | 1.464 s（×1.06） | 0.897 s | 1.591 s | 103,200 | 713.4 MB | 0.897 s |
| 4 | 1.726 s（×1.25） | 0.685 s | 1.252 s | 124,928 | 773.6 MB | 0.685 s |
| 8 | 2.009 s（×1.46） | 0.685 s | 1.295 s | 139,978 | 803.9 MB | 0.685 s（其余 0.139~0.289 s） |

官方 medium 夹具（64 文件 × 24 接口，es5 + skipLibCheck）：c1 check 0.054 s / Total 0.206 s；c8 check 0.090 s（**×1.67**）/ Total 0.085 s，分区均衡（各 0.011~0.013 s）。

### 2.3 三个可判读的事实

1. **重复派生存在但规模是 ×1.46**（真实工程 c1→c8 线程时间），不是 r37 的 ×3.39~4.73。r37 的绝对时间列（official medium Total 1.613/1.213 s）同此处理：今天同夹具同口径为 0.206/0.085 s，工作站量具环境对照实验（gen0 4 MiB + LOH 1 MiB）只差 10%，排除 GC 配置解释；差异归机器态或夹具形态，未最终定位，**r37 的绝对时间不再作为标定基准**。
2. **check 墙钟受最重分区约束，不受总线程量约束**：c4 与 c8 的 checkPool 墙钟同为 0.685 s（同一簇重文件：最大单文件 7,133 行，无 lib.dom 级巨型文件，es2022 lib 链最大 464 行），其余分区 0.139~0.289 s。重复派生如果被消除，**最重分区同样受益**（它含自己那份重复），因此 L1 确实作用于墙钟；但幅度取决于最重分区里重复派生的占比，未测。
3. **构造期（Layer A）量小**：c8 的 `constructEach` 0.021 s + `globalMerge` 0.019 s = 0.040 s（占 check 线程量 2%），但分配 57.8 + 45.8 = 103.6 MB（占 13%）。Layer A 的时间上限约 40 ms，分配上限约 100 MB。

## 3. 代码现状（锚点）

构造链（每 checker 全量重跑一遍）：

| 环节 | 锚点 | 内容 |
| --- | --- | --- |
| 池创建 | `Checking/CheckerPool.cs:37` `CreateAsync` | `count` 个 checker 并行 `program.CreateCheckerAsync`（:49-50） |
| checker 构造 | `Checking/Checker.Queries.cs:38` `CreateAsync` | 新建 `TypeContext`/`CheckerLinks`/`CheckerEnvironment`，经 `CheckerSymbols.CreateAsync` 回调构造 `Checker`（~30 个服务对象，`Checking/Checker.cs:26` 起） |
| 符号表 | `Checking/CheckerSymbols.cs:47` 构造 + `:164` `InitializeAsync`（`phase:globalMerge`） | 逐文件合并非模块 locals 进 globals、ambient module、pattern、augmentation 两趟 |
| 全局类型 | `Checking/CheckerEnvironment.cs:152` `InitializeGlobalTypesAsync`（`phase:globalTypes`） | 12 个命名全局类型（Array/Object/Function/Callable/Newable/String/Number/Boolean/RegExp/ReadonlyArray/ThisType/IArguments）的查找 + arity 校验 + 每 checker `Type` 对象创建 |
| 分区检查 | `Checking/CheckerPool.cs:69` `CheckGroupAsync` | 每 checker 检查自己分区的文件；共享声明（lib/@types/被多分区引用的 src 符号）在各自 checker 里惰性再派生 |

**共享约束（为什么不能直接共享 Type/Symbol 本体）**：

- `Checking/SymbolMerger.cs:10-12` 注释钉死契约：「Per-checker merging leaves bound symbols immutable. Only transient clones can be extended」。合并产出的 transient clone 是每 checker 的，检查期会被写（links、旗标、成员表）。
- `Checking/StructuredMembers.cs:57` `context.RequireOwned(type)`：类型对象归属单一 checker 上下文，跨 checker 复用即违 ownership。
- `Binding/Symbol.cs:33` `MemberTable` 是 Symbol 上的惰性可变表：绑定符号整体共享，但任何「填进去」的派生表都带归属。

**因此可共享的只有「不可变派生值」**：以共享 Symbol/SyntaxNode（引用相等；绑定后只读）为键，值取冻结快照。这与 r37 §5 L1 风险段一致，本方案把它落成键与签名。

## 4. 缓存键设计（评审点一）

缓存为**进程级、随 `CompilerProgram` 生命周期**（一次编译一个程序；程序不可变）。键分四族，按风险从低到高：

### K1 绑定索引（纯查表，零语义风险）

- 键：`SourceFileNode`（引用相等）或 `long`（`BoundSourceFile.Id`）。
- 值：`BoundSourceFile`（已存在，绑定期产出，只读）。
- 现状：`CheckerSymbols.cs:59-73` 每 checker 重建两个字典（`bindingsById`/`sourceBindings`）。
- 依据：绑定产物本就跨 checker 共享（同注释），重建纯属浪费。

### K2 全局合并计划（纯绑定派生，重放式共享）

- 键：无（计划整体一份），按 `InitializeAsync` 既有顺序结构化：
  `Steps`（逐文件 locals 合并序列）、`AmbientModules`、`Patterns`、`GlobalExports`、`Augmentations`（两趟）、`Conflicts`（冲突诊断，按既有顺序）。
- 共享方式：**共享计划、重放执行**。每 checker 仍建自己的 globals 表与 transient clone（满足 SymbolMerger 契约），但跳过「遍历全部文件 locals、判 module/ambient、收集 pattern/augmentation、冲突判定」这些纯遍历；冲突诊断按计划分发进各 checker 自己的诊断集合（每 checker 仍持一份，去重语义不变）。
- 依据：`InitializeAsync` 的全部输入（`program.SourceFiles`/`file.Binding`）都是共享只读的。

### K3 全局类型解析（纯 globals 查找 + arity 校验）

- 键：`(Utf8String name, int arity)`。
- 值：`GlobalTypeResolution(Declaration: Symbol, Arity: int, Error: DiagnosticMessage?)`，即「这个全局类型解析到哪个声明、arity 是否匹配、不匹配时的错误消息」。
- 共享方式：解析结果共享；每 checker 仍用自己的 `TypeContext` 建 `Type` 对象（`GlobalTypes.cs:72` 的 `Reference`/`CreateTypeReference`），但跳过 globals 查找与 arity 校验。
- 依据：globals 表内容跨 checker 确定（同计划同输入），解析是纯函数。

### K4 共享声明派生投影（主战场，形状待 P0 定型）

- 键：声明 `Symbol`（引用相等）+ 程序（缓存本身即程序级）。
- 值：**深不可变投影**，候选载荷（P0 后只选被证实的主项）：
  - 成员表投影：成员名 → 成员 Symbol + 旗标（不含每 checker 的 Type 链接）；
  - 类型引用投影：被引用 InterfaceType 的声明 Symbol + 类型参数个数；
  - 导出表投影：导出名 → 成员 Symbol。
- 填充方式：读穿 + 单写者预热。任 checker 派生完成一个不可变投影后发布（`Publish*` 仅允许在 warm-up/派生完成点调用）；其他 checker 命中即用。**发布后仍会被本 checker 修改的值不得进缓存**（R1）。
- 依据：×1.46 的重复主体在检查期（K1~K3 只覆盖构造期的 2% 线程量），这是 L1 的价值所在，也是风险所在。

## 5. 接口签名（评审点二）

```csharp
// 进程级，随 CompilerProgram 生命周期；发布后并发读无锁。
internal interface ICheckerDerivationCache
{
    // K1 绑定索引（替代 CheckerSymbols.cs:59-73 的每 checker 重建）
    BoundSourceFile? BindingOf(SyntaxNode node);
    BoundSourceFile? BindingOf(SourceFileNode file);

    // K2 全局合并计划（CheckerSymbols.InitializeAsync 重放）
    GlobalMergePlan MergePlan { get; }

    // K3 全局类型解析（GlobalTypes.InitializeAsync 的 12 个命名解析）
    bool TryGetGlobalType(Utf8String name, int arity, out GlobalTypeResolution resolution);

    // K4 共享声明派生投影（形状以 P0 为准，先给最小面）
    bool TryGetMemberProjection(Symbol declaration, out MemberProjection projection);
    void PublishMemberProjection(Symbol declaration, MemberProjection projection);
}

internal readonly record struct GlobalTypeResolution(Symbol Declaration, int Arity, DiagnosticMessage? Error);

// 深不可变：发布后任何 checker 不得修改其内容。
internal readonly record struct MemberProjection(
    IReadOnlyList<(Utf8String Name, Symbol Member, SymbolFlags Flags)> Members,
    IReadOnlyList<(Utf8String Name, Symbol Member)> Exports);

internal sealed class GlobalMergePlan
{
    internal IReadOnlyList<MergeStep> Steps { get; }            // 按 InitializeAsync 既有顺序
    internal IReadOnlyList<Symbol> AmbientModules { get; }
    internal IReadOnlyList<PatternModule> Patterns { get; }
    internal IReadOnlyList<(Utf8String Name, Symbol Symbol)> GlobalExports { get; }
    internal IReadOnlyList<SyntaxNode> AugmentationsBefore { get; }  // 两趟各自的顺序
    internal IReadOnlyList<SyntaxNode> AugmentationsAfter { get; }
    internal IReadOnlyList<(SyntaxNode? Node, DiagnosticMessage Message, Utf8String[] Arguments)> Conflicts { get; }
}

// 挂载点（评审点三，只列接入面，不列实现）：
//   CheckerPool.CreateAsync            → new SharedDerivationCache(program) 一次，传入每个 checker
//   Checker.CreateAsync                → 缓存经 CheckerEnvironment 下发
//   CheckerSymbols 构造                → K1 替换本地字典
//   CheckerSymbols.InitializeAsync     → K2 计划重放（或首 checker 建计划、其余重放）
//   GlobalTypes.InitializeAsync        → K3 查询替代查找
//   StructuredMembers.ResolveAsync 等  → K4 读穿（P0 定型后只接被证实的主项）
```

## 6. 分期与止损

| 期 | 内容 | 产物 | 止损条件 |
| --- | --- | --- | --- |
| P0 | **最重分区内分解探针**：临时 env 闸门 dump 每文件检查时间与共享派生命中（照 r37 §3.5 先例，量后回退） | 最重分区 0.685 s 的构成：文件固有 vs 共享派生；K4 主项定位 | 若最重分区里重复派生占比 <10%，L1 降级为维护项，主力转 L3（分区平衡/单文件） |
| P1-A | K1+K2+K3 落地（构造期共享） | 时间 −≤40 ms、分配 −≤100 MB（c8 口径）；安全面全绿 | 任一 safety 新失败即回退 |
| P1-B | K4 原型（单一键族，读穿 + 单写者预热） | 真实工程配对 + 官方口径配对双测；给出净墙钟 | 净收益 <1.3× 不合并（r37 门槛） |
| P2 | 门禁全量 + 入锚 | 见 §7 | — |

P0 之前不写任何产品代码；P1-A 与 P1-B 各自独立提交、独立回退。

## 7. 门禁与回归面

每期通用：`dotnet build TypeScript.slnx -c Release` 0/0；safety 套件失败集合 ⊆ 基线（重点 `checker-pool-safety`、`checker-program-safety`、`checker-relation-context-safety`）；`perf-verify` 6 夹具逐字节（三方口径）；真实工程配对批次（r38 harness，full + noEmit 两态）；对基线 AB 批次（23 负载）。P1-B 追加：**隔离巨文件批次**（r27 布局敏感先例，任何触碰关系调用链的改动先过它）。收益判定只用同批配对比值，禁跨批绝对时间。

## 8. 风险登记

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | 共享值实为可变（Symbol.MemberTable 惰性填充、links 写入） | 只发布深不可变快照；发布点限定在派生完成处；P0 用探针验证候选载荷的不可变性 |
| R2 | 诊断顺序/去重因共享而变 | 共享值不产生诊断；冲突诊断按 K2 计划分发进各 checker 自有集合；bytecheck + oracle 差分兜底 |
| R3 | 取消/异常路径（CheckerSymbols journal rollback） | 缓存只发布完整值；取消即丢弃，不进缓存 |
| R4 | 布局敏感（r27：同功能改动墙钟 +2.3~3.0%） | 隔离巨文件批次；K4 每次只接一个键族 |
| R5 | 收益不达门槛 | 硬门槛 1.3×；P0 占比 <10% 即降级 |
| R6 | 并发正确性（单写者预热与多 reader 的可见性） | 冻结结构（FrozenDictionary）+ 发布后只读；writer 仅在 warm-up 窗口 |

## 9. 红队反驳（本方案自身的弱点）

1. **规模证伪**：r37 的 ×4.73 复现不出来（今天 ×1.46/×1.67），L1 的线程收益基数小；把 0.632 s 的重复线程量全消掉，摊到 8 个 checker 是每 checker ~79 ms，而最重分区 0.685 s 里重复占比未测，**墙钟收益可能落在 5% 以下**。
2. **靶点可能错位**：c4 与 c8 墙钟持平（1.252 vs 1.295，未配对、噪声带内）说明加 checker 已无边际；真正卡墙钟的是最重分区那一簇重文件。若 P0 显示重复占比低，正确动作是分区平衡/单文件（L3），不是 L1。
3. **历史教训**：本仓库对「消除重复工作」类改动有两次打折前科（r27 池化反噬、r34 弹性修正），且 K4 要碰的正是布局敏感面。
4. **反面证据**：官方 medium 上分区已均衡（各 0.012 s）、checkPool 墙钟仅 13 ms，L1 在该口径几乎无墙钟对象；L1 的价值只存在于「重文件簇 + 多 checker」同时成立的负载（真实工程、DOM 口径夹具）。

**结论性主张**：L1 值得做，但必须先有 P0 的分解数据；在 P0 产出前，任何「预期 −13~17%」的承诺都应视为 r37 的历史读数而非本轮预测。

## 10. 待评审决的问题

1. K4 的载荷形状（成员表/类型引用/导出表，先接哪一个）留到 P0 还是先在评审定一个最小面？
2. 计划重放（K2）采用「首 checker 建计划 + 其余重放」还是「独立单线程预计算阶段」？前者零新增相位，后者多一个相位但确定性更强。
3. K1~K3 是否与 K4 合并为一次原型提交，还是严格按 P1-A/P1-B 分离（本方案倾向分离）？
4. 收益门槛维持 r37 的 1.3×，还是对 Layer A（构造期）单独设更低门槛（它同时省 100 MB 分配）？
