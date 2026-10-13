# r35 方案：.NET 11 / C# 15 原生形态重写检查器热路径（2026-10-13）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-13 ｜ 轮次: r35（未开工）｜ 主题: dotnet-native-rewrite ｜ 版本: v2
> **v2 修订**（同日源码核实）：①W2 由新造 `SmallMemberTable` 结构体改为复用仓内 `Binding.SymbolTable` 既有形态；②W1 计数修正（38→55，手写源码口径）且「每类型 5 包装」的说法按源码改正；③W3 补字面量路径逐站点分配普查（闭包、每属性双对象、临时字典）；④C# 15 特性细节按 Microsoft Learn 官方页逐条复核（closed 隐式 abstract、穷尽性不传递、union 运行时类型版本）；⑤弹性测量补 r32 归因风险。
> 触发: 用户指令「重新要充分利用 .NET / C# 的特性，不要拘泥于复刻，要充分利用 .NET 11 和 C# 15 的优点，只要实现同样的功能和 API 即可，达到同样的效果即可。综合分析生成优化方案」
> 关联: `docs/csharp-perf-report-r34.md`、`docs/csharp-perf-report-r34-probes.md`、`docs/csharp-perf-report-r34-rebaseline.md`、`.ai/perf-ledger.md`、`perf-budgets.md`

## 1. 结论摘要

当前形态是「TypeScript（JS）→ Go → C#」的二次翻译，检查器侧的数据模型与 Go 逐字段 1:1，没有按 .NET 的形态建模。本方案停止复刻，用 .NET 11 / C# 15 的原生形态重写检查器热路径。**API 兼容包络只有三样：CLI 行为、公开类型签名、逐字节产物**；内部形态全自由，由既有门禁（25 夹具 bytecheck + 95 flags safety + Release 0/0）保证。

复刻残留不是全仓均匀分布。文本层（`Utf8String` readonly struct）、绑定层符号表（`SymbolTable` 内联小表）、符号声明序列（`SymbolDeclarations` 内联单例）三块**已是 .NET 原生形态**；残留集中在检查器侧三处：数组+包装对、Dictionary 成员表加 ReadOnlyDictionary 包装、对象字面量全量物化。方案按此收敛为六个工作项。

靶子已用今天的数据锁定：C# 与 Go 的堆增长差 **medium 4.9 倍、huge-file 1.7 倍**，差距集中在类型创建路径（medium 上 62% 的分配在对象字面量上下文族，33 MB / 53.6 MB）；全量态 77.6% 的分配是垃圾，但 GC 通道上限已被 no-GC region 实验定价为墙钟 −0.9%——本方案赚的是**每操作 CPU 与对象数**，不是 GC。

六个工作项分四期，每期一个提交、都过 25 夹具逐字节门禁与 95 flags safety、量一次配对 A/B。前两期低风险（消包装对、成员表统一到仓内既有小表形态），第三期是主攻（字面量形状结构体化，对应用 62% 分配的那条路），第四期是正确性向收尾。

预期区间：medium 分配砍半，按已测的「分配到墙钟弹性」1:9（AOT 三方表口径）约换 3% 墙钟，按 r32 会话内 JIT 口径 1:2 约 12%。**该弹性目前自相矛盾，是动第三期前必须测掉的第一个数**（§5）。

## 2. 平台能力清单（已核实，2026-10-13；v2 按 Microsoft Learn 官方页复核）

