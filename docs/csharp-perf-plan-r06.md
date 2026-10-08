# C# 编译器极致优化方案 v6（r06）：按方法级归因重排的发射/检查改造 + 单文件分段并行

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-08 ｜ 轮次: r06 ｜ 主题: method-level-attribution-and-emit-restructure
> 涉及 git 节点: `1fb3d194f6`（r05c 报告）/ 本轮工作树改动（两项已实测落地，见 §0.6）
> 数据来源: `bench/AB51`~`AB53`（r05c 三方对比，工作区 `C:\ai\projects\tsbench`）+ 本轮新测（方法级归因探针、夹具分解、emit 两遍构成、分配按类型 trace）
> 前序: `docs/csharp-perf-plan-r05.md`（P0 已落地为流水线形态，见 `docs/csharp-perf-report-r05.md` 与 `docs/csharp-perf-report-r05-comparison.md`）

---

## 0. 本轮新证据（全部本轮实测；口径与偏差已标注）

### 0.1 阶段分配（权威口径，编译器自报）

| 阶段 | r05c AOT（产品形态） | CoreCLR 诊断构建 | 说明 |
| --- | ---: | ---: | --- |
| Parse | 41.4 MB | 42.1 MB | |
| Bind | 20.6 MB | 20.9 MB | |
| **Check** | **179.8 MB** | **183.2 MB** | 诊断构建高 1.9%，形状一致 |
| **Emit** | **268.9 MB** | **258.7 MB** | 差异来自 JIT/委托分配路径 |
| 合计 | 513.4 MB | 511.2 MB | ±2% |

CoreCLR 诊断构建的重复运行偏差 **≤ 0.03 MB**（三次同二进制实测 508.42/508.44/508.48 MB）→ **分配量级 A/B 单样本即可判定**；墙钟时间仍必须 15 组配对。

### 0.2 检查阶段：方法级归因（本轮新增探针，见附录 A）

巨文件夹具，check = 183.2 MB（CoreCLR），帧为**包含式**（嵌套帧互相包含，不可相加）：

| 探针帧 | MB | 占 check | 读法 |
| --- | ---: | ---: | --- |
| **objectLiteral（对象字面量检查整体）** | **100.8** | **55.0%** | 上限；含其内部的成员表/关系工作 |
| — objectProperty（属性循环） | 69.2 | 37.8% | 16,384 个字面量 → **4.2 KB/个** |
| — objectType（fresh 类型 + 成员表构造） | 7.4 | 4.0% | 只有 0.45 KB/个 |
| symbolTypesGet（符号→类型） | 28.2 | 15.4% | 跨调用点累计（嵌套） |
| relationRelated（可赋值性判定） | 21.5 | 11.7% | 顶层：初始化器 → 声明类型 |
| typeFromNode（类型节点→类型） | 20.3 | 11.1% | 注解路径 |
| — typeLiteral（其中 `{…}` 分支） | 20.0 | 10.9% | 每个注解 1.2 KB |
| membersTable（`MembersAsync`） | 17.5 | 9.5% | 小表（2 成员）却 548 B/次 |
| variableType（变量类型解析） | 15.8 | 8.6% | |
| resolveMembers / setMembers | 11.9 / 11.7 | 6.5 / 6.4% | 成员表解析与落地 |
| LinkStore 创建次数 | **180,339 个** | — | `ValueSymbolLinks`（8.9 MB）等 |

结论：**检查阶段的分配集中在"对象字面量 + 符号/链接/成员表"这条管线**（`objectLiteral` 单项过半），而不是关系缓存（`relationCompare` 11.7 MB，`RelationKey` 已是结构体扁平字典，无嵌套字典浪费）。

### 0.3 发射阶段：两遍构成（编译器自报，CoreCLR）

| 运行配置 | Emit 分配 | AOT 墙钟（巨文件） |
| --- | ---: | ---: |
| 两遍（JS + 声明，r05c 流水线） | **258.7 MB** | **0.617 s** |
| 仅 JS（`--declaration false`） | 106.0 MB | 0.425 s |
| 仅声明（`--emitDeclarationOnly`） | **152.7 MB** | 0.325 s |
| 相加 | 258.7 MB（**完全可加**） | 0.750 s（流水线重叠省 0.133 s） |

