# tsrs（oxc-project/tsrs）源码价值评估（2026-10-21）

> **元数据** ｜ 类型: 外部源码评估 ｜ 日期: 2026-10-21 ｜ 对象: `C:\dev\GitHub\tsrs`（git 03415780，workspace 0.18.0）｜ 关联: `.ai/perf-ledger.md`、`docs/csharp-perf-report-r39-l3a.md`、`docs/csharp-perf-report-r38.md`
> 方法：子代理通读 tsrs 全仓（只读，未构建），主代理核对本仓源码事实后交叉对照。本仓侧断言均带文件行号证据；tsrs 侧数据以其 `notes/`、`docs/`、`bench/RESULTS.md` 为据。

## 1. 结论

1. **tsrs 不是 tsc 的移植，是 typescript-go 的机械 Rust 移植**，算法层刻意与 Go 一致（`Cargo.toml:29` 自述 "unpublished, mechanical Go port"；`docs/PORTING.md:1-14` "Behavior that matches the Go code is correct; improvements are bugs"；跟随 TS 提交 b85298b6 即 7.1.0-dev）。它对本仓的 4.20×~16.87× 墙钟与 2.17×~4.61× 内存优势（`bench/RESULTS.md`，16 vCPU，10 次交错中位）几乎全部来自表示层与内存层，不是可抄的算法。本仓与它之间不存在"抄算法省时间"的通路。
2. **逐项对照后，tsrs 的招牌技术多数在本仓已具备，或已被本仓用自己的数据否决**：零拷贝标识符（`Utf8String` 视图）、indexed access memo（`IndexedTypes.simplified`）、512MB 栈 checker 线程、arena 重写、work stealing、字符串驻留，每一项都有本仓实测结论或 tsrs 自己的否决数据。真正未探测的只有三个缓存族：**infer memo、union front cache、flow walk memo**。
3. **定量判断**：三个缓存族即便全部命中 tsrs 实测的重复率，端到端预期是个位数百分比（L3-a 先例：checkPool 墙钟 −17% 确定性，端到端 25 对 1.006 CI 含 1.0，未动相位占 Total 约 55% 稀释）。它无法单独把对 Go 默认的 ×1.384 拉到 1.0；缩小该差距的主体（每操作 CPU 常数）上限被表示层重构封死，而表示层重构本仓已定价为月级且带布局敏感风险（表2）。三个候选的合理定位是 L3-b（proto.ts 每节点成本）的前置工作，不是独立战役。

## 2. tsrs 的性质与完成度

- 移植链：tsrs → tsgo（TypeScript 7.1-dev 的 Go 实现）→ tsc。算法 = tsgo 的算法；每个移植函数保留 Go 源码行号标记（`docs/CHECKER.md:363`）。
- 完成度：四核心 crate 均真实现，非 stub。scanner 6,617 行 / parser 13,173 / binder 5,423 / checker 108,709（`checker_01..15.rs` 对 Go checker.go 32.6k 行的 15 段）/ printer 15,505 / sourcemap 1,892。`todo!()/unimplemented!()` 在核心 src 零命中（workspace clippy deny）。
- 一致性证据：13,458/13,462 error baselines 与 tsgo 一致、12,779 个 `.types`/`.symbols` baselines 全等、32 万变异体 differential fuzzing 无分歧（`docs/COMPATIBILITY.md`、`docs/RUST.md:158`）。

## 3. tsrs 的性能数字与来源分解

**对比数字**（`bench/RESULTS.md`，2026-10-16，Depot 16 vCPU，10 次交错取中位，PGO+BOLT 构建）：

| 口径 | tsrs vs tsgo |
|---|---|
| 默认 checker 数（tsgo 4 / tsrs 16）墙钟 | 快 4.20×（Compiler）~16.87×（mui-docs）；vscode 13.55×、webpack 10.28× |
| 等线程数 4/8/16 | 快 3.70×~13.65× |
| 峰值内存 | 少 2.17×~4.61×（Compiler 217→100 MiB；mui-docs 7.39→1.60 GiB） |
| watch 重复编辑（vscode） | 38.06×（31 ms vs 1.18 s） |
| 64 vCPU 历史（vscode 10,427 文件，20 次均值） | tsgo 9.79 s/7.52 GiB，tsrs 0.53 s/2.64 GiB |