| 能力 | 状态 | 对本靶子的意义 |
|---|---|---|
| C# 15 集合表达式参数 | C# 15 特性（官方语法 `[with(capacity: values.Length * 2), .. values]`，亦可传比较器）；本仓 `LangVersion=15.0`（`Directory.Build.props`）可用 | 一次建表不建中间 List；消掉「数组 + 包装对」家族的构建侧形态 |
| C# 15 union 类型（`union` 关键字，闭合集合、穷尽匹配） | preview 特性，启用需 `preview`；运行时 `UnionAttribute`/`IUnion` 自 .NET 11 Preview 5；C# 15 整体当前为 preview，随 .NET 11 GA | 适合 checker 内部的和类型返回值（关系查询结果、推断候选），不适合 Type 层次本身（有身份与惰性状态，且 union 运行时是 record struct 包一个 object Value，值类型情形会装箱） |
| C# 15 closed 层次（`closed` 修饰符） | preview；**closed 类隐式 abstract**、不可与 sealed/static 组合；派生限制不传递——中间层不 closed 则穷尽性止于该层 | Type 层次闭合化后 switch 编译期穷尽；需整链加（Type→ConstrainedType→StructuredType→ObjectType→TypeReference→InterfaceType→各叶子，共 ~15 类）。r30 量过该分派链上限 0.3%，价值主要在正确性与重构安全 |
| Runtime Async V2（`runtime-async=on`） | 已在用（2026-09-22 起，`Directory.Build.props`） | 经典异步税实测为串行行 +23.75%，V2 已全量拿走；无新空间 |
| FrozenDictionary | 已在 23 处使用 | 只读全局表可扩大使用；检查中构建的可变成员表不适用 |
| `params ReadOnlySpan<T>` / `stackalloc` / 池化缓冲 / `CollectionsMarshal` | GA 多年（`GetValueRefOrAddDefault` 已用于 SymbolTable） | 「栈优先、逃逸再堆」的载体 |
| 仓内既有原生形态 | `Text/Utf8String.cs`（readonly struct + ReadOnlyMemory 视图）、`Binding/SymbolTable.cs`（≤8 项 Entry[] 内联线性扫描、超出升字典，注释明说参照 Go runtime small map）、`Binding/SymbolDeclarations.cs`（单声明内联 struct） | **W2 的载体：不新造类型，把 checker 侧成员表统一到 SymbolTable**。注意 async 方法不能收 span 参数，span/栈化只落在同步核心与构建循环 |

## 3. 重写原则：停止翻译 Go，用 .NET 形态建模

| Go 移植里的形态 | .NET 原生形态 | 依据（源码落点） |
|---|---|---|
| slice 译为「数组 + ReadOnlyCollection 包装」 | 数组本身就是 IReadOnlyList，直接返回数组 | 全仓 58 处 `Array.AsReadOnly`（手写源码 55 处 + 生成文件 3 处）；旗舰证据：`Types.cs:201-202` `UnionOrIntersectionType` 同时存 `types` 数组与 `Array.AsReadOnly` 包装，而 `TypesSpan` 已把裸数组的 span 暴露给内部——包装纯多余。`TypeAlias`、`TemplateLiteralType`、`IndexInfo.Components` 同型 |
| `map[K]V` 装成员表 + 对外交 `AsReadOnly()` 视图 | 仓内 `SymbolTable`：小表内联槽、大表升字典、自身实现 IReadOnlyDictionary（无包装） | `StructuredMembers.cs:188/244` 每表 Dictionary + `owned.AsReadOnly()`（`ObjectAsync`/`AnonymousAsync`）；`ObjectLiterals.cs:81` 每字面量 `new Dictionary`；`ObjectSpreads.GetAsync` 每次合并再建 Dictionary+HashSet |
| interface 分派遍历类型层次 | `closed` 整链 + 穷尽 switch | 编译期覆盖检查 + 去虚拟化（r30 定价 ≤0.3%，正确性为主） |
| 编译器逃逸分析把临时对象放栈上 | 结构体形状 + stackalloc + 池化缓冲，显式做 | medium 上 62% 分配在字面量创建路径家族；Go 侧机制归因（逃逸分析放栈）为 [推断]，未读 Go 源码核实 |

包装对的真实规模（v2 修正）：v1 的「每 StructuredType 5 个包装对象」不成立——`Properties` 在 `SetCoreAsync` 直填裸数组（`StructuredMembers.cs:407-410`），三个列表属性空态默认 `[]`。包装集中在：Members 的 ReadOnlyDictionary 包装（每张物化表一次）、基类合并索引的 `merged.AsReadOnly()`、联合/交集的数组+包装对、以及 55 处散点。量级以 membersTable 探针族（真实工程 own alloc 9.9 MB）与 union 创建频次计，目标路径 1.5% 字节量级的判断维持。

## 4. 工作项

### W1 消包装对与集合表达式建表（第一期，低风险）