**声明侧占 emit 的 59% 分配、53% 时间**；r05 的 P0 流水线已把可重叠部分拿走（0.750 → 0.617 s），剩余 0.617 s 是串行的"两遍各自的工作量"。

> 方法论修正：本轮先用 `dotnet-trace` 做类型级差分，得到"声明侧 ≈ 151.6 MB、两遍不可加（74 + 30.6 ≠ 182）"的结论，随后用**编译器自报计数器**复核，发现可加性完好（106.0 + 152.7 = 258.7）→ 之前的"超可加"是 trace 侧的采样/开销伪影。**类型级 trace 只能看构成比例，不能当配额。**

### 0.4 分配按类型（dotnet-trace，CoreCLR，指示性）

巨文件全量 510 MB：

| 类型 | MB | 归属 |
| --- | ---: | --- |
| `Part[]`（打印机工作项数组） | **62.4** | 打印（JS 22.8 + 声明 30.4） |
| `System.Byte[]` | 25.0 | 写出缓冲 / Utf8String 拼接 |
| `SyntaxNode[]` + `NodeList` | 24.7 | 变换期节点重建、子节点容器 |
| `Entry[SyntaxNode,bool][]` | 17.0 | `Checker.DeclarationVisibility` 等大字典扩容 |
| `Symbol` | 15.3 | 检查期符号（含每属性字面量瞬态符号） |
| `<>c__DisplayClass*`（各类闭包） | ~40 | 变换与检查的闭包 |
| `Func<Type,ValueTask<Type>>` | 9.9 | `MapAsync` 调用点的委托（≈31 万次） |
| `ValueSymbolLinks` + 其字典 Entry[] | 16.4 | 每符号链接 |
| `Type[]` / `List<Type>` / `Stack<Type>` / `ValueTuple<Type,int>[]` | ~28 | 类型映射/实例化工作列表 |
| `Comparison<Symbol>` | 3.3 | `List.Sort(方法组)` 的委托（≈11 万次）→ **本轮已消除** |
| `Payload`（Part 的稀有引用包） | 6.9 | 打印 |
| `NodeData`（每语句 1 个） | 4.1 | EmitContext 元数据（16,384 个） |

**一处命名异常（登记为待查）**：trace 中 `List<SyntheticComment>` 12.6~17.5 MB，但本轮加入的无条件计数器证明 `EmitContext.Add/SetLeadingComments/Add/SetTrailingComments` **调用次数为 0**（`Raw comment adds = 0`）→ trace 的 TypeID→名称映射对个别行不可靠。该项不计入任何改造预算，下一轮用 GC 堆/分配栈复核。

### 0.5 夹具分解（定位"哪一部分贵"）

| 变体（各 16,384 行） | Check 分配 | Types | 读法 |
| --- | ---: | ---: | --- |
| 基准：`export const v: {c:number;t:string} = {…}` | 179.8 MB | 82,350 | |
| 仅注解（`export declare const v: {…}`） | 47.9 MB | 16,810 | 注解类型字面量 ≈ **2.9 KB/个** |
| 仅字面量（无注解） | 100.2 MB | 131,506 | 无注解时类型数反而 ×1.6 |
| 共享接口注解（`v: Item`） | 148.4 MB | 49,584 | 注解匿名化 +31.9 MB |

### 0.6 本轮已落地的两项（已验证，含字节一致门禁）

| 项 | 改动 | 分配效果（巨文件，CoreCLR） | 输出 |
| --- | --- | --- | --- |
| **A 注释扫描门控** | `SyntaxPrinter` 的 `LeadingComments/TrailingComments/ListComments/DetachedComments/WillEmitLeadingNewLine` 在 `sourceHasComments == false` 时直接返回（源文件无 `//`、`/*` 时 `CommentRanges` 必为空，语义等价） | **Emit 271.3 → 258.7 MB（−12.6 MB，−4.6%）** | 字节一致 |
| **B 成员表排序走接口** | `declared.Sort(order)`（`TypeOrder : IComparer<Symbol>`）替代 `.Sort(order.CompareSymbols)`，消除每次排序的 `Comparison<Symbol>` 委托与 `Comparer` 包装 | **Check 183.2 → 180.4 MB（−2.8 MB，−1.5%）** | 字节一致 |
| 合计 | | **总分配 523.8 → 508.4 MB（−2.9%）** | 5 个负载 × 1,223 个产物文件逐字节一致（vs r05c 未改动 AOT 产物） |

