# r35 方案：.NET 11 / C# 15 原生形态重写检查器热路径（2026-10-13）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-13 ｜ 轮次: r35（未开工）｜ 主题: dotnet-native-rewrite
> 触发: 用户指令「重新要充分利用 .NET / C# 的特性，不要拘泥于复刻，要充分利用 .NET 11 和 C# 15 的优点，只要实现同样的功能和 API 即可，达到同样的效果即可。综合分析生成优化方案」
> 关联: `docs/csharp-perf-report-r34.md`、`docs/csharp-perf-report-r34-probes.md`、`docs/csharp-perf-report-r34-rebaseline.md`、`.ai/perf-ledger.md`、`perf-budgets.md`

## 1. 结论摘要

当前形态是「TypeScript（JS）→ Go → C#」的二次翻译，数据模型与 Go 逐字段 1:1（已比对 `internal/checker/types.go` 与 `Checking/Types.cs`），没有按 .NET 的形态建模。本方案停止复刻，用 .NET 11 / C# 15 的原生形态重写检查器热路径，外部行为（CLI、API、逐字节输出）不变，由既有门禁保证。

靶子已用今天的数据锁定：C# 与 Go 的堆增长差 **medium 4.9 倍、huge-file 1.7 倍**，差距集中在类型创建路径（medium 上 62% 的分配在对象字面量上下文族，33 MB / 53.6 MB），正是 Go 用逃逸分析放栈上、C# 全进堆的那部分。全量态 77.6% 的分配是垃圾。

六个工作项分五期，每期一个提交、都过 25 夹具逐字节门禁与 95 flags safety、量一次配对 A/B。前两期低风险（消包装对、小成员表内联），第三期是主攻（字面量形状结构体化，对应用 62% 分配的那条路），后两期是正确性向收尾。

预期区间：medium 分配砍半，按已测的「分配到墙钟弹性」1:9（AOT 三方表口径）约换 3% 墙钟，按 r32 会话内 JIT 口径 1:2 约 12%。**该弹性目前自相矛盾，是动第三期前必须测掉的第一个数**。

## 2. 平台能力清单（已核实，2026-10-13）

| 能力 | 状态 | 对本靶子的意义 |
|---|---|---|
| C# 15 union 类型（`union` 关键字，闭合集合、穷尽模式匹配） | RC 预览中，GA 定 2026-11；本仓 `LangVersion=15.0`，启用需改 `preview` | 适合 checker 内部的和类型返回值（关系查询结果、推断候选），不适合 Type 层次本身（有身份与惰性状态，且 union 运行时是 record struct 包一个 object Value，值类型情形会装箱） |
| C# 15 closed hierarchies（`closed` 修饰符） | 预览 | Type 层次闭合化后 switch 编译期穷尽，JIT 守护去虚拟化；r30 量过该分派链上限 0.3%，价值主要在正确性与重构安全 |
| C# 15 集合表达式参数（`[with(capacity: n), ..src]`） | GA | 一次建数组不建 List，直接消掉 38 处「数组 + ReadOnlyCollection 包装对」 |
| Runtime Async V2（`runtime-async=on`） | 已在用（2026-09-22 起） | 经典异步税实测为串行行 +23.75%，V2 已全量拿走；无新空间 |
| FrozenDictionary | 已在 23 处使用 | 只读全局表（固有类型表、lib 引用表）可扩大使用；检查中构建的可变成员表不适用 |
| `params ReadOnlySpan<T>` / `stackalloc` / 池化缓冲 | GA 多年 | 「栈优先、逃逸再堆」的载体 |

## 3. 重写原则：停止翻译 Go，用 .NET 形态建模

| Go 移植里的形态 | .NET 原生形态 | 依据 |
|---|---|---|
| `map[K]V` 装一切（成员表、实例化缓存） | 小表（<8 项）用内联槽结构体加 span 线性扫描；只读表 FrozenDictionary；大可变表才留 Dictionary | medium 有 5,790 类型 / 20,038 符号，成员表普遍小于 8 项；`new Dictionary<Utf8String, Symbol>(targetProperties.Count, Utf8StringComparer.Ordinal)`（`StructuredMembers.cs:244`）对每个表都付一次字典成本 |
| slice 译为「数组 + ReadOnlyCollection 包装」 | 集合表达式带容量建数组，对外边界包一次 | 全仓 38 处 `Array.AsReadOnly`；每个 StructuredType 带 5 个 list/dict 属性（Members/Properties/Call/Construct/IndexInfos），即每类型多 5 个包装对象，Go 的切片只要一个头 |
| interface 分派遍历类型层次 | `closed` 层次加穷尽 switch | 编译期覆盖检查 + 去虚拟化 |
| 编译器逃逸分析把临时对象放栈上 | 结构体形状 + stackalloc + 池化缓冲，显式做 | medium 上 62% 分配是字面量创建路径的临时对象 |