**来源分解**（其 `notes/` 的逐项记账）：parse 轮指令 18.95→14.54 G（−23.5%，`notes/perf-parse.md`）；PGO −13.5% 指令、Linux BOLT −2.7~3.2% 墙钟、mimalloc v3 3-14% 墙钟；32 位句柄压缩 −14~15% peak memory 但 **+6.5% 指令**（`docs/RUST.md:150`）。

**checker 工作普查**（`workcensus.rs` feature，big/zod 类负载，`notes/perf-checker-algorithms.md`）：indexed access 12.5%、结构比较 10.4%、union 构造 9.3%、relation-to-union 8.9%、同一 generic call 重复推断 ~8%、mapped 3.9~9.3%、flow 3.9%、conditional 2.6~4.7%；关系缓存命中率 48%（big）~59%（mui）。这份普查与本仓自己的探针结论同向：类型级计算量是全部实现的成本主体，语法级特征（节点数/字节/导入数）对其失明（本仓 r39-L3a 对 proto.ts 的实测低估 70 倍）。

## 4. 逐项对照：tsrs 技术 vs 本仓现状

| tsrs 技术（证据） | 本仓现状（证据） | 判断 |
|---|---|---|
| 紧凑标识符：(textIndex, len) 现场切片，私有 monorepo 7.86M/8.15M 个标识符零拷贝（`identifier.rs:1-13`） | **已具备**：`Utf8String` 是 `ReadOnlyMemory<byte>` 视图（`Text/Utf8String.cs:11`），scanner 直接在源缓冲上扫描（`Syntax/Scanner.cs:19` `input = source.Buffer`），`scanner.Value` 原样传入 `factory.NewIdentifier`（`Syntax/Parser.cs:355`） | 无需动作 |
| indexed access memo（普查占比最大的单项 12.5%） | **已具备**：`IndexedTypes.simplified` 全量 memo，含循环占位守卫（`Checking/IndexedTypes.cs:49,311`） | 无需动作 |
| 关系缓存 58-bit 键打包（99.7% 简单形免哈希） | **已具备简单形专用键**：`RelationKey(source,target,intersection)` + `HashCode.Combine(三个 id)`（`Checking/RelationKeys.cs:14-19`）；且本仓 r22 分解已证 checkerRelated 42 MiB 的主体是递归调度本体而非键 | 不建议改打包：键非质量主体，触碰关系调用链有 r27 布局敏感前科（+2.3% 墙钟） |
| flow memo：跨 walk 的 (reference, flowNode) 记忆化，63-67% 步数重访（`flowmemo.rs`） | **部分具备**：环内 `loops` 缓存（`Checking/FlowTypes.cs:83`）+ 每节点入口缓存 `CachedFlowExpressionAsync`（`Checking/Checker.Flow.cs:98`）；跨 walk 的子走查 memo 不存在 | **未探测，候选三** |
| infer memo：顶层 inferTypes walk 记忆化，治 N 对象类型 × M 次调用重复（`infermemo.rs`） | 不存在（`Checking/Checker.Inference.cs` 无 memo 字段） | **未探测，候选一（最优先）** |
| union front cache：2^10 槽直接映射表，键 = 输入句柄按输入序 + reduction mode + alias（`unioncache.rs`） | 不存在；`TypeAlgebra` 只有归约 walk（`Checking/TypeAlgebra.cs:84,158`），无前置表 | **未探测，候选二** |
| 每线程 bump arena + size-class 空闲链表 + checkpoint/rewind | 已否决（表2）：arena 不改对象数；GC 停顿与并行 checker 重叠（no-GC region 定价 −0.9% 低于噪声下限）；结构体化是月级重写带 r27 风险 | 不照搬 |
| 32 位压缩句柄 P<T> + 固定基址 32GiB 预留 + ThinSlice | 同上，且为 Rust 专属（.NET 无 4 字节 niche Option） | 不照搬 |
| 全局字符串驻留 | tsrs 自己测量后拒绝（parse +9% 时间，`docs/RUST.md:164`） | 双向确认不做 |
| 512MB 栈 OS 线程跑 checker | 本仓已实测确定性结论：栈守卫 874,660 次调用零让出，1MB 默认栈与 64MB 结果相同（表3） | 无需动作 |
| work stealing + 重文件语句级拆分（`splitcheck.rs`） | 本仓已实施并全额回退（L3-a：checkPool −17% 确定性，端到端 25 对 1.006；emit 尾部亲和吃掉收益）。tsrs 的 splitcheck 切顶层语句，不解决 proto.ts（单文件内单一巨类型计算） | 已闭 |
| leaf 文件 region / 每文件 emit scratch region | 形态为 noEmit 峰值内存优化；本仓 RSS 非门禁项 | 不照搬 |
| FxHashMap 一切 / SmallVec / PackedMap | .NET `Dictionary` 已等效（无 SipHash 问题）；SmallVec tsrs 标注未试 | 无需动作 |
| PGO / BOLT / mimalloc | 本仓 R2R+动态 PGO 实测慢 2~2.6×（表2，短命进程 warmup 压倒稳态收益）；NativeAOT 形态保持。NativeAOT 静态 PGO 在 .NET 11 的支持情况 **[待查证]**，若支持可作一次性构建形态探针 | 待查证后评估 |
| 扁平符号表（Bun 式） | tsrs 自己否了：−8~9 MB 前端堆换 +0.4~2.5% 单线程指令，PR 147 关闭 | 双向确认不做 |
| 工程纪律：指令数量具（重复性 0.001%）、落地门槛（≥1% 指令 / ≥2% 墙钟×两次发布 / ≥5% 内存；加线程/缓存/阶段重叠需明显余量）、每个缓存的 shadow 校验模式、measured-and-rejected 清单 | 本仓已有等价物（`csharp-perf-method.md` / `perf-budgets.md` / `perf-ledger.md` / 环境闸门探针 TSHARP_*）；唯一缺口是指令计数（EventPipe 在本机 .NET 11 RC 不可用，表3 已记） | 方法论已追平；量具缺口可选补齐（见 §7） |

