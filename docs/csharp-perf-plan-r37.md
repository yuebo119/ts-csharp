# r37 方案：消除 checker 相位的重复派生（P0 归因实测已判定根因）（2026-10-15）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-15 ｜ 轮次: r37（未开工）｜ 主题: checker-dedup / emit-dedup ｜ 版本: v1.0
> **v1 修订**：P0 归因探针已落地并跑完 `--checkers 1/2/4/8` 配对；本方案的优先级排序**由实测数据重排**（原 L1「并行效率不足」假设被证伪，见 §4）。量具与口径沿用 `docs/csharp-perf-method.md`；三元契约表口径仍取 r28 表（`docs/csharp-perf-report-r28-comparison.md`），本方案不单方面改口径（§7.3）。
> 触发: 用户指令「不考虑以前的决策和分析…完全重新读取所有代码文件，整体综合分析，给出最优的极致性能优化方案」+ 官方性能工程触发条件「项目完成/阶段边界」。
> 前置: `docs/csharp-perf-plan-r35-architecture.md`（热路径重写 W1–W7）、`.ai/perf-ledger.md`、`perf-budgets.md`、`docs/csharp-perf-report-fresh-2026-10-14.md`。
> 关联产物: 本轮 P0 探针补丁（§10，已过全部门禁）；`docs/csharp-perf-method.md`（测量权威）。

---

## 1. 结论摘要

1. **P0 归因判定：原来的三条候选全部排除。**「checker 并行效率只有 ~2.5×」不是 (a) 每 checker 固定构造成本（构造墙钟 ≤55 ms、分摊到 8 checker 仅 ~0.16 s CPU）、不是 (b) 内存带宽/GC 饱和（进程分配只 +26%、GC 暂停 0.06→0.14 s，而 check 线程时间涨 3.4~4.7×）、也不是 (c) 串行尾巴（`diagnosticsTotal − checkPool` ≈ 20~50 ms，`globalDiag`/`fileDiag`/`affected` ≈ 0）。
2. **真正根因 (d)：每个 checker 重复派生共享结构。** 并行效率本身是好的（8 lane 达 **6.6~6.9×**，16 物理核上留有余量），但**并行工作量随 checker 数近线性增长**：medium（官方口径）check 线程时间 c1→c8 = 0.52→1.76 s（×3.39），emit 线程时间 0.44→1.21 s（×2.73），Types ×2.19、Instantiations ×2.37；而 parse ×1.00、bind ×1.03 **零增长**——说明语法/绑定是共享的，**只有 checker 的派生状态是每 checker 一份**。6.6× 的并行增益被 3.4× 的工作增长吃掉，净收益只剩 1.96×。
3. **次根因 (e)：单文件关键路径。** 在**检查声明文件**的口径下（`skipLibCheck` 关、默认 DOM lib 参与），`lib.dom.d.ts`（110,506 节点 / 2.35 MB，权重是次大文件的 10 倍）因分区器 `limit = max(maxWeight, avg×1.01)` 被单独锁进一个分区，其检查耗时**等于整个 check 墙钟**（medium 1.50 s、dtsheavy 1.60 s、tiny512 1.42 s），故 checker 数上调到任何值都无收益；`huge` 的 `big.ts`（32,768 个对象字面量）同理固定 2.87 s。
4. **口径警告（必读）**：官方 harness 的 workload 生成器写死 `skipLibCheck: true, lib: ["es5"]`（`csharp/tools/performance-cli.mjs:50`），而本仓 perf 夹具默认不设 `skipLibCheck`（`csharp/tools/perf-fixtures.mjs`）。**两族夹具测的是不同工作量级**：(e) 在官方口径下不可见，(d) 两口径都存在。任何数字都必须带口径。
5. **优先级重排**：L1 去重 checker 派生状态（原 L1，量化后仍是首位）、L2 去重 emit 派生状态（新晋，emit 占墙钟 ~28%）、L3 单文件关键路径（原 L2 巨文件，现在有明确靶点与度量）、L4 createProgram 默认 lib 层固定成本（原 L3）、L5 微项。r35 的 W1–W3 热路径重写性质变化：从「降分配」转为 **L3-a 的直接墙钟杠杆**（靶点 `lib.dom.d.ts` / `big.ts` 的每节点成本）。