**改动**：55 处手写 `Array.AsReadOnly`（生成文件 3 处不动）改为直接数组或集合表达式 `[with(capacity: n), ..src]`；`IReadOnlyList<T>` 对外属性保留（数组实现该接口，API 不变）。重点落点：`UnionOrIntersectionType.Types`（删包装、`TypesSpan` 并轨）、`TypeAlias`/`TemplateLiteralType`/`IndexInfo.Components`、`StructuredMembers` 的 `merged.AsReadOnly()` 与 `InstantiateSignatures/Indexes` 返回值。**附带同族清理**：`algebra.UnionAsync`/`IntersectionAsync`/`CheckCrossProduct` 增加二元快速重载，消掉调用方为传 `[left, right]` 建的数组（`ObjectSpreads.cs` 多处）；`ExpressionContexts.ElementAsync` 展开路径的 `Reverse().TakeWhile().Count()` LINQ 残留改手写倒扫（`ExpressionContexts.cs:328`）。

**依据**：§3 的源码落点；union 创建走 `UnionAsync` 高频路径，每联一次双分配（数组+包装）。

**预期**：目标路径 1.5% 左右字节；墙钟按弹性 1:9 约 0.15%，按 1:2 约 0.75%。低但确定。

**风险**：包装对象若被调用方按引用相等使用会行为变化（门禁逐字节比对覆盖）；数组暴露后内部调用方若向下转型改写会引入别名 bug（grep 全仓 `(Symbol[]` / `(Type[]` 转型点随改随查）。safety 套件钉死的「Create 必须拷贝 arguments」契约不涉及（不碰 Create）。

**门禁**：25 夹具逐字节 + safety + decision 层配对。

### W2 checker 成员表统一到仓内 SymbolTable（第一期，v2 重构）

**改动**：`StructuredMembers` 全部建表点（`ObjectAsync` 的 `owned`、`InstantiateTableAsync`、`AnonymousAsync` 目标表 `StructuredMembers.cs:244`）、`ObjectLiterals` 每字面量的 `table`、`ObjectSpreads.GetAsync` 的 `members`/`skipped`，从 `Dictionary<Utf8String, Symbol>` + `AsReadOnly()` 改为 `Binding.SymbolTable`。`StructuredType.Members` 属性类型不变（`IReadOnlyDictionary`），只换底层实例。`SymbolTable` 需补一个从 `IReadOnlyDictionary` 拷贝的构造重载。

**依据**：内联小表形态已在绑定层全量验证（≤8 项 Entry[] 线性扫描、`GetValueRefOrAddDefault` ref 路径、序数语义与 `Utf8StringComparer.Ordinal` 等价——`Utf8String` 的 `==` 即 SequenceEqual）；checker 侧对 `Members` **无任何 `(Dictionary<Utf8String` 向下转型**（grep 核实），换底层实例 API 安全；medium 有 5,790 类型 / 20,038 符号，成员表普遍小于 8 项。懒惰阶梯：仓内已有该形态，不新造 `SmallMemberTable`。

**预期**：每张小表省「字典桶组 + ReadOnlyDictionary 包装」两笔分配；小表查找免哈希、顺序内存。属 W3 的使能器（字面量形状的成员挂载点）。

**风险**：`SymbolTable` 的可变入口（ref 增改）要覆盖 `Inherit` 直改 `owned` 的用法；升字典阈值沿用现行 8，`AnonymousAsync` 的 `new(members, Utf8StringComparer.Ordinal)` 拷贝语义要对齐（重复键时后者保留后者）。门禁覆盖。

### W3 字面量形状结构体化（第二期，主攻，最高风险）

**改动**：对象字面量检查先构造栈上的 `readonly record struct LiteralShape`（属性名 `ReadOnlySpan<Utf8String>` 加属性类型 `ReadOnlySpan<Type>`，容量 ≤16 走内联、更大走池化），直接对上下文类型做结构检查；仅当形状逃逸（被更宽类型引用、进类型缓存、进联合）才物化为完整 ObjectType。入口 `ObjectLiterals.CreateAsync` 与 `ExpressionContexts` 的 contextual 查询链。

**逐站点分配普查（v2 补，`ObjectLiterals.cs` 行号）**：

