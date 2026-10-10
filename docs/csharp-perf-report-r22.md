# r22 实施报告：P 层确定性修复落地（−3.3 MB），并证伪 checkerRelated 42 MiB 的分解假设

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-10 ｜ 轮次: r22 ｜ 主题: p-layer-fixes-and-r-layer-prerequisite-probe
> 涉及 git 节点: `20b00d95fa`（r22 规划，工作树基线）/ 本轮提交
> 数据来源: 帧级独占分配探针（真实工程 5 组、巨文件 2 组）；产品 AOT 确定性分配（真实工程 基线 2 组 / 本轮 3 组）；25 夹具产物逐字节比对；95 个 safety flags；`--checkers 1` 对照；新增的关系递归深度 / 栈跨度探针
> 关联: `docs/csharp-perf-plan-r22.md`（本报告的实施对象）、`docs/csharp-perf-report-r21.md`（独占探针与分配基线）

---

## 0. 本轮结论

| 指标（产品 AOT，确定性分配，真实工程 291 文件） | r21 基线 | **r22** | 变化 |
| --- | ---: | ---: | ---: |
| CLR 总分配 | 836,963,008（836,875,840） | **833,422,320**（833,410,128 / 833,435,704） | **−3,496,707 B（−3.34 MiB，−0.42%）** |
| 巨文件 CLR 总分配 | — | — | 无变化（该负载不经过被改路径） |
| 关系递归最大深度（真实工程） | 未测 | **15** | 新增度量 |
| 关系递归栈跨度（真实工程） | 未测 | **59,840 B（≈58 KB）** | 新增度量 |

三件事实：

1. **P 层五项全部实施完毕**（P1 归因 + P2/P4/P5 代码修复；P3 经量化评估后判定不做，见 §3）。收益 **−3.34 MB（−0.42%）**，是方案预估（−40~70 MB）的约 **1/15**。
2. **方案对 42 MiB 的分解假设被实测证伪**。方案判断"主体是 `normalization.RelationTargetAsync` 与 Simple/Weak 检查"，实测这三项合计 **≈0.5 MB**；42 MiB 的主体是**关系会话的递归调度本体**（`RelationSession.RecursiveAsync` / `RecursiveCoreAsync` + `RelationKeys.CreateAsync`），且在浅负载（巨文件）上完全消失。见 §1。
3. **决策点判为跳过 S 层，直接进 R 层**。判据来自第 1 条：P 实测 0.42% 远低于方案 10% 的门槛，且 S 层的上限可由 r14 计数算术界定为 **≈7 MB（0.8%）**，同属"个位数百分比以下"。见 §5。

墙钟：AB105（23 负载 × 15 配对）+ AB106 轻负载复测（7 项 × 25 配对）见 §4；两次批次均全噪声，按分配轮惯例不作墙钟声明。

---

## 1. P1 归因结果：42 MiB 不是 normalization / Simple / Weak

方案 P1 的原话是"给 checkerRelated 加 normalization / simple / weak 三个子帧，拆出 42 MiB 的构成再修"，预期"先归因后定"。本轮按此实施，并为尾部（union 派发与递归调度）各加一帧，把 `checkerRelated` 的独占分配拆到接近零（43.66 MB → 18 KB）：

| 子帧 | 独占分配 | 调用次数 | 每次 | 说明 |
| --- | ---: | ---: | ---: | --- |
| relNormalize | 0 | — | — | `TypeNormalization.RelationTargetAsync`：仅在 `DefinitelyNonNullable` 源 + union 目标时工作，罕见 |
| relSimple | 0 | — | — | 两个 `SimpleAsync` 短路判定，纯标志位比较 |
| relWeak | 437,440 | 73,039 | 6 B | 弱类型检查条件（`WeakAsync`/`CommonPropertiesAsync`），其 inclusive 为 25.3 MB，全部落在已探针的子帧里 |
| relIdentical | 28,288 | 68,571 | 0.4 B | 同形快路径（r10 落地），纯引用比较 |
| relUnion | 78,256 | 9,145 | 9 B | union/intersection 派发（`skip` 分支） |
| **relRecurse** | **43,169,432** | **63,891** | **675 B** | **`operation.RecursiveAsync(...)`——递归会话调度，42 MiB 的全部主体** |
| └ relKeys | 4,125,488 | — | — | 上一帧内部的 `RelationKeys.CreateAsync`（键构造） |