---

## 2. P0 归因实测（方法、量具、口径）

**量具**：本轮新增 `CompilationCapture.Measure` 的 `phase:` 命名域（§10），全部 `traced: false`（不写 trace 事件，避并行 B/E 交错破坏 trace lane 嵌套），因此**只在 diagnostics 打开时启用**，普通构建一行不变。

**探针族（10 个域）**：

| 域 | 落点 | 语义 |
| --- | --- | --- |
| `phase:diagnosticsTotal` | `IncrementalProgram.Diagnostics.GetDiagnosticsCoreAsync` | 整个 check 相位墙钟（单实例） |
| `phase:checkConstruct` | `CheckerPool.CreateAsync` | 并行构造区墙钟（单实例） |
| `phase:constructEach` | `Checker.CreateAsync` | 每 checker 构造（跨实例求和 = 总 CPU） |
| `phase:globalMerge` | `CheckerSymbols.InitializeAsync` | 每 checker 全局符号合并 |
| `phase:globalTypes` | `CheckerEnvironment.InitializeGlobalTypesAsync` | 每 checker 核心 lib 类型解析 |
| `phase:checkPool` | `CheckerPool.GetDiagnosticsAsync` | 并行检查区墙钟（单实例） |
| `phase:partition` / `phase:partition#N` | `CheckerPool` 每分区文件循环 | 分区总 CPU / **逐 checker** 分摊 |
| `phase:partitionDiag` | `CheckerPool` 分组与明细诊断 | 分区收尾 |
| `phase:globalDiag` / `phase:fileDiag` / `phase:affected` | `IncrementalProgram.Diagnostics` | 疑似串行尾巴三处 |

**方法**：逐 run 全新夹具副本（避免增量态），每配置 2~3 run；测量环境按 `docs/csharp-perf-method.md` §6（`DOTNET_gcServer=0 DOTNET_GCgen0size=0x400000 DOTNET_GCLOHThreshold=1000000`）以与既有账本数字同批可比；另在**产品 GC 配置**（Server GC，无 env 覆盖）复核一遍（§3.4）以排除 GC 形态对结论的干扰。夹具 = `built/csharp/perf-fresh/fixtures`（`csharp/tools/perf-fixtures.mjs`，95 文件 / 66k 行）。

---

## 3. 实测矩阵

### 3.1 medium（夹具默认口径：DOM lib 参与检查），Workstation-GC 量具，3 run 中位数

| c | Total 墙钟 | Check(summed) | checkPool 墙钟 | checkConstruct 墙钟 | constructEach(sum) | partitionSum | pMax | pMin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3.37 s | 2.19 | 2.19 | 0.003 | 0.058 | 2.19 | 2.19 | 2.19 |
| 2 | 3.13 s | 2.73 | 1.95 | 0.015 | 0.058 | 2.74 | 1.87 | 0.71 |
| 4 | 2.65 s | 2.88 | 1.60 | 0.041 | 0.11 | 2.88 | 1.46 | 0.36 |
| 8 | 2.56 s | 3.94 | 1.55 | 0.041 | 0.154 | 3.95 | **1.50** | 0.31 |

c8 的**逐 checker**分区时间（3 run）：`1.50 / 0.40 / 0.33 / 0.31 / 0.31 / 0.31 / 0.31 / 0.31`（s）。`pMax ≈ checkPool 墙钟`（1.50 ≈ 1.55）——check 墙钟就是**最重单分区**。反证实验：`--skipLibCheck` 下 `phase:partition#4` 直接变 0.000 s / 0.0 MB，8 个分区回到 0.27~0.31 s 均衡，checkPool 墙钟 **1.45→0.31 s（×4.6）**。

### 3.2 medium（官方 harness 口径：`--lib es5 --skipLibCheck`），Workstation-GC 量具