| 站点 | 每次开销 |
| --- | --- |
| `CheckCoreAsync` 的 `contexts.CachedAsync(node, async () => …)` 闭包（捕获 ~10 个局部，`:75`） | 显示类 + 委托，每字面量 2 对象 |
| `GrammarAsync` 的 `seen` 字典（`:417`） | 每字面量 1 字典 |
| 每属性 `new Symbol` + `links.Values.Get(property)`（`:115`/`:118`） | 每属性 2 对象（transient Symbol + LinkStore 数据） |
| `property.DeclarationList.AddRange`（`:140`） | 声明序列增长重分配 |
| `table = new Dictionary`（`:81`，W2 已换成 SymbolTable） | 每字面量 1 表 |
| `spreads.ObjectAsync` 物化完整 ObjectType（`:279`） | 类型对象 + 成员表 + 五属性 |

**依据**：medium 探针 62% 分配在该路径（objectLiteral 9.4 + objectMutable 7.7 + objectProperty 6.5 + propertyInit 5.3 + checkExpr 4.2 MB，inclusive）；own alloc objectLiteral 1.63 MB、objectType 0.96 MB。4.9 倍堆增长差指向这里。「Go 靠逃逸分析免掉这部分」为 [推断]。

**预期**：该路径分配砍 50% 以上，即 medium 总分配 −30% 上下。按弹性 1:9 约 3% 墙钟，按 1:2 约 12%。

**风险**：动 checker 核心路径，改 AOT 布局的概率高（r27 先例：−4.3 MB 分配换 +2.3% 墙钟）。**必须单独过隔离巨文件批次**；形状逃逸判定漏一类就是字节不一致（门禁会抓，返工成本高）。闭包显示类是 async 状态机的捕获载体，消它需把逐属性循环提为显式状态（池化状态对象租还，仿 `RentLists` 模式），并发重入靠 LIFO 栈保证——实现复杂度计入本项。

**前置**：弹性测量完成（§5）；W2 已落地。

### W4 Type 层次 closed 化与 union 返回值（第三期，正确性向）

**改动**：`Type` 整链 ~15 个类加 `closed`（v2 核实：closed 隐式 abstract，`Type` 已是 abstract 无冲突；穷尽性不传递，中间层全部要加）；checker 的 `is X x` 判断链改写为穷尽 switch；关系查询结果、推断候选等「class 加 null 表达无结果」的返回值改 C# 15 union（需 `LangVersion=preview`）。

**依据**：r30 实测类型链分派上限 0.3%（墙钟意义小）；union 的运行时是 record struct 包 object Value，引用类型情形不加箱，适合这些和类型。

**预期**：墙钟 <0.5%；收益是编译期穷尽性（消灭 default 分支漏判）与后续重构安全。

**风险**：`LangVersion=preview` 会让其他预览特性可被误用，需在 `.editorconfig` 加白名单约束；union 是 preview 特性且运行时类型（UnionAttribute/IUnion）自 .NET 11 Preview 5 才有，GA 前语法可能微调——**若 GA 前语法变动则推迟到 GA 后**。

### W5 只读全局表 FrozenDictionary 化（第三期，低风险）

**改动**：固有类型表、lib 引用表、全局符号缓存等程序构建后不再变的表改 FrozenDictionary（现 23 处已用，扩大到全局面）。

**依据**：这些表现在是 Dictionary，查找走完整哈希；FrozenDictionary 的优化探测对只读表更快。

**预期**：查找路径小头；墙钟 <0.5%。

**风险**：表若在长会话（watch/LSP）中被写会抛；需逐表确认构建后只读（watch 形态要单独验证）。

### W6 递归栈池化（第一期搭车，低风险）

**改动**：`TypeConstraints.cs:215` 的 `new RecursionIdentity[stack.Count + 1]` 加手工拷贝循环改为池化栈（单个可增长缓冲加深度游标，或 `ArrayPool` 租借），按 checker 实例持有保证并发安全。该站点在约束解析递归每层分配一个新数组。

**依据**：本轮读码确认（v2 维持）；`RecursionIdentity` 已是 readonly record struct，缓冲内容是纯值拷贝。

**预期**：约束解析路径零数组分配；真实工程 constraint 相关分配的一小块。

