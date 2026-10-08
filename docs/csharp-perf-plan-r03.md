> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-08 ｜ 轮次: r03 ｜ 主题: baseline-corrected
> 涉及 git 节点: `6ed638d3a5`（基线） / `c929d92b44`（最新代码） ｜ 数据来源: `bench/AB33`–`bench/AB38`
> 状态: **当前最新方案** ｜ 关联: `reports/report_2026-10-08_r03_baseline-vs-latest.md`、`audits/audit_2026-10-08_r03_build-shape.md`
# C# 编译器极致优化方案 v3（基于最新修正后的实测）

> 本方案取代 v1/v2。v1/v2 的核心结论建立在两个已证伪的前提上：**① 基线被设为 Server GC（非出厂状态）；② 我方"最新"构建形态与产品不一致（误开 lib 内嵌）**。修正后重测，问题的优先级完全改变。

---

## 0. 最新实测事实（全部为同批配对 + 同构建形态）

### 0.1 相对"优化前基准"（AB37：产品形态两侧，噪声 10.6%，15 组）

| 分组 | 项数 | 平均 | 区间 |
| --- | ---: | ---: | --- |
| 重负载（medium 族、512 文件族、巨文件、声明） | 11 | **+30.4%** | +11.3% ~ +41.3% |
| 轻负载（启动、单诊断、工程引用、noemit） | 12 | **−3.0%（变慢）** | 慢 0.1% ~ 5.7% |
| 全部 | 23 | +13.4% | — |

- 重负载最好：medium **+41.3%**、256m +40.8%、checkers-8 +39.2%、checkers-4 +37.9%、noemit-on-error +33.9%、tiny-files +32.7%、incremental +30.0%、declarations +24.5%、huge-file +19.5%
- 轻负载仍回退：small-diag **−5.2%**、tiny-noemit **−5.2%**、pr-impl **−5.7%**、pr-package −3.7%、pr-decl −3.0%、pr-config −2.7%、empty −2.7%、host-paths −2.6%
- **help −0.1%、version −0.3%（已回到噪声内）** —— 启动回退经构建形态修正后消失

### 0.2 相对 Go（AB33：C# 最新 vs Go@GOGC=400，噪声 4.9%）

| 负载 | C# 最新 ÷ Go@400 |
| --- | ---: |
| medium | +94% |
| declarations | +98% |
| huge-file | +211% |
| medium-checkers-1 | +180% |
| tiny-files | +36% |
| help / version | +20% / +17% |
| 内存低于 Go 的负载 | **13 / 23** |

### 0.3 阶段归因（巨文件，AOT，5 次取优）

```
parse 0.069 s   bind 0.052 s   check 0.326 s   emit 0.618 s   total 1.175 s   (Go@400: 0.368 s)
```

| 阶段 | C# (s) | 占 C# 总时 | 与 Go 比 |
| --- | ---: | ---: | ---: |
| 解析 | 0.069 | 5.9% | ~1.4× |
| 绑定 | 0.052 | 4.4% | — |
| **检查** | **0.326** | **27.7%** | **~3.3×** |
| **发射** | **0.618** | **52.6%** | **~3.6×** |
| 程序构建等 | 0.110 | 9.4% | — |

### 0.4 确定性分配（巨文件，逐字节可复现）

| 阶段 | 优化前 | 最新 | 变化 | 剩余占比 |
| --- | ---: | ---: | ---: | ---: |
| 总计 | 960.1 MB | **519.7 MB** | −45.9% | 100% |
| 程序构建 | 63.9 MB | 63.8 MB | 持平 | 12.3% |
| 解析 | 42.2 MB | 42.2 MB | 持平 | 8.1% |
| 绑定 | 20.9 MB | 20.9 MB | 持平 | 4.0% |
| **检查** | 183.0 MB | **183.2 MB** | **未动** | **35.3%** |
| 发射 | 711.7 MB | **271.3 MB** | −61.9% | 52.2% |
| ├ 变换 | 124.2 MB | **124.2 MB** | **未动** | 23.9% |
| └ 打印 | 587.4 MB | **147.0 MB** | −75.0% | 28.3% |

### 0.5 新增归因实验（本轮为方案提供直接依据）