| c | Total | Check(sum) | Emit(sum) | Parse(sum) | Bind(sum) | checkPool | partitionSum | Types | Inst | CLR alloc |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.613 | 0.624 | 0.477 | 0.287 | 0.184 | 0.632 | 0.626 | 5427 | 6823 | 76.3 MB |
| 2 | 1.474 | 0.862 | 0.757 | 0.295 | 0.203 | 0.452 | 0.865 | 6530 | 8496 | 80.1 MB |
| 4 | 1.245 | 1.527 | 0.956 | 0.310 | 0.184 | 0.405 | 1.534 | 8714 | 11788 | 86.3 MB |
| 8 | 1.213 | **2.951** | **1.606** | 0.287 | 0.193 | 0.429 | 2.962 | 11908 | 15932 | 96.3 MB |

**读法**：check 线程时间 ×4.73、emit ×3.37，而 parse ×1.00、bind ×1.05；进程分配只 +26%（76.3→96.3 MB），GC 暂停 0.062→0.135 s。即 **多出来的时间不是在分配/GC 上，是在共享结构上的重复计算**。`partitionSum / checkPool = 6.9×`——并行效率接近 16 物理核的可达上限，墙钟却在 c4→c8 纹丝不动（1.245→1.213）。

### 3.3 对照（官方口径）

| 夹具 | 形态 | Check(sum) c1 → c8 | 结论 |
| --- | --- | --- | --- |
| `tiny512` | 512 个**互不导入**的小文件 | 0.152 → 0.872（**×5.7**），check 分配 ×6.7 | 无跨文件导入也重复 ⇒ 重复来自**每 checker 的全局/lib 作用域解析**，不是跨文件解析 |
| `dtsheavy` | 150 个 `.d.ts`（`skipLibCheck` 下被跳过） | 0.152 → 0.146（×1.0） | 跳过检查的文件不产生重复 |
| `huge` | 单文件 32k 字面量 | 2.87 → 2.97（×1.0） | 单文件不可分，纯关键路径 |

### 3.4 产品 GC 配置复核（Server GC，无 env 覆盖，medium 官方口径）

| c | Total | Check(sum) | Emit(sum) | Parse | Bind | checkPool | partitionSum | Types | CLR alloc |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.393 | 0.520 | 0.444 | 0.216 | 0.143 | 0.526 | 0.521 | 5427 | 76.1 MB |
| 8 | 0.907 | **1.761** | **1.210** | 0.210 | 0.147 | 0.268 | 1.770 | 11908 | 96.1 MB |

形状完全一致（check ×3.39、emit ×2.73、parse/bind 持平、Types ×2.19），绝对时间更低（Server GC 生效）。**结论不依赖 GC 形态。**

### 3.5 单文件关键路径（夹具默认口径）

| 载体 | 规模 | 独占分区检查耗时 | 该口径下 Total |
| --- | --- | --- | --- |
| `lib.dom.d.ts` | 110,506 节点 / 2.35 MB（次大文件 10,321 节点） | 1.45~1.50 s（= medium check 墙钟） | medium 2.56 |
| `big.ts` | 单文件 16,384 个对象字面量 | 2.87 s | huge 5.03 |

分区器实据（临时 env 闸门 dump，已回退）：`lib.dom.d.ts` 权重 134,000 恰等于 `limit`，**独占一个 checker**，任何文件都再也加不进它；权重模型本身与检查成本近似成比例（lib.dom ≈ 92k 权重/s，源码文件 ≈ 100k 权重/s），所以这不是「权重算错」，而是**真的有一个文件太大、且单文件不可切**。

---

## 4. 判定

| 候选 | 判定 | 反证数据 |
| --- | --- | --- |
| (a) 每 checker 固定构造成本 | **排除** | `checkConstruct` 墙钟 ≤55 ms；`constructEach` 8 checker 求和仅 0.154 s；`globalMerge` 求和 0.19 s |
| (b) 内存带宽 / GC 饱和 | **排除** | 进程分配 +26%（76→96 MB）、GC 暂停 +0.07 s，而 check 线程时间 ×3.4；并行效率已 6.6~6.9× |
| (c) 并行区后的串行尾巴 | **排除** | `diagnosticsTotal − checkPool` = 20~50 ms；`globalDiag`/`fileDiag`/`affected` ≈ 0 |
| **(d) 每 checker 重复派生共享结构** | **成立（首位）** | check CPU ×3.39~4.73、emit ×2.73~3.37，parse/bind ×1.0；`tiny512` 无导入也 ×5.7 |
| **(e) 单文件关键路径** | **成立（次位，口径相关）** | `pMax ≈ checkPool`；`lib.dom.d.ts` / `big.ts` 独占分区 |