## 5. 三个未探测候选的展开

三者的共同风险与门禁：必须保持对 tsc 基线的输出等价（25 夹具逐字节门禁 + safety 套件）；TS2589/TS2859 实例化预算与诊断顺序是可观测行为，缓存只能覆盖"没建新类型、没实例化、没诊断"的调用（tsrs 的纯净性条件）；in-progress 标记可复用 `IndexedTypes.simplified` 的循环占位模式；实施时按 r27 纪律先过隔离巨文件批次。三者都是 checker 内缓存，不引入跨 checker 共享，与 L1 被钉死的所有权契约不冲突。

### 5.1 infer memo（最优先）

- tsrs 设计（`checker/infermemo.rs`）：记忆化顶层 `inferTypes` walk 的"输入→写出的 infos"；只存没建任何东西、没实例化、没诊断的 walk；要求目标至少被标记为 long target（短 walk 不进 memo）；`=shadow` 模式重算比对。
- 与本仓最大单文件热点对齐：`src/api/proto.ts` 465 节点 / 4.5KB 占静态权重 0.33%，实测检查 439ms 占 check 成本 23.2%，成本由 500 成员接口的映射类型计算决定（r39-L3a §1）。这正落在 tsrs 普查的"重复推断 ~8% + mapped 3.9~9.3%"家族。
- 前置探针（便宜，不动产品代码）：环境闸门统计 infer walk 的重复率，跑真实工程夹具。重复率 >10% 才立项原型。

### 5.2 union front cache