| 实验 | 对照 | 实测 | 结论 |
| --- | --- | --- | --- |
| **AB35** GC 对齐后的纯代码效果 | 两侧都出厂默认 gen0/LOH | help 1.042×、version 1.041×、empty 1.044×、small-diag 1.037×、tiny-noemit 1.013×、pr-impl 1.034×、pr-config **0.991×** | GC 调优贡献：small-diag +4.4%、tiny-noemit +5.6%、pr-impl +4.0%、pr-config +9.1%；但 medium **−4.6%**、declarations −2.3%、huge-file **−8.8%** |
| **AB36** 内嵌 vs 不内嵌 | 同代码同 GC | version **0.965×**、empty 0.968×、medium 0.958×、huge-file 0.976×；但 small-diag 1.031×、pr-impl 1.038×、pr-config 1.025× | 内嵌 = 镜像 +3.8 MB（33.15 vs 27.98 MB）→ 纯启动 +3.5~4%；编译负载上内嵌略优（省 lib 定位/读取） |
| **AB38** gen0 1 MiB vs 4 MiB | 同代码同形态 | small-diag **0.950×**、pr-impl **0.968×**、pr-config 0.987×、tiny-noemit 1.000×；medium 1.025×、declarations **1.078×**、huge-file 1.017× | **不存在单组最优 gen0**：1 MiB 利于轻负载且 RSS 更低（22.0→18.6 MiB），4 MiB 利于 medium/declarations |

---

## 1. 目标与优先级

| 优先级 | 目标 | 现状 | 目标值 | 预期总收益 |
| --- | --- | --- | --- | --- |
| **P0** | 消除 12 项轻负载回退 | 平均 −3.0% | **≥ 0%** | 全部 23 项平均从 +13.4% → **+16~17%** |
| **P1** | 检查阶段 | 183 MB / 0.326 s（3.3× Go） | −40% 分配 / −20% 时间 | 巨文件总时 −6%，全局中等工程 −8~10% |
| **P2** | 变换阶段 | 124 MB | −40% | 巨文件总时 −3~4% |
| **P3** | 打印机残余 | 147 MB | −40% | 巨文件总时 −3~5% |
| **P4** | 工作项架构 | ~100 万 Part 搬运（emit 0.618 s） | emit −20~30% | 巨文件 −10~15%，是缩小 3.6× 差距的关键 |
| **P5** | 启动地板 | help/version 54–56 ms（+17~20% vs Go） | 48–50 ms | 启动族 −8~12% |

---

## 2. P0：消除轻负载回退（最高优先，最快见效）

### P0-1 统一构建形态（已完成验证，需固化）

**问题**：`TypeScript.Compiler.csproj` 默认 `EmbedTypeScriptLibraries=true`，而产品打包脚本 `csharp/tools/package.mjs:75` 与 `product.mjs:28` 都用 `=false`；文档 `docs/csharp-extreme-optimization-results.md` 却建议开启。三处口径不一致，导致我此前把"内嵌版"当成产品形态测量，凭空制造了 +3.5~4% 的启动回退。

**行动**：
1. 所有构建/测量统一走 `package.mjs` 参数（no-embed），并把 `embedTypeScriptLibraries` 字段写入 harness manifest。
2. 修正文档与脚本的矛盾；若要内嵌，必须实现**懒加载**（见 P0-3）。

**已验证收益**：help −0.1%、version −0.3%（回退消失，AB37）。

### P0-2 GC 策略改为自适应（AB38 证明单组不可得）

**证据**：gen0 1 MiB 让 small-diag −5.0%、pr-impl −3.2% 且 RSS 更低；gen0 4 MiB 让 declarations −7.8%、medium −2.5%、huge-file −1.7%。

**行动（按推荐顺序）**：
1. **实验 A（新）**：`DOTNET_gcServer=1` + `DOTNET_GCDynamicAdaptationMode=1`（DATAS）——它是 .NET 8+ 为"按负载自适应堆/gen0"设计的开关，可能同时满足两端。**需实测**（此前只测过 Server GC 而未测 DATAS）。
2. **实验 B**：启动器按工程规模自适应——在 `lib/tsc.js` shim 里用 `fs.statSync` 快速估算源规模（tsconfig 所在目录的文件数与总字节，限 200 ms 内），小工程用 gen0=1 MiB、大工程用 4 MiB。需先测阈值（建议以"源文件总字节"为判据，AB38 显示文件数不是好判据）。
3. **实验 C（保底）**：放弃 gen0/LOH 调优，只保留 `ServerGarbageCollection=false`。代价：medium/declarations 回吐 2.5–7.8%，但轻负载回退清零、实现最简。

**验证**：同一二进制 + 不同 env 的配对 A/B（如 AB38），覆盖 7 个代表性负载；判据为"轻负载 CI 不排除 1.0 且方向为负、重负载仍显著为正"。

### P0-3 若最终要内嵌 lib，必须懒加载

**证据**：内嵌使镜像 27.98 → 33.15 MB（+3.8 MB），纯启动 +3.5~4%（AB36）；但内嵌在编译负载上省掉 lib 定位/读取，小工程 +2.5~3.8%。