**机理（(d)）**：`CheckerSymbols.InitializeAsync` 把全部文件的全局符号合进**每个** checker 自己的作用域，核心 lib 类型（`GlobalTypes`）也在每个 checker 里独立解析；检查期第一次用到某全局/跨文件类型时，每个 checker 各自重新解析一遍。文件越便宜（tiny512），这个「每 checker 固定启动税」占比越高（es5 口径实测约 +0.10 s/checker；medium 因跨文件类型再叠加，约 +0.33 s/checker）。这解释了 `CheckerPool.cs` 注释里「checker-local caches make extra checkers pay off only up to a point」并给出了定量。

---

## 5. 工作项

### L1 去重 checker 派生状态（首位，可测，最高预期）

- **目标**：让并行效率从「净 1.96×」回到「接近 6.6×」。medium 官方口径 check 墙钟 0.268 → 0.10~0.15 s，Total 0.907 → 0.75~0.80 s（−13~17%）；同时对**两个口径**都成立（(d) 与 (e) 无关）。附带 −25% Types、更小 GC 堆。
- **候选路径**（按风险从低到高）：
  1. **共享只读派生缓存**：把每 checker 惰性解析的全局/lib 类型（`GlobalTypes` 表、`CheckerSymbols` 合并结果）做成以共享 `Symbol`/`SyntaxNode` 为键的**读穿共享并发缓存**（发布不可变、按需填充）。符号与语法节点在多 checker 间本就共享（checkpoint 已确认），故可行。
  2. **合并全局作用域发布**（原 checkpoint P2-11）：checker 构造只发布一次合并后的全局作用域，其余 checker 只读挂载。
  3. **checker 数下调到拐点（c4）**：CPU 减半、墙钟持平（1.245 vs 1.213）。**低成本但不解决墙钟**，只作 L1 未落地前的止损选项（并需先处理 ledger 表2 对「自适应下调」的既有否决记录）。
- **风险**：checker 状态「独立缓存」是既有契约（`CompilerProgram.Checking.cs` 注释：独立调用方拿独立缓存）——共享必须限定为**不可变派生值的共享**，不能共享可变状态；并发正确性、确定性诊断顺序、`checker-pool`/`checker-program` safety 面需回归。
- **前置**：先补一个「全局/lib 解析落在哪个相位」的细分探针，把 `partition` 里的重复量定位到 `GlobalTypes` 还是 `CheckerSymbols`/跨文件解析。

### L2 去重 emit 派生状态（新晋，量化后第二）

- **证据**：`Emit time (summed)` 0.444→1.210 s（×2.73）、`Alloc emit` 42→278 MB（×6.6，含并行重叠高估）；emit 墙钟约占 c8 Total 的 ~28%。
- **假设**：emit（尤其声明发射）从 check 池借 checker，**借到的往往不是当初检查该文件的 checker**，缓存冷 ⇒ 重新派生；ledger 的「emit 复用诊断期 checker 池」只解决复用、未解决**亲和性**。
- **动作**：先加 emit 侧探针（当前 parse/bind/emit **零探针**），确认重复量落点（transform / print / 声明解析），再做「按文件亲和地绑回原 checker」或共享 L1 的派生缓存。
- **风险**：低（先探针后动工）。

### L3 单文件关键路径（口径相关）

- **3-a 降每节点检查成本（与 r35 W1–W3 合流，改性质为墙钟杠杆）**：靶点 `lib.dom.d.ts`（1.5 s）与 `big.ts`（2.87 s）。每降它 20% ≈ medium 该口径 Total −12%。r35 的成员表/关系快路径/字面量形状结构体化正是这条线；本轮给它们补上了**明确的靶点与度量**。
- **3-b 单文件内并行/切分**：把顶层声明（或字面量数组）分块交给多 checker——TS 自身不做，语义（全局作用域、声明合并、顺序依赖）风险高，**列为待评估，不动工**。
- **口径备注**：3-a 在官方 harness 口径（`skipLibCheck: true`）下收益接近 0；须在真实工程口径下重新确认 `.d.ts` 占比后再定投入。