安全套件：本轮实跑 19 个有效套件（另有 1 个旗标名不存在、未计入），**18 通过**；`program-emit-safety` 在**未改动基线上同样失败**（同为 `Program emit assertion 14`，已用 `git stash` 回调基线实测确认）。

---

## 1. 目标（按"墙钟收益 / 风险"排序，不看分配大小排序）

| 优先级 | 目标 | 现状（巨文件） | 目标 | 依据 |
| --- | --- | --- | --- | --- |
| **P0** | 单文件分段并行打印 | emit 0.617 s（3.68× Go） | 0.30–0.40 s | 单文件并行度=1；打印是每部件独立工作；机器 32 线程 |
| **P1** | 声明发射的"重建"消除 | 声明侧 152.7 MB / 0.325 s | 分配 −40%，时间 −20% | 声明侧 = emit 的 59% 分配 |
| **P2** | 检查阶段对象字面量管线 | check 0.320 s / 179.8 MB，其中 objectLiteral 100.8 MB | check 分配 −20%，时间 −10% | §0.2 |
| **P3** | 打印容器（Part/Payload）与分派 | `Part[]` 62.4 MB、`Payload` 6.9 MB | −40% | §0.4、r05 P3 |
| **P4** | parse/bind | 1.53× / 1.79×（+46 ms） | −20% | 绝对量小，最后做 |
| P5 | 启动地板 | 93% 在 Main 前 | **不投入** | r04 已证；只做记录 |

**排序理由（与 r05 的差异）**：r04/r05 的经验是"分配降 46.7% 而墙钟比值只从 3.23 降到 3.1"→ **分配的边际墙钟收益在巨文件上已递减**。因此 r06 把"减少工作量与并行度"放在首位，把分配削减放在第二层（主因是它同时降低 GC 与 RSS，且是确定性指标，便于门禁）。

---

## 2. P0：单文件分段并行打印（最高杠杆）

### 2.1 依据

1. emit 是与 Go 差距的最大单项（r05c：巨文件 0.658 s vs Go 0.179 s，3.68×；占总差距的 62%）。
2. `huge-file` 是**单个 1.6 MB 文件**：文件级并行（r03 已实现）在该负载上并行度为 1。
3. 两遍（JS/声明）已可加且互不依赖——**这是分段也可加的已知前提**（r05 报告 §2.1 实测 0.347 + 0.289 ≈ 0.651）。
4. 打印器已是"每文件单实例状态"：`pending`/`states`/`statePool`/`partListPool`/`writer`/`named` 作用域都在 `SyntaxPrinter` 实例内 → 每段一个打印器实例是自然扩展。
5. `--checkers` 对照显示双方并行调度都要 `--checkers` 才生效，而 C# 的并行扩展（1.70×）优于 Go（1.18×）→ 说明**并行不是我们的短板，单线程绝对性能才是**；分段并行是唯一能同时改善单文件负载结构的手段。

### 2.2 设计（先串行分再合并，最后并行）

```
SourceFileNode.Statements（16,384 条顶层语句）
  ├─ 切分：按语句边界均分 K 段（K = clamp(Environment.ProcessorCount / 4, 2, 8)）
  ├─ 串行阶段（第一个提交）：段 i → 独立 SyntaxPrinter → 独立 EmitTextWriter 缓冲
  ├─ 按段序拼接缓冲 → 断言与整文件串行输出逐字节一致
  └─ 并行阶段（第二个提交）：Task.Run 每段，完成后按序拼接
```

**关键约束与处理**（与 r05 §2.2 同源，本轮补充实测依据）：