**行动**：把内嵌实现从"启动期全量索引"改为**按需解包**——`EMBED_TYPESCRIPT_LIBRARIES` 路径下，仅在请求某个 `lib.X.d.ts` 时才从资源流读取并缓存；确保 `--version`/`--help` 不触碰任何 lib 资源。

---

## 3. P1：检查阶段（183 MB / 0.326 s，最大未触碰块）

### P1-1 先建"递归自分配归因"（P1 的前置条件）

**设计**（复用我在打印机上已验证的插桩手法）：

在 `Checker.Source.cs` 的 `CheckSourceElementAsync` 入口/出口做自身分配归因：

```
自身分配 = (出口 − 入口) − Σ(直接子节点的子树分配)
```

- 每个 `Checker` 实例持有一个 `List<long> allocationStack`（async 下按调用序 push/pop，try/finally 保证平衡）；
- 出口处把"子树总分配"累加给父节点，自身分配记入 `long[(int)node.Kind]`；
- 通过 `CompilationCapture` 输出 Top-12 节点种类（仅 `--extendedDiagnostics` 时启用，零热路径成本）。

**预期**：一次性定位检查阶段 183 MB 的分布（打印机上同样的手法定位到了 3 个占 47% 的节点种类）。

### P1-2 已见的候选点（先做低风险项）

| 候选 | 位置 | 问题 | 方案 |
| --- | --- | --- | --- |
| 检查器构造重复数组化 | `Checking/Checker.cs:31,50,113,146,249` | **5 处** `SourceFiles.Select(f => f.Syntax).ToArray()`，每个检查器实例各算一遍（×8 检查器） | 提到 `CheckerEnvironment` 上算一次并共享（不可变数组，无别名风险） |
| 签名构造 4 次分配 | `Checking/TypeContext.cs:385,387` | `Array.AsReadOnly(typeParameters.ToArray())` + 同 parameters | 去掉 `AsReadOnly`（数组本身即 `IReadOnlyList<T>`；已实测编译零错误、语义等价） |
| 对象类型属性数组化 | `StructuredMembers.cs:330`、`ModuleTypes.cs:46`、`MappedMembers.cs:205`、`Checker.ImportAttributes.cs:51`、`Checker.Inference.cs:126` 等 | `type.Properties = members.Values.Order(...).ToArray()` 每次新数组 + 排序 | 排序结果缓存/复用；无继承时直接持有 `values` 数组 |
| 关系/实例化缓存条目 | `Checking/TypeRelations.cs`、`TypeInstantiation.cs` | 缓存条目为类对象 | 改结构体键值（需先由 P1-1 确认占比） |

**目标**：check 分配 183 → ~110 MB，时间 0.326 → ~0.26 s。

---

## 4. P2：变换阶段（124 MB，未触碰）

| 候选 | 位置 | 问题 | 方案 |
| --- | --- | --- | --- |
| `NodeData` 对象膨胀 | `Emission/EmitContext.cs:13-31,53-58` | 每个被触碰节点创建一个 `NodeData` 类对象（约 96 B + 字典项），而**绝大多数只用到 `Flags`** | 把 `Flags` 拆到 `Dictionary<SyntaxNode, EmitFlags>`（值类型，无对象分配）；仅在需要注释/源码映射/TokenRanges 时才创建 `NodeData`。注意 `SetOriginal` 的 `data.Clone()` 分支需同步迁移 flags |
| 双字典 | `EmitContext.cs:33-34` | `originals` 与 `nodes` 两张 `Dictionary<SyntaxNode, …>`（ReferenceEqualityComparer） | 合并为一张 `Dictionary<SyntaxNode, NodeInfo>`（struct 内含 flags + original 引用） |
| 生成名表 | `EmitContext` 的 `generatedNames` | 与 `originals` 同步维护 | 合并到同一张表 |

**目标**：transform 124 → ~75 MB，巨文件总时 −3~4%。

---

## 5. P3：打印机残余（147 MB）

| 候选 | 规模 | 方案 |
| --- | --- | --- |
| `S(...)` 精确数组 | 巨文件 65,536 次调用 ≈ 14 MB | 1–4 元重载把部件内联进 `Part.Payload`（该 payload 已存在，可扩展为内联 2 个 Part）；或引入 `PartSpan(Part[] Array, int Count)` 走池化数组 |
| `Modifiers(node)` 容器 | 每次带修饰符的声明一个 `List<Part>` | 改为逆序直推（同 ObjectLiteral/TypeLiteral 的做法，已验证可降 24–35%） |
| `BlockBody` / `BlockMembers` | 函数体与块级列表容器 | 同上，直推 |
| `pending` 栈 | ~100 万次 `Part` 值搬运 | `Stack<Part>` → 数组 + 索引（消除边界检查与扩容拷贝），配合 P4 |

**目标**：print 147 → ~90 MB。

---