### L4 createProgram 默认 lib 层固定成本（原 L3）

- **证据**：medium 官方口径 `Config 0.13 + Program 0.21~0.48 s/进程`，其中默认 lib 链（`lib.es2017.full`，30 文件）占主体；对官方 harness 的 23 个小负载，这是**单进程最大固定项**。
- **动作**：预解析+预绑定的 lib 只读产物（内嵌或缓存），进程内零重建。**风险**：产物格式与版本兼容、`lib` 选项变化时的失效判定、与 bytecheck 的一致性。

### L5 微项（合计 <1%）

- M1 关系工具函数内联；M2 成员表枚举器结构体；M3 诊断分组复用数组；M4 扫描器 `SearchValues` 复查；M5 `Utf8String` 哈希缓存点复查；M6 transform 输出缓冲租借；M7 `--listFiles`/统计路径的常见闭包消除。（逐项必须先过 r27「隔离巨文件批次」再谈分配收益。）

---

## 6. 分期与止损

| 期 | 内容 | 预期（官方口径 / 夹具默认口径） | 止损条件 |
| --- | --- | --- | --- |
| P0（**已完成**） | 归因探针 + `--checkers 1/2/4/8` 配对 | 判定 (d)+(e)，输出 §3 矩阵 | — |
| P1 | 全局/lib 解析细分探针 + emit 侧零探针补齐 | 只测不改 | 若重复量 <10% 则 L1/L2 降级 |
| P2 | L1 路径 1（共享只读派生缓存）原型 | 两口径 Total −10~17% | 并发/确定性门禁红即回退；`checker-*` safety 新失败即停 |
| P3 | L2 emit 亲和性修复（探针证实后） | −5~8% | emit 重复量 <10% 则只留探针存档 |
| P4 | L4 lib 预解析产物 | 小负载 −10%（23 负载均值） | 失效判定有一处错即回退 |
| P5 | L3-a 并入 r35 期次执行 | 口径相关 | 见 r35 §6 |
| P6 | L5 微项 | <1% | 任一反向即弃 |

每期提交带该期配对数据；任一期门禁红（逐字节不一致 / safety 新失败 / Release 非 0-0）当期回退，不带病进下一期。

---

## 7. 验收标准

1. 全期完成后：25 夹具逐字节全过、safety 95 flags 失败集合 ⊆ 已知基线、`csharp/` `dotnet build TypeScript.slnx -c Release` = 0 警告 0 错误。
2. **判据（新增，量具在仓内）**：官方口径 medium 的 `partitionSum / checkPool` 从 ~6.9× 的**净收益**（即 Total 比）转为 ≥3×（当前净 1.96×）；check 线程时间 `c8/c1` 从 3.39 收窄到 ≤1.3。
3. **三元契约表（口径锚，不改）**：节点与批次沿用 r28 表——`pkgs/go-v1`（Go 默认）、`pkgs/go-v3`（Go@400）、`pkgs/naot-svr`（C# 优化前）、`epsl-*`（C# 最新）；批次 `bench/AB123..125`，23 负载 × 15 组交替配对；分配侧直接跑产品二进制。**本方案不新增节点、不改批次口径**；新数据只以「同批配对比值」形式并入。真实工程（`packages/typescript`）线按 P1 普查重锚，不预先设数（r34 F1~F5 已证 fixture 外推不可靠）。
4. 墙钟：decision 层配对，medium 行比值 CI 上界 <0.90（即至少 −10% 且显著）。

---

## 8. 与账目（ledger）的关系