- tsrs 设计（`checker/unioncache.rs`）：`getUnionType` 前的 2^10 槽 × 40B 直接映射表；键 = 输入句柄按输入序 + reduction mode + alias 信息；精确性靠"只存纯净调用"；每次命中在 shadow 模式下重算并 panic 比对。
- 本仓形态：`TypeAlgebra` 的 union 归约（`TypeAlgebra.cs:84,158`）带 Origin/Alias 双轨（r35 W1 改过此处），纯净性判定要比 tsgo 侧更仔细：带 alias 的归约读符号表，属可变状态。
- 前置探针：union 入口调用的重复率与 alias 占比。

### 5.3 flow walk memo

- tsrs 设计（`checker/flowmemo.rs`）：跨 walk 持久化 `getTypeAtFlowNode` 子走查结果；序列号污点追踪（loop label、in-progress 解析、reduce label、instantiation 计数器触碰都会污染相关帧）；背景数据是 63-67% 的步数在重访已走过的 (reference, flow node)。
- 本仓障碍：flow walk 是 `ValueTask` 异步状态机 + `FlowState` 池化（`FlowTypes.cs:88-97`），跨 await 边界做 memo 比 Rust 同步 walk 难；入口级缓存（`CachedFlowExpressionAsync`）已覆盖一部分重访。
- 预期管理：即便命中率匹配 tsrs，flow 家族在其普查仅占 3.9%，折算端到端大概率低于本仓 1.1% 噪声下限。列为探针后评估，不预设收益。

## 6. 定量判断：对缩小对 Go 差距的贡献上限

- 现状锚点：重负载对 Go 默认 ×1.384（r38，五次全量测量 ×1.384~1.423）；剩余差距主体是每操作 CPU 常数，集中在关系引擎族与 typeFromNode 族，两族分别被表3 勿重开（布局敏感）与所有权契约钉死。
- tsrs 的 4~17× 的不可迁移分解：Rust 无 GC（本仓 Server GC 停顿已证与并行 checker 重叠）；无 async 状态机（本仓经典异步税已由 Runtime Async V2 全量拿走，表2）；arena + 压缩指针（本仓已定价否决）；默认 16 checker（本仓 >8 无收益已证，且 work stealing 已回退）；PGO/BOLT（.NET 侧 R2R+PGO 实测更慢，BOLT 无 .NET 对应物）。
- 现实预期：三个缓存族全部兑现，端到端个位数百分比；按 L3-a 稀释先例折算，check 相位 5% ≈ 端到端 2%。**结论是不足以独立缩小 ×1.384 的主体，但作为 L3-b（proto.ts 每节点成本，450ms 级）的前置归因工作是合理的投入。**

## 7. 建议动作（最小集，均不动产品代码）

1. **探针一（最优先）**：infer walk 重复率，夹具 = 真实工程（含 proto.ts）。>10% 则立项 infer memo 原型：shadow 模式 + 隔离巨文件批次 + bytecheck 25 夹具 + safety。
2. **探针二**：union 入口重复率与 alias 占比，判定 front cache 的纯净性成本。
3. **探针三**：flow (reference, flowNode) 跨 walk 重访率，验证 63-67% 在本仓是否成立。
4. **可选量具补齐**：tsrs 与本仓之间唯一的代差是指令计数确定性（0.001% vs 本仓 1.1% 墙钟噪声下限）。本机 EventPipe 阻塞；可评估在 CI Linux runner 上用 `perf stat` 测 NativeAOT 产物的指令数， CodSpeed 式 CPU 模拟是另一选项。这是工具投资，不是产品优化。
5. **明确不做**：arena / 句柄压缩 / ThinSlice / 字符串驻留 / 扁平符号表 / 512MB 栈 / work stealing 重开，各自都有本仓或 tsrs 的否决数据，勿重复提案。

## 8. 版本对齐分析（2026-10-21 补，GitHub API 实测）

### 8.1 当前项目锚定的 TS 版本