两条独立的佐证：

- **巨文件对照**：同一二进制在巨文件上 `checkerRelated` / `relRecurse` 的独占分配**为 0**（未进入 Own 榜）。巨文件的 32K 对象字面量全部被同形快路径与顶层缓存处理，不产生关系递归。这确认 42 MiB 与负载深度绑定。
- **递归深度实测**：真实工程最大关系递归深度 15（巨文件为 1）。675 B/层 × 深度 15 的量级与实际一致，说明这 675 B 是**每层递归的会话与键构造开销**（两层嵌套的泛型异步状态机 + `RelationKeys.CreateAsync` 的临时容器），不是某一处可一行改掉的缺陷。

**判断**：方案的 P1 设想（在 normalization / Simple / Weak 里藏着可修的结构性缺陷）不成立。42 MiB 是关系会话递归调度本体的固定开销，属 R 层（检查器同步化）才会消除的那一类——同步化后每层的异步状态机会退化为普通栈帧，键构造也不再跨 await 存活。这一结论把 R 层的预期收益上修了佐证强度（见 §6）。

---

## 2. 落地内容（P2 / P4 / P5）

### 2.1 P2：引用实参数组的 outer 前缀复用（`typeFromNode` −0.61 MiB）

`TypeReferences.TypeArgumentsAsync` 与 `ClassReferenceAsync` 都先取"外层类型参数前缀 + 自有实参"再拼成一个新数组，拼装用集合表达式 `[.. outer, .. args]`。多数引用 `OuterTypeParameterCount == 0`（非嵌套类型），此时前缀为空，集合表达式仍会**把自有实参数组复制进第二个数组**。

新增静态 `CombineArguments(allParameters, outer, arguments)`：`outer == 0` 且实参已是 `Type[]` 时**直接返回其实参数组**，否则按索引前缀拷贝。同时删除了因此不再使用的 `OuterTypeParameters`（其返回的空数组本就是 `Array.Empty`）。`CreateTypeReference` 与 `TypeMapper.Create` 都取 `ReadOnlySpan<Type>`，实参数组可直接隐式转换。

### 2.2 P4：resolveMembers 余量（`resolveMembers` −1.52 MiB、`setMembers` −0.49 MiB）

四处：

1. `InstantiateSignaturesAsync` / `InstantiateIndexesAsync`：空表（多数对象类型不声明 call/construct 签名）原先分配 `new T[0]` 再加 `ReadOnlyCollection` 包装两层，改为直接返回 `[]`。
2. `Concatenate<T>`：`Array.AsReadOnly<T>([.. left, .. right])` 去掉包装层，返回精确尺寸数组。
3. `SetCoreAsync`：成员表落盘的 `Array.AsReadOnly<Symbol>([.. declared, .. inherited])` 改为精确尺寸数组 + 两次 `CopyTo`。
4. `ObjectAsync`：`parameters.SequenceEqual(arguments)` 改为计数 + 索引循环（`Type` 无 `Equals` 覆写，引用不等价即原默认比较器语义），每张实例化表省两个装箱枚举器。

### 2.3 P5：`Symbol.Id` 改创建时赋值（墙钟微量，分配零）

原实现惰性 `Volatile.Read` + `Interlocked.CompareExchange`，首次读取才分配 Id。`RelationKey` 的哈希每次键构造读两侧 Id（本轮实测 115K+ 次键构造），实测口径下惰性形态每次读付一次 volatile 读加一次分支。改为构造函数里 `Interlocked.Increment(ref nextId)` 一次性赋值，`Id` 退化为普通字段读。全程序 64,392 个 Symbol，创建开销可忽略。

---

## 3. P3 评估：链接唯一化的上限约 10 MB，判为不做