**风险**：池化缓冲与异常展开路径的交互（游标回退必须在 finally）；r27 `RentLists` 的「租时清、异常自愈」模式照搬。

## 5. 必须先测的数：分配到墙钟弹性

r32 会话内 JIT 前后口径读作 **1:2**（−22.4% 分配换 −11.0% 墙钟），AOT 三方表口径读作 **1:9**（−20.4% 分配换 x1.428→x1.397），r34 的纯分配改动（−0.34%）墙钟纹丝不动。四倍分歧决定 W3 的期望值是 3% 还是 12%。

**v2 补归因风险**：r32 的 −11% 墙钟不是纯分配改动的读数——E1（行首 O(1) 判定）、E3（Utf16Length 向量化）是纯 CPU 优化，与分配削减同批落地，1:2 口径把 CPU 收益错记到了分配头上，方向上高估弹性。1:9 与 1:2 的差也可能部分是 JIT 与 AOT 对分配敏感度本身不同（AOT 无分层编译，热身权重不同）。

**测法**：找一对只有分配差、差得大的产物，同批配对。最干净的候选是「当前产物」对「关掉成员表缓存的变体」（一次性 worktree 改一行构建），分配差应在 20% 以上；同批 15 对量墙钟，**同对在 AOT 与 JIT 双形态各读一遍**（分离运行时敏感度）。若弹性 ≥1:4，W3 的期望进入两位数，值得全力做；若 ≤1:9，W3 期望 3%，需与布局回归风险重新权衡（r34 探针已把 GC 通道定价 −0.9%，W3 的赌注全在每操作 CPU 与对象数通道）。

## 6. 分期与止损

| 期 | 内容 | 累计预期（弹性 1:9 / 1:2） | 止损条件 |
| --- | --- | --- | --- |
| 0 | 弹性测量 + W1 + W6 | 0.2% / 1% | 弹性 ≤1:9 则 W3 降级为可选 |
| 1 | W2 成员表统一 SymbolTable | 0.5% / 2.5% | 巨文件批次出现 >1% 反向即停 |
| 2 | W3 字面量形状结构体化 | 3% / 12% | 隔离巨文件批次反向即整期回退（r27 模式） |
| 3 | W4 + W5 | 3.5% / 12.5% | union 语法在 GA 前变动则 W4 推迟到 GA 后 |

每期提交信息带该期的配对数据；任一期门禁红（字节不一致或 safety 新失败）当期回退，不带病进下一期。

## 7. 验收标准

1. 全部期次完成后：25 夹具逐字节全过、safety 95 flags 失败集合 ⊆ 已知基线、Release 0/0。
2. 分配：真实工程全量态较 r34 的 1,001.7 MB 下降 ≥25%（W1+W2+W3 的合计预期）。
3. 墙钟：decision 层 7 行配对，medium 行比值 CI 上界 <0.97（即至少 −3% 且显著）。
4. 对 Go 站位：重负载 11 项均值从 x1.396 收窄到 x1.36 以内（第三期弹性 1:9 口径的达成线）。

## 8. 与账目的关系

- 本方案是 ledger 表2「AST 结构体 arena 重写」与「同步化重写」两行否决理由的**替代路径**：不手写 arena（无生命周期分析负担），用平台特性拿同样的东西；同步化已由 Runtime Async V2 解决，不在本方案内。r34 探针对「类型/签名结构体化」的否决（GC 通道 −0.9% 上限）不覆盖 W3 的主张——W3 赌的是对象数与每操作 CPU 通道，该通道的弹性正是 §5 要测的数。
- 表1 将新增：集合表达式消包装、成员表统一 SymbolTable、字面量形状结构体、Type 层次 closed、全局表 FrozenDictionary、约束递归栈池化六项（按期次落地后登记）。
- perf-budgets §2 分配锚点（1,001.7 MB / ≤1,050 MB）在本方案达成后按 §7.2 重设；墙钟锚点（x1.396~x1.423）按 §7.4 重设。
- 明确不做（延续表2）：手写 arena 与自定义分配器、全量结构体化类型图（W3 只结构体化字面量形状这一层）、同步化重写、GC 配置面调整。