| 约束 | 处理 |
| --- | --- |
| 输出顺序 | 段缓冲按索引拼接，与完成顺序无关 |
| 停用条件 | `sourceMap` 打开、`--stripInternal`、非顶层语句边界（如 `outFile` 拼接多文件）时回退整文件串行 |
| 缩进/换行上下文 | 顶层语句缩进恒为 0；每段打印器从行首状态开始 |
| ASI（`NoAsi`） | 段边界限定在"以分号/右花括号结束"的语句之后；交界处仍由整文件语义决定 → 串行原型必须先过 23 负载字节门禁 |
| 生成名（`generatedNames`）与 helpers | 段内生成名互不冲突的前提是名字按声明作用域唯一；预扫描一遍顶层声明收集名字（或段内冲突检测 + 串行降级） |
| `EmitContext` 共享 | `EmitContext` 的 `nodes`/`originals` 字典是**变换期**产物；若打印阶段只读，可每段一个只读视图；写路径（`AddHelper` 等）需在分段前完成 |
| GC 压力 | K 上限 8（r05b 教训：多文件负载过度并发时 +3.7~4.7%）；单文件分段用不到文件级并行的线程池 |

### 2.3 前置门（必须按顺序，最不确定的前提先证伪）

1. **串行分段原型**：实现"切分 + 逐段打印 + 拼接"，**不引入任何并发**；跑 23 负载字节门禁 + `emit-foundations`/`transpile`/`declaration` 套件。此步失败 → 方案降级为 P1/P2（不动并行）。
2. 同二进制开关 A/B（`TSHARP_EMIT_SEGMENTS`）：`--declaration false` 与 `--emitDeclarationOnly` 两种单遍形态各测一次（避免两遍形态掩盖单段的规模效应）。
3. 15 组配对 A/B vs r06 基线，噪声须 ≤10%；K ∈ {2,4,8} 各测一次选最优。

### 2.4 预期

| 形态 | emit | 巨文件总计 | vs Go 默认 |
| --- | ---: | ---: | ---: |
| 现状 r05c | 0.617 s | 1.175 s | 3.36× |
| K=8 打印扩展 4–6×（打印约占 emit 的 60%） | **0.30–0.40 s** | **0.85–0.95 s** | **~2.4–2.7×** |

---

## 3. P1：声明发射的"重建"消除（152.7 MB / 0.325 s）

### 3.1 依据

类型级差分（§0.4 口径，仅看构成）显示声明侧的主要成本是**重建而非打印本身**：

| 成本项 | 量级 | 说明 |
| --- | ---: | --- |
| `Part[]` | ~30 MB | .d.ts 打印 |
| 节点重建（`VariableDeclarationNode`/`TypeLiteralNode`/`PropertySignature…` + `SyntaxNode[]`/`NodeList`） | ~25–30 MB | 声明变换器逐声明重建子树 |
| `Entry[SyntaxNode,SyntaxNode][]`（`originals` 映射） | 7.6 MB | 每个重建节点一条"原节点"记录 |
| `Dictionary<Utf8String,Symbol>`（成员表） | 4.6 MB | 成员表重建 |
| 闭包（`<>c__DisplayClass*`） | ~20 MB | 变换器 lambda |
| 委托（`Func<SymbolAccessibilityResult,Info>` 3.2 MB、`Predicate<SyntaxNode>` 1.6 MB） | ~5 MB | 每次调用新建委托 |
| `ArrayWhereSelectIterator` | 2.5 MB | 修饰符 LINQ |

### 3.2 改造

1. **未变更声明直通**：声明发射对"输出 = 原节点文本 + 删掉局部内容"的声明（`export const x = <expr>` → 只保留到类型注解），改为**在原节点上直接打印 + 局部跳过规则**，不再 `ShallowClone` 整棵子树。判据：该声明没有需要改写的修饰符/类型/嵌套声明（与 r05 P2 的"未变更子树共享"同一思路，但在声明侧收益更大）。
2. **`originals` 映射瘦化**：只在"需要回查源节点"的重建节点上登记（当前是每个重建节点都登记）。或改为按段惰性映射（与 P0 的分段天然协同：段内映射在段结束后即可释放）。
3. **委托/迭代器清除**：`DeclarationDiagnostics` 的 `Func<…>` 改为静态方法指针或结构体查表；`ArrayWhereSelectIterator`（修饰符筛选）改为一次显式循环。
4. **成员表构造复用**：若声明侧只是"原成员表 + 去掉私有/内部成员"，用 `SymbolTable` 局部裁剪而不是新建 `Dictionary`。