方案 P3 要求"统计链接创建次数与共享符号的重复建链，评估'链接按符号唯一化（跨 checker 共享只读部分）'"。实施了两项测量：

1. **热站点子帧**：在 `SymbolTypes.GetCoreAsync` 的 `links.Values.Get(symbol)` 处加 `linkGet` 帧 → **534,592 B / 50,067 次**。即 `symbolTypesGet`（32.8 MB 独占）中由该站点创建 `ValueSymbolLinks` 的部分只有 0.53 MB，其余是该帧内其它分支（Deferred / Instantiated / FunctionClassModule 等）的合法工作。
2. **`--checkers 1` 对照**：`LinkStore creates` 全局计数从默认的 **464,301** 降到 **330,223**，返回比 **1.41**。即跨 checker 的重复建链约 **134,078 次 × ≈75 B ≈ 10 MB**，是链接唯一化的**理论上限**（相当于总分配的 1.2%）。

**裁定：不做。** 理由：上限仅 ~10 MB（1.2%），而实现手段是让 `CheckerLinks` 这类**可变**的每 checker 稀疏表跨线程共享，直接触碰 `Links.cs` 顶部记录的"稀疏 BCL 表按 checker 隔离、绝不挂到共享 AST/符号上"的 AOT 设计前提。以架构级改动换 1.2% 分配不划算；该族与方案 N 层"跨 checker 关系结果缓存"同理（Go 亦未做）。

---

## 4. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | AOT 产品 0 警告 / 0 错误（`pkgs/r22/lib/tsc.exe` sha256 `04574cf2eebb4a73…`，29,800,448 B）；兼容性测试工程 `dotnet build` 0/0 |
| 确定性分配 | 真实工程 836.9 → 833.4 MB（−3.34 MiB，−0.42%）；基线两侧 836,875,840 / 836,963,008（≈87 KB 带），本轮三侧 833,410,128 / 833,422,320 / 833,435,704（≈26 KB 带） |
| 逐字节一致 | 18 合成形状 + 5 staged 负载（1,882 产物）+ 巨文件 + 真实工程（645 产物），r22base 与 r22 **25/25 全部一致** |
| safety 套件 | 95 flags 中 **90 通过 / 5 失败**；5 个失败**全部**为已知基线失败：`checker-relation-context-safety`（`CheckerProgramTests.cs:170`，`Sequence contains no matching element`）、`program-emit-safety`（`Program emit assertion 14`）、`developer-safety` + `lsp-native-watch-safety`（需目录参数，不可直接调用）、`npm-process-safety`（环境态文件占用，逐轮波动） |
| 已知失败反证 | 对唯一触及关系代码的 `checker-relation-context-safety` 做 `git stash` 反证：未修改源码上以**完全相同**的异常与行号失败 → 预存在，非回归 |
| 墙钟 | 见下 |

**墙钟（AB105，r22 vs r22base，23 负载 × 15 配对）**：控制项 `p95RelativePairDifference` 18.6%、`medianRatio` 0.993、CI [0.950, 1.071] —— 批次有效（落在本战役认可带 12.9%~22.8% 内）。23 项中 **22 项 CI 跨 1.0**；唯一显著项是 `tiny-files-noemit` +1.7%（CI [1.0046, 1.0429]，158.8→161.4 ms，2.7 ms）。轻负载族方向不一致（help +2.9%、version −0.7%、small-first-diagnostic −1.0%），符合 r13 记录的启动主导噪声形态。

**轻负载复测（AB106，同二元组 7 项 × 25 配对）**：控制项 `p95RelativePairDifference` 14.5%（有效）。**零个显著项**；`tiny-files-noemit` 复测为 0.9887（CI [0.976, 1.001]，反而更快），即 AB105 的 +1.7% **未复现**，判为噪声。

**结论**：墙钟全部落在噪声内，无回归、亦不作改善声明 —— 分配轮惯例。

**口径说明**：本轮改动的确定性分配收益只有 0.42%，属分配轮（r13 / r15 / r21 先例），不作为墙钟声明。方案的 P 层预期墙钟本就是 0~1%，低于本机批次分辨力，因此决策点里的"墙钟 < 2%"由**分配量级**判定（0.42% 的分配降低不可能对应 >2% 墙钟）。