- `csharp/version.txt` = **7.1.0-dev**（上游 `6ed638d3a5` 处同值，contents API base64 解出 `7.1.0-dev`）。这是 TypeScript 7 原生移植线（Go 版 checker 时代），不是 tsc 5.x 线。
- 锚点提交：microsoft/TypeScript `6ed638d3a5`（2026-10-04，消息 "Benchmark C# runtime and GC configurations against Go"）。C# 优化前基线（本仓 init `2aaad02`）的树与该提交的 `csharp/` 目录逐字节相同，Go 参考亦由该提交构建，两侧同源同时本，对比方法论成立（r38 §4）。
- **结构事实**：`csharp/` 目录不在 mainline。main tip（`538671d3`，2026-10-21）与 `b85298b6` 处的 contents 查询均 404，默认分支上 `commits?path=csharp` 零命中。即 C# 移植只存在于一条侧分支，本仓从该线起步；mainline 只有 Go 移植。

### 8.2 tsrs 的锚点与本仓的关系

- tsrs 钉 `b85298b6`（2026-09-29，PR #64543 "Enforce exclusive checker acquisition"），该提交在 mainline 上（`compare b85298b6...main` 为 ahead/behind 0），main 已领先它 118 个提交。
- 两锚点分叉：`compare 6ed638d3a5...b85298b6` 状态 diverged，本仓线领先 159 提交、落后 72 提交。本仓锚点日期（10-04）晚于 tsrs 锚点（09-29），但两者不是同一线的先后关系。

### 8.3 能与 7.1.0-dev 或 tsrs 提交级对齐吗

- 版本号意义上已经对齐：两边都是 7.1.0-dev。
- 提交级对齐的实质是把 18.1 万行移植（产品源码实测 180,850 行，其中 checker 65,504 行、emit 18,561 行）从侧分支线搬到 mainline 线。障碍是 mainline 没有 csharp 目录可同步，这等于从 tsgo/tsc 重新移植，不是 rebase。
- 追平代价不止移植：r38 建立的全部锚点作废（Go 参考 sha256 `5e46cd5d`、基线二进制、对 Go ×1.384 表、25 夹具期望输出、safety 基线），需一次完整的 r38 级三侧重建（23 负载 × 15 对）。
- 且 mainline 三周前进 118 提交（约每周 40），追平一个点立刻出现新 delta，对齐是 treadmill 不是里程碑。
- **结论：不做提交级重对齐。** 锚点冻结是战役资产（r38 的 ×1.384 与 +46.3% 全部挂在它上面）；重新锚定只应发生在阶段边界或上游侧分支实质前进时，届时按 r38 方法论整轮重建。

### 8.4 「统一起跑线」的正确最小形态

- **该统一的**：同机同协议（已做到）；负载集（见下）；确定性量具（唯一代差，见 8.5）。
- **不该统一的**：checker 默认数。tsrs 默认 16（机器规则 clamp(max(cores/2, min(cores,16)), 4, 32)），本仓在 16C/32T 上实测 8 最优、>8 时 medium +5.5%（全量重读轮证伪行），默认数是实现与机器相关的实测结论，不是可统一的参数。CLI 与口径细节同理。
- **负载集补充**：现有 5 夹具（真实工程/medium/huge/tiny512/dtsheavy）全是 TypeScript 仓库自身形状（自寄、巨型单文件、d.ts 重、小文件海）。建议补 2~3 个真实应用形状：DOM 重的 .d.ts 大图工程、多中等文件深泛型推断工程。生成器 `csharp/tools/perf-fixtures.mjs` 已具备，成本低；直接服务「新负载类型」触发器，并给类型级成本结论第二个证据源。

### 8.5 PGO 查证结果（2026-10-21，Microsoft Learn 检索）

- 检索未发现 .NET NativeAOT 的 PGO 支持。动态 PGO（`DOTNET_TieredPGO`）是 JIT 机制，对 AOT 无效；MSVC PGO 只作用于原生 C++ 编译单元，ILC 产物不在其范围。
- 本仓已用 `OptimizationPreference=Speed`（表1 工程配置行）。R2R+动态 PGO 已实测慢 2~2.6×（表2）。
- **结论：tsrs 的 PGO −13.5% 指令收益在 .NET 侧无对应物，此项关闭**，勿再提案。