### 3.3 前置门与预期

- 前置门：先加"声明侧未变更/重建比例"计数（1 小时插桩）：若未变更声明占比 <50%，则第 1 项收益有限，直接做第 2–4 项。
- 预期：声明侧分配 **152.7 → 90–110 MB**（−30~40%）；巨文件 emit 时间 −10~15%（0.617 → 0.52–0.55 s）；RSS 同时下降。

---

## 4. P2：检查阶段对象字面量管线（100.8 MB / 0.320 s 的 55%）

### 4.1 依据（§0.2）

- `objectProperty` 属性循环 69.2 MB / 16,384 个对象字面量 = **4.2 KB/字面量**；
- 其中 fresh 类型构造只有 7.4 MB（0.45 KB/个）→ **钱花在属性管线，不在类型对象**；
- 每属性一次的固定分配：瞬态 `Symbol`（`Symbol` 总计 15.3 MB）+ `ValueSymbolLinks`（8.9 MB，`LinkStore creates = 180,339`）+ `SymbolDeclarationList.AddRange`（每属性）+ `Dictionary/List` 头；
- `objectLiteral` 内部还包含 `${count}`/`${text}` 两个属性初始化器的表达式检查与字面量类型构造。

### 4.2 改造（按预期收益排序）

| 候选 | 改动 | 预期 |
| --- | --- | --- |
| **属性符号与链接的按需分配** | 对象字面量属性当前一律 `new Symbol(Transient)` + `links.Values.Get(property)`；改为：先尝试复用 `symbols.Declaration(declaration)`，仅当名字是计算属性、或需要可选性/重写时才建瞬态符号与链接 | 每字面量省 ~2 个 Symbol + 2 个 links ≈ 0.8–1.2 KB → **−15~20 MB** |
| **`table`/`all`/`ordered` 惰性化** | `table`/`ordered` 只在存在 spread 或索引签名时才需要；无 spread 的常见形态直接由符号表视图产生 | 省 2 个 Dictionary/List 头/字面量 → **−4~6 MB** |
| **`DeclarationList.AddRange` 仅在确有差异时** | 声明列表多数等于成员原列表；相同引用直接复用 | **−3~5 MB** |
| **成员表构造（setMembers 11.7 MB / resolveMembers 11.9 MB）** | 按 `members.Count` 预分配；成员数 ≤ 2 时跳过排序（插入有序）；`Array.AsReadOnly([.. a, .. b])` 改为单数组填充 | **−4~6 MB** |
| **`membersTable` 548 B/次的小表** | 2 成员表的 `LateMembers.TableAsync` 缓存键 `(Symbol,bool)` 与 `IReadOnlyDictionary` 包装：确认是否每类型重复解析（若重复 → 加 per-type 缓存） | **−5~10 MB** |

**不做**：`RelationKey`/关系缓存结构体化（已是扁平结构体字典）；`AsReadOnly` 全面移除（r04 实测 <2 MB）。

### 4.3 前置门与预期

- 前置门：为"每字面量 4.2 KB"再做一次**属性循环内部分帧**（`MutableAsync`/`SymbolTypes.GetAsync`/`table[..]`/`ordered.Add`），确认 0.8 KB 以上的项都在候选表内（避免又一轮"改完只有 −0.7%"）。
- 预期：check 分配 179.8 → 145–155 MB（−15~20%）；check 时间 0.320 → 0.29–0.30 s（−6~10%）。**时间收益上限有限（r04 证据）**，故排在 P0/P1 之后。

---

## 5. P3：打印容器与工作项分派（`Part[]` 62.4 MB + `Payload` 6.9 MB）