---

## 5. 决策点与 S 层裁定

方案 §3 的决策规则："若 P+S 预期合计 < 10% 分配且墙钟 < 2%，跳过 S 直接进 R；否则 S 做完再进 R。"

- **P 实测**：−0.42%（方案预估 −40~70 MB ≈ −5~8%）。
- **S 上限（算术界定，用方案自己的 r14 计数）**：
  - S1 `RelationOperation` 池化：49,069 次分配 ×（对象 ≈104 B + 每实例 `reportOverflow` 委托 ≈32 B）≈ **6.7 MB**。
  - S2 泛型关系键 `List<Part>` + `Dictionary<Type,int>` 暂存：1,218 次构造 ≈ **0.24 MB**。
  - S3 `mappingScratch` 模式推广：r14 记录"每个可避免项 < 0.5%"，量级 **< 4 MB**。
  - S 合计上限 **≈ 11 MB（1.3%）**，且需为每类容器维护重置清单 + 安全套件（可变状态漏重置 → 诊断错误）。
- **裁定**：P+S 预期合计 **≈1.7% ≪ 10%** → **跳过 S，直接进 R**。

这与 r21 报告的判断一致："若仍是个位数百分比，则分配侧收工。" 本轮用独占探针把 `checkerRelated` 拆到底，也把 P 层逐项落到了实测数字，分配侧到此收工。

---

## 6. R 层前置探针（方案要求的动工前设计）

方案第三层 R 的前置设计要求："先写 10 分钟探针实测真实工程的最大递归深度，定栈大小（建议 256 MB 起步）。"本轮落地了两个探针（关闭诊断时零成本）：

| 度量（真实工程 291 文件） | 值 |
| --- | ---: |
| 关系递归最大深度（`Checker.RelatedAsync` 嵌套） | **15** |
| 关系递归栈跨度（同名入口上的栈地址跨度） | **59,840 B ≈ 58 KB** |
| 巨文件对照（深度 / 栈跨度） | 1 / — |

读数与含义：

- 关系递归只有 **15 层**、跨栈仅 **58 KB**（≈4 KB/层）。方案建议的 256 MB 栈对此工作负载**严重过估**；每层约 4 KB 反过来印证了 §1 的 675 B/层分配——异步状态机在同步完成的 await 上仍占用约 4 KB 栈，正是 R 层换成同步帧后要回收的那部分。
- 但**关系递归不是检查器最深的栈路径**。整体检查的栈深度还受表达式/属性/类型嵌套支配，本轮未测。R 层的"专用大栈线程"尺寸应以**整体检查最深栈**为准，建议在同步化原型的第一步用同一探针在检查器主入口上测一次，再定尺寸——不要沿用 256 MB 的默认值。
- 反过来说，58 KB 的关系栈跨度说明：深度不是问题，**每层的状态机成本**才是。R 层的收益逻辑因此更清楚——不是"栈不够用"，而是"每层为异步付了固定税金"。

---

## 7. 工作树状态

本轮提交包含：

- 三处行为修复：`TypeReferences.cs`（P2）、`StructuredMembers.cs`（P4）、`Binding/Symbol.cs`（P5）。
- 诊断基础设施：`AllocationProbes.cs` 新增 8 个帧（relNormalize / relSimple / relWeak / relIdentical / relUnion / relRecurse / relKeys + 启用既有 linkGet）、`StructuralRelations.cs` 与 `RelationKeys.cs` 与 `SymbolTypes.cs` 的帧挂点、`Checker.Relation.cs` 的关系深度计数、`CompilationCapture.cs` + `CompilationStatistics.cs` 的深度/栈跨度统计与打印宽度 24→32（现有 37 帧，24 会截断新子帧）。
- 字节校验脚本 `built/r22-bytecheck.mjs`（基线 r22base ↔ r22，含真实工程夹具）。

未决项：

- R 层本体未动工（1~2 月重写规模，方案自有 Go/No-Go 门槛）。动工前置的整体检查最深栈测量已列为建议第一步。