- 本方案**新增**：表1 将登记 `phase:` 归因探针族（量具）；表2 新增「按 (d) 重复派生」的**重建议**路径（此前表2 只否决了「自适应下调 checker 数」，未否决去重）；表3 记录「(a)/(b)/(c) 三条并行度假设本轮全部证伪」。
- **明确不做**（延续表2，且本轮数据不予翻案）：GC 配置面调整（单列：Server GC 已启用，`(b)` 已排除，不再讨论 GC 参数）；同步化重写；手写 arena / 全量类型图结构体化；RelationOperation 池（除非先解决布局扰动归因）；**单文件内并行切分**（L3-b，只留评估）。
- 触碰 `TypeRelations`/`CompareAsync` 链的改动（L3-a 涉及），必须先过隔离巨文件批次（r27 教训，表3）。

---

## 9. 未覆盖面与盲区

1. **无真实工程可用**：本检出无 `packages/typescript`，所有数字来自自建夹具；§3 的两个口径差异已证外推危险，真实工程线须在 P1 重锚。
2. **emit 侧零探针**：L2 的「×2.73」是 `Emit time (summed)` 相位级读数，落点（transform/print/声明解析）未拆解；且并行 `Measure` 分配是进程级 delta，会重叠高估（时间不受影响）。
3. **`Alloc * (summed)` 并行重叠**：多 checker 并行时进程级 `GC.GetTotalAllocatedBytes()` delta 相互包含，故 `Alloc check (summed)` 的 ×14 是上界，真值是 `CLR allocated` 的 +26%。**时间口径不受此影响。**
4. **夹具默认口径缺 `skipLibCheck` / `lib`**：与官方 harness 不同源，已在本轮全程标注；建议 P1 一次性把两族夹具的口径差异固化成量具输出字段，避免再误读。
5. `huge` 的 2.87 s 单文件只测了对象字面量形态，(e) 在其它巨文件形态（深层泛型、巨型 union）下未必同量级。

---

## 10. P0 探针补丁（已落地，已过全部门禁）

**改动面（8 文件，+55/−18，全部 diagnostics-only）**：

| 文件 | 改动 |
| --- | --- |
| `Diagnostics/CompilationCapture.cs` | `Begin` 增 `traced` 参数；`Measure(category, traced = true)`；`Statistics()` 收集 `phase:` 前缀域到 `NamedPhases` |
| `Diagnostics/CompilationStatistics.cs` | 新增 `NamedPhases`（时/分配）；`Report` 追加行；`Aggregate` 合并 |
| `Checking/CheckerPool.cs` | `phase:checkConstruct`、`phase:checkPool`、`phase:partition`、`phase:partition#N`、`phase:partitionDiag` |
| `Checking/Checker.Queries.cs` | `phase:constructEach` |
| `Checking/CheckerSymbols.cs` | `phase:globalMerge` |
| `Checking/CheckerEnvironment.cs` | `phase:globalTypes` |
| `Incremental/IncrementalProgram.Diagnostics.cs` | `phase:diagnosticsTotal`、`phase:globalDiag`、`phase:fileDiag`、`phase:affected` |
| （全） | 全部 `traced: false` |

**门禁证据（本轮实测）**：

1. `dotnet build TypeScript.slnx -c Release` → **0 警告 0 错误**。
2. 逐字节产物：`perf-verify --label r37-post2 --compare r37-pre` → **BYTECHECK-OK**（medium/huge/tiny512/dtsheavy/small3/longline 6 夹具，退出码 + stdout + 发射产物哈希全等）。pre 二进制由 `git stash` 后重构建，post 为补丁版。
3. safety：`run-safety-suite.mjs` → **91/93 通过**，失败 `{--program-emit-safety, --checker-relation-context-safety}` ⊆ 文档基线 `{同上, --npm-process-safety}`，`content-mappers` exit 0 → **SUITE-OK**。
4. **过程中一次真实回归（已修）**：首版探针默认写 trace 事件，`Build/End` 落在固定 lane 1，8 checker 并行交错导致 `--tracing-safety` 的「每 lane 内嵌套」断言失败（out-of-baseline）。修法是给并行归因域走 `traced: false`（只记时/分配，不发事件），复跑回到 91/93。**教训已记入 §10 与 L1 风险**：凡跨 await 的并行域，一律不得往 trace 默认 lane 发事件。
5. 探针仅在 diagnostics 打开时生效（`Measure` 读 `CompilationCapture.Current`），普通构建一次 AsyncLocal 读 + 一次比较，可忽略。