| 改动 | 说明 | 预期 |
| --- | --- | --- |
| `Part` 结构瘦身 64 → 40 B | `Utf8String text`（16 B）只有在"文本部件"使用；把文本移入 `Payload` 或改为 `(int offset,int length)` 引用源文本 → 数组元素降 37% | `Part[]` −20~25 MB |
| 小元数 `S(...)` 内联 | 1–4 元部件组不再 `parts.ToArray()`，用 `Payload` 里的定长槽（现在 `S()` 每次调用都分配数组，65,536 次） | −10 MB 级 |
| `Payload` 惰性化复核 | `Payload` 6.9 MB 说明"稀有引用"并不稀有（`GenerateNode`/`PositionTarget` 使用频次待测）；把 `GenerateNode` 提到主结构、`PositionTarget` 只在 sourceMap 时构造 | −3~5 MB |
| `Part.Kind` 跳转分派 | 打印主循环现在是 ~15 路 `if/else`（每个部件都过一遍）；改 `byte Kind` + `switch` → 跳转表 | 时间收益为主（巨文件 100 万部件） |

**不做**：整体改为"直推式写作器"（去掉容器模型）——r04 已判定高风险大改，且分段并行（P0）能拿到大部分墙钟收益。

---

## 6. P4：parse/bind（+46 ms，低优先）

- Scanner 字节 → UTF-16 转写路径与 `Scanner` 每文件分配（按 token 文本构造 `Utf8String`）；`SyntaxNode[]`/`NodeList` 的容量预估；
- Binder 符号表：`Dictionary<Utf8String,Symbol>` 的 Entry[] 5.9 MB + `Symbol` 15.3 MB（小作用域已走 `SymbolTable` 内联数组，大作用域仍用字典）。
- 预期合计 −10~15 ms；**只有在 P0–P3 全部落地后仍有余量时才做**。

---

## 7. P5：启动地板（记录，不投入）

`--version` 整进程 ~54 ms，其中 Main 内仅 2.9–3.9 ms；`IlcInstructionSet=native` 已验证无收益。唯一余量是镜像尺寸/布局（28.28 MB，内嵌形态 +5.17 MB → 纯启动 +3.5~4%）。**建议不改代码**，但报告必须把启动地板从比值中剥离（r05 §5 已做）。

---

## 8. 测量协议修正（本轮新增三条）

1. **单遍口径会低估真实成本**：两遍形态的 emit 分配 = JS 106.0 + 声明 152.7 = 258.7 MB（完全可加）；任何"仅 JS"/"仅声明"的测量都不能直接当两遍形态的配额。
2. **类型级 trace 只作构成比例**：`dotnet-trace + TraceEvent` 的 GCAllocationTick 聚合会出现个别行的类型名错配（本轮 `List<SyntheticComment>` 与无条件计数器矛盾）；**配额必须用编译器自报的阶段/帧计数器**，trace 只用来发现"哪类对象多"。
3. **分配 A/B 单样本即判定，时间 A/B 必须 15 组配对**：同二进制重复运行分配偏差 ≤0.03 MB（三次实测），时间受输入门控与调度影响仍有 5~13% 噪声。

---

## 9. 预期总收益（保守 / 上限）

| 阶段 | 巨文件随时间 | vs Go 默认 | medium（计算比） | 分配 |
| --- | ---: | ---: | ---: | ---: |
| 现状 r05c（+本轮 A/B） | 1.175 s | 3.36× | ~3.06× | 508 MB |
| +P0（分段并行打印） | 0.85–0.95 s | 2.4–2.7× | ~2.6× | 505 MB |
| +P1（声明侧重建消除） | 0.80–0.88 s | 2.3–2.5× | ~2.4× | 460 MB |
| +P2（检查管线） | 0.76–0.84 s | 2.2–2.4× | ~2.1× | 425 MB |
| +P3（打印容器） | **0.72–0.80 s** | **2.1–2.3×** | **~2.0×** | **390 MB** |

> 同 r05 的结论：**追平 Go 仍不现实**（check 的类型/符号模型差异 + 启动地板），但 P0 单项即可把巨文件从 3.36× 压到 ~2.5×。

---

## 10. 执行顺序与验证门禁