## 4. 工作项

### W1 集合表达式消包装对（第一期，低风险）

**改动**：38 处 `Array.AsReadOnly(new T[n])` 与 `new List<T>(capacity)` 建表点改为集合表达式 `[with(capacity: n), ..src]` 或直接数组；`IReadOnlyList<T>` 对外属性保留（API 不变），内部构建路径不产包装对象。重点覆盖 `StructuredType` 的五个列表属性与 `Signature` 的 TypeParameters/Parameters。

**依据**：每 StructuredType 5 个包装对象；medium 5,790 类型量级下约数十万包装。

**预期**：目标路径 1.5% 左右字节；墙钟按弹性 1:9 约 0.15%，按 1:2 约 0.75%。低但确定。

**风险**：包装对象若被调用方按引用相等使用会行为变化（门禁的逐字节比对覆盖）。safety 套件中 `checker-program-safety` 钉死的「Create 必须拷贝 arguments」契约不受影响（不碰 Create）。

**门禁**：25 夹具逐字节 + safety + decision 层配对。

### W2 小成员表内联（第一期，低风险）

**改动**：属性数 ≤8 的类型用带内联槽的 `readonly record struct SmallMemberTable`（键 Utf8String 加值 Symbol 的 span 查找）替代 Dictionary；`StructuredMembers` 的构建路径按 `targetProperties.Count` 分流；内联槽存池化缓冲（`ArrayPool<KeyValuePair<Utf8String, Symbol>>`），类型物化时决定是否升级为字典。

**依据**：`StructuredMembers.cs:244` 对每个表新建字典；medium own alloc resolveMembers 0.14 MB（独占）但字典的常驻与查找成本在 inclusive 130 MB（真实工程）里。Go 的 map 在这里同样是慢的，span 扫描对小表双赢。

**预期**：字面量路径成员表分配大幅下降；查找更快（无哈希）。属主攻项的使能器（W3 的结构体形状要挂成员表）。

**风险**：查找语义（序数比较）必须与 `Utf8StringComparer.Ordinal` 逐字节一致，包括重复键行为；门禁覆盖。

### W3 字面量形状结构体化（第二期，主攻，最高风险）

**改动**：对象字面量检查先构造栈上的 `readonly record struct LiteralShape`（属性名 `ReadOnlySpan<Utf8String>` 加属性类型 `ReadOnlySpan<Type>`，容量 ≤16 走内联、更大走池化），直接对上下文类型做结构检查；仅当形状逃逸（被更宽类型引用、进类型缓存、进联合）才物化为完整 ObjectType（现状每条字面量都物化）。入口是 `ObjectLiterals.CreateAsync` 与 `ExpressionContexts` 的 contextual 查询链。

**依据**：medium 探针 62% 分配在该路径（objectLiteral 9.4 + objectMutable 7.7 + objectProperty 6.5 + propertyInit 5.3 + checkExpr 4.2 MB，inclusive）；own alloc objectLiteral 1.63 MB、objectType 0.96 MB。Go 的逃逸分析在这里把临时类型放栈上，这是 4.9 倍差距的主要来源。

**预期**：该路径分配砍 50% 以上，即 medium 总分配 −30% 上下。按弹性 1:9 约 3% 墙钟，按 1:2 约 12%。

**风险**：动 checker 核心路径，改 AOT 布局的概率高（r27 先例：−4.3 MB 分配换 +2.3% 墙钟）。**必须单独过隔离巨文件批次**；形状逃逸判定漏一类就是字节不一致（门禁会抓，返工成本高）。

**前置**：弹性测量完成（§5）；W2 已落地。

### W4 Type 层次 closed 化与 union 返回值（第三期，正确性向）

**改动**：`Type` 及全部子类加 `closed`（派生限制在本程序集，已是事实）；checker 的 `is X x` 判断链改写为穷尽 switch；关系查询结果、推断候选等「class 加 null 表达无结果」的返回值改 C# 15 union（需 `LangVersion=preview`）。

**依据**：r30 实测类型链分派上限 0.3%（墙钟意义小）；union 的运行时是 record struct 包 object Value，引用类型情形不加箱，适合这些和类型。

**预期**：墙钟 <0.5%；收益是编译期穷尽性（消灭 default 分支漏判）与后续重构安全。