## 6. P4：工作项架构（巨文件 emit 0.618 s 的主因）

**现状**：巨文件约 100 万个部件工作项，主循环对每个部件跑最长 15 路 `if/else` 分派，`Part` 在容器与栈之间被复制两次。

**行动**：
1. **继续直推改造**（已验证手法，收益 −10~35%/项）：`BlockMembers`、`BlockBody`、`SourceFile` 语句序列、`Enum` 成员、`CaseBlock` 子句；
2. **分派去链**：把 `Part` 的"种类"显式编码为一个 `byte Kind` 字段（现由多个可空字段推断），主循环改 `switch`（跳转表）而非 15 路顺序判断；
3. **栈数组化**：`pending` 改为 `Part[]` + `int count`，`Push/Pop` 内联，消除 `Stack<T>` 的容量检查与数组拷贝；
4. **可选**：对超长列表（>阈值）改为"边遍历边打印"的迭代式展开，彻底避免容器。

**目标**：emit 0.618 → 0.43~0.50 s（−20~30%），巨文件端到端 −10~15%。

---

## 7. P5：启动地板（help/version +17~20% vs Go）

| 候选 | 依据 | 方案 |
| --- | --- | --- |
| 诊断消息表 | `Diagnostics/Messages.generated.cs:2219` 的 `All` 为 `Array.AsReadOnly([...])` 静态数组（2219 条） | 改为按需索引（`static readonly` 分片或延迟构造），避免启动期构建大数组 |
| CLI 选项表 | `Configuration/Options.generated.cs:5` 的 `All` 同理 | 同上 |
| 镜像布局 | 当前 27.98 MB | 已验证 `IlcInstructionSet=native` 无收益（≤2.8% 且多为负），不再尝试 |
| 进程初始化 | `--version` 不做任何编译仍 54 ms | 用 `--version` 路径的阶段计时（首个 `Stopwatch` 打点放在 `Main` 入口与输出前）定位剩余固定成本 |

**目标**：help/version 54–56 → 48–50 ms。

---

## 8. 方法论固化（避免重蹈本轮两个测量陷阱）

1. **构建形态必须与产品一致**：一律用 `package.mjs` 的参数（no-embed），并把形态写进 manifest；禁止裸 `dotnet publish` 产生对比产物。
2. **基线必须是出厂状态**：不得给基线加 `--server-gc` 之类的"增强"（R1 的错误），基线只用其烘焙配置。
3. **每次结论必须同批配对**：跨批绝对值漂移 10~60%，只采信同批比值；每轮附同二进制对照（噪声下限 ≤1.1%）。
4. **比值三方记录**：`vs C# 基准`（纯改善）、`vs Go@400`（公平参考）、`vs Go 默认`（出厂参考），三者同时给出。
5. **每个改动必须留下**：确定性分配差值 + 配对 A/B 比值 + 逐字节产物一致性 + 构建形态/SHA。

---

## 9. 预期总收益（保守估算）

| 阶段 | 巨文件时间 | 中等工程时间 | 说明 |
| --- | ---: | ---: | --- |
| 当前 | 1.175 s（Go 0.368） | 165.7 ms | — |
| P0 完成后 | 1.175 s（不变） | 165.7 ms | 但**轻负载回退清零**，23 项平均 +13.4% → +16~17% |
| +P1 | ~1.10 s | ~150 ms | check −20% |
| +P2 | ~1.07 s | ~148 ms | transform −40% |
| +P3 | ~1.03 s | ~145 ms | print −40% |
| +P4 | **~0.88 s** | ~140 ms | emit −25%（最大单项） |
| 合计 | **−25%** | **−15%** | 巨文件 vs Go 从 3.1× 收敛到 **~2.4×** |

> 结论保持不变：**耗时上全面追平 Go 不现实**（启动地板 + 工作项架构差异），但 P0+P4 可把最差的巨文件从 3.1× 压到 2.4× 量级，并让 23 项全部不回退。

---

## 10. 立即执行的三个实验（无需改代码）

| 实验 | 命令要点 | 判据 |
| --- | --- | --- |
| DATAS 自适应 GC | `--csharp-env "DOTNET_gcServer=1,DOTNET_GCDynamicAdaptationMode=1"` vs 当前配置，7 个代表性负载 × 11 组 | 轻负载 ≤1.0× 且重负载 <1.0× |
| 启动器自适应阈值 | 先测 `源文件总字节` 与 gen0 偏好的相关性（用现有 23 项数据回归） | 找到能区分"1 MiB 更好/4 MiB 更好"的阈值 |
| 内嵌懒加载收益 | 现有 `final7-noembed` vs `final7`（AB36 已完成） | 已证：纯启动 −3.5%，编译负载 +2.5~3.8% → 懒加载应同时拿到两者 |