| 顺序 | 项 | 工时 | 门禁 |
| --- | --- | --- | --- |
| 1 | **P0 串行分段原型**（不并行） | 0.5–1 天 | 23 负载 × 15 对逐字节一致 + 3 个发射套件 |
| 2 | P0 并行化 + K 扫描 | 0.5 天 | 同二进制开关 A/B（K∈{2,4,8}）+ safety |
| 3 | P1 声明侧未变更比例插桩 → 直通改造 | 1–1.5 天 | 23 负载字节一致 + `declaration`/`emit-foundations` |
| 4 | P2 属性循环内部分帧 → 候选表落地 | 1–2 天 | 分配 A/B 单样本 + 字节一致 + checker 套件 |
| 5 | P3 Part 瘦身 + 分派 | 1 天 | 字节一致 + 分配 A/B |
| 6 | P4/P5 | — | 视 P0–P3 后余量决定 |

**统一门禁**：`dotnet build` 0 警告 0 错误 → 23 负载 × 15 对逐字节一致 → safety 套件（基线失败项须逐项对照确认同因）→ AOT 产品形态（`-p:EmbedTypeScriptLibraries=false`）配对 A/B → `--extendedDiagnostics` 阶段分配 + 探针帧对比。

---

## 附录 A：本轮探针补丁（已入库，`--extendedDiagnostics` 下生效）

- `Diagnostics/AllocationProbes.cs`：16 个命名帧（含本轮用到的 11 个）。
- `CompilationCapture`：`Mark()/Report()` **含零成本门控**（`ProbesEnabled` 为静态读；未开诊断时只有一次静态 bool 判断，无 `AsyncLocal` 读）；`NoteCommentAdd/Set`、`NoteNodeData`、`NoteLinkCreate` 计数；`Statistics` 输出 `Probe alloc *` / `LinkStore creates` 等行。
- 帧位点：`TypeNodes.WorkerCoreAsync`（typeFromNode/typeLiteral）、`StructuredMembers.SetAsync/ResolveAsync`、`Checker.MembersAsync`、`TypeWidening.GetAsync/ObjectAsync`、`TypeRelations.RelatedAsync`、`RelationOperation.CompareCoreAsync`、`ObjectLiterals.CheckAsync/RegularAsync` 与对象字面量属性循环（objectLiteral/objectProperty/objectType/objectRegular）、`SymbolTypes.GetAsync`、`LinkStore.Get`。
- 口径：帧为**包含式**（不做子帧扣减），读数须按已知嵌套关系解释；需要"自身分配"时按 r04 的父子帧扣减法扩展（帧栈已在 `CompilationCapture` 预留）。

## 附录 B：复现命令

```powershell
# 1) 诊断构建（15 s）+ 分配归因
dotnet build csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj -c Release
dotnet csharp/src/TypeScript.CommandLine/bin/Release/net11.0/tsgo-cs.dll `
  --project <夹具>/tsconfig.json --pretty false --extendedDiagnostics

# 2) 分阶段/两遍构成（AOT 产品形态）
pkgs/r05c/lib/tsc.exe --project <夹具>/tsconfig.json --extendedDiagnostics
pkgs/r05c/lib/tsc.exe --project <夹具>/tsconfig.json --extendedDiagnostics --declaration false
pkgs/r05c/lib/tsc.exe --project <夹具>/tsconfig.json --extendedDiagnostics --emitDeclarationOnly

# 3) 类型级构成（仅比例，不作配额）
dotnet-trace collect --profile gc-verbose -o base.nettrace -- <tsc>
dotnet-script alloc-by-type.csx -- base.nettrace        # 脚本见 tsbench 探针目录

# 4) 配对 A/B（产品形态）
node tools/perf-cli.mjs --manifest manifests/<批次>.json --go-executable <产物> `
  --samples 15 --directory bench/AB<next>-*
```

> 本轮探针夹具（4 个变体：基准 / 仅注解 / 仅字面量 / 共享接口）与分配聚合脚本保留在 `C:\ai\projects\tsbench\probe-r06\` 与 `%TEMP%\tsprobe\`（临时目录，非仓库内容）。