**风险**：`LangVersion=preview` 会让其他预览特性可被误用，需在 `.editorconfig` 加白名单约束；union 是 RC 预览特性，GA（2026-11）前语法可能微调。

### W5 只读全局表 FrozenDictionary 化（第三期，低风险）

**改动**：固有类型表、lib 引用表、全局符号缓存等程序构建后不再变的表改 FrozenDictionary（现 23 处已用，扩大到全局面）。

**依据**：这些表现在是 Dictionary，查找走完整哈希；FrozenDictionary 的优化探测对只读表更快。

**预期**：查找路径小头；墙钟 <0.5%。

**风险**：表若在长会话（watch/LSP）中被写会抛；需逐表确认构建后只读（watch 形态要单独验证）。

### W6 递归栈池化（第一期搭车，低风险）

**改动**：`TypeConstraints.cs:215` 的 `new RecursionIdentity[stack.Count + 1]` 加手工拷贝循环改为池化栈（单个可增长缓冲加深度游标，或 `ArrayPool` 租借）。该站点在约束解析递归每层分配一个新数组。

**依据**：今天读码确认的按层分配点；`RecursionIdentity` 已是 readonly record struct（值类型，无逐项堆分配）。

**预期**：约束解析路径零数组分配；真实工程 constraint 相关分配的一小块。

**风险**：池化缓冲的并发安全（多 checker 并行）；按 checker 实例持有即可。

## 5. 必须先测的数：分配到墙钟弹性

r32 会话内 JIT 前后口径读作 **1:2**（−22.4% 分配换 −11.0% 墙钟），AOT 三方表口径读作 **1:9**（−20.4% 分配换 x1.428→x1.397），r34 的纯分配改动（−0.34%）墙钟纹丝不动。四倍分歧决定 W3 的期望值是 3% 还是 12%。

**测法**：找一对只有分配差、差得大的产物，同批配对。最干净的候选是「当前产物」对「关掉成员表缓存的变体」（一次性 worktree 改一行构建），分配差应在 20% 以上；同批 15 对量墙钟。若弹性 ≥1:4，W3 的期望进入两位数，值得全力做；若 ≤1:9，W3 期望 3%，需与布局回归风险重新权衡。

## 6. 分期与止损

| 期 | 内容 | 累计预期（弹性 1:9 / 1:2） | 止损条件 |
| --- | --- | --- | --- |
| 0 | 弹性测量 + W1 + W6 | 0.2% / 1% | 弹性 ≤1:9 则 W3 降级为可选 |
| 1 | W2 小成员表内联 | 0.5% / 2.5% | 巨文件批次出现 >1% 反向即停 |
| 2 | W3 字面量形状结构体化 | 3% / 12% | 隔离巨文件批次反向即整期回退（r27 模式） |
| 3 | W4 + W5 | 3.5% / 12.5% | union 语法在 GA 前变动则 W4 推迟到 GA 后 |

每期提交信息带该期的配对数据；任一期门禁红（字节不一致或 safety 新失败）当期回退，不带病进下一期。

## 7. 验收标准

1. 全部期次完成后：25 夹具逐字节全过、safety 95 flags 失败集合 ⊆ 已知基线、Release 0/0。
2. 分配：真实工程全量态较 r34 的 1,001.7 MB 下降 ≥25%（W1+W2+W3 的合计预期）。
3. 墙钟：decision 层 7 行配对，medium 行比值 CI 上界 <0.97（即至少 −3% 且显著）。
4. 对 Go 站位：重负载 11 项均值从 x1.396 收窄到 x1.36 以内（第三期弹性 1:9 口径的达成线）。

## 8. 与账目的关系

- 本方案是 ledger 表2「AST 结构体 arena 重写」与「同步化重写」两行否决理由的**替代路径**：不手写 arena（无生命周期分析负担），用平台特性拿同样的东西；同步化已由 Runtime Async V2 解决，不在本方案内。
- 表1 将新增：集合表达式消包装、小成员表 span 查找、字面量形状结构体、Type 层次 closed、全局表 FrozenDictionary、约束递归栈池化六项（按期次落地后登记）。
- perf-budgets §2 分配锚点（1,001.7 MB / ≤1,050 MB）在本方案达成后按 §7.2 重设；墙钟锚点（x1.396~x1.423）按 §7.4 重设。
- 明确不做（延续表2）：手写 arena 与自定义分配器、全量结构体化类型图（W3 只结构体化字面量形状这一层）、同步化重写、GC 配置面调整。
