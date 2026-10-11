# r26 报告：Serena 符号级审计、热路径机械清理与 GC 停顿占比的首测（2026-10-11）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-11 ｜ 轮次: r26 ｜ 主题: serena-audit-asynclocal-gating-and-first-gc-pause-measurement
> 涉及 git 节点: `5b282f4261`（r25 计划，工作树基线）/ 本轮提交
> 产品: `pkgs/r26/lib/tsc.exe` sha256 `c31470aed3e92080…`；对照 `pkgs/r23`（`0b628de5d71e48f0…`）
> 数据来源: Serena 符号级全源码审计；25 夹具逐字节；95 safety flags；真实工程/巨文件交错确定性分配（各 3/2 组）；**新增 GC 停顿读数（`GC.GetTotalPauseDuration()`）**；AB115 配对批次（7 负载 × 15 对）
> 关联: `docs/csharp-perf-plan-r25.md`（本轮执行其阶段 0 与阶段 1）

---

## 0. 本轮结论

| 维度 | 结果 |
| --- | --- |
| 真实工程 CLR 总分配（291 文件，交错 3 组） | r23 中位 827,027,736 → r26 中位 **822,334,752 B（−4.48 MiB，−0.57%）**；两侧带宽 93.8 KB / 185.1 KB，比变化小两个数量级 |
| **GC 停顿占墙钟（首次测量，r25 阶段 0）** | 默认 8-checker 形态 **0.223 s / 1.098 s ≈ 20.3%**；`--checkers 1` 形态 **0.208 s / 2.09 s ≈ 10.0%**；巨文件 ≈ 14%。含进程启动地板（空转小编译实测 0.034 s），扣减后编译期归属仍为 8%~16% |
| 路线裁决 | **r25 决策规则命中"高于 10%"分支：S 层池化重新立项**。r21~r23 的"分配侧收工"结论只看过分配字节、从未看过停顿，本轮予以撤销 |
| 墙钟 | AB115（r26 vs r23，7 负载 × 15 对）全部落在噪声内（tiny-files −3.6%、checkers-1 −1.2% 偏正向但不显著）。按惯例只记分配改善，不宣称墙钟收益 |
| 语义门禁 | 逐字节 **25/25**；safety **90/95**（5 失败与 r22/r23 已知基线集合逐项相同）；Release 构建 0 警告 0 错误 |

---

## 1. Serena 审计新增发现（超出 r25 手工阅读的部分）

1. **AsyncLocal 读者全量清单（13 处）**，热路径 8 处、冷路径 5 处。r25 未列的两处：`TypeContext.cs:80`（实为每 checker 一次，冷，排除出修复清单）与 `SyntaxRewriter.cs:37` 的 `InTransformPhase` 本身（`transformDepth` 的 AsyncLocal 读，每改写节点一次，热）。
2. **五大分配热点帧（resolveMembers 78.8 / typeFromNode 37.2 / symbolTypesGet 32.8 / variableType 20.7 / setMembers 16.5 MB）帧入口无同族容器缺陷**，独占分配是弥散的合法类型构造。r21~r23 对这几帧的判断在帧入口层面成立；本轮收益来自实例化路径的双重复制（见 §2.2）。
3. **同族容器全量扫描**（`built/scan-work-containers.mjs`）：`Checking/` 等 692 处容器构造中 245 处为"入口段无条件构造"形状（r13/r23 两次复发的家族）。本轮按探针热度确认并修复 2 处（§2.4）；245 项清单留作后续轮次按频度分诊的工作队列。`RelationKeys.GenericAsync` 的栈构造属 r14 已证伪方向（0.2%），不重试。

---

## 2. 落地改动（12 文件）

### 2.1 热路径 AsyncLocal 读改静态门控（墙钟侧卫生，8 站点）

`ProbesEnabled` 为假时 `Current` 必为 null（无任何活动捕获），等价改写。正常编译不再读 AsyncLocal：

| 站点 | 频度 | 改法 |
| --- | --- | --- |
| `Checking/Links.cs:26` | 每首次建链（464,301 次/轮） | `CountLinkCreate()` |
| `Checking/Checker.Source.cs:111` | **每个被检查节点** | `ProbesEnabled ? Current : null` |
| `Emission/EmitContext.cs` ×5 | 每节点数据/每注释 | `CountNodeData/CountCommentAdd/CountCommentSet()` |
| `Emission/SyntaxRewriter.cs:37` | 每改写节点（两次 AsyncLocal） | `ProbesEnabled && InTransformPhase ? Current : null` |

新增 `CompilationCapture.Count*()` 静态门控计数器（`Mark()` 同款模式）。r25 §3.1 指出的 `docs/csharp-perf-plan-r06.md:286` 文档与代码矛盾就此闭合：现在该声明为真。墙钟收益与 AB115 结果一致地落在噪声内（r25 的 0.5%~2% 估计偏乐观，实际 AsyncLocal 读在 .NET 11 上更便宜）。

### 2.2 实例化路径免复制

- `TypeMapper.Create(IReadOnlyList<Type>, IReadOnlyList<Type>)` 新重载：`Type[]`/`List<Type>` 直接取 span，免掉调用侧 `ToArray()`。原调用侧双 ToArray 中，1 参 Simple 分支的两份数组是纯浪费，Direct 分支也省一半。
- `TupleTypes.cs:107` / `TypeParameterScopes.cs:140`：`AllTypeParameters` 从 `Array.AsReadOnly` 包装改为裸 `Type[]`（省每类型一个包装对象，且让上面的 span 快路径命中）。
- `StructuredMembers.cs:76`：this 参数追加数组显式定型为 `Type[]`。

帧级落点（同会话交错）：resolveMembers −0.46 MiB、typeFromNode −0.50 MiB、symbolTypesGet −0.55 MiB；setMembers 持平（本轮未动 `SetCoreAsync`）。

### 2.3 GC 停顿采集（测量基础设施）

`CompilationStatistics` 新增 `GC pause time (process)` 行（`GC.GetTotalPauseDuration()`，进程累计口径；聚合取 max，避免多工程重叠重复计数）。r25 阶段 0 据此落地。

### 2.4 同族容器快路径（r13/r23 家族，第 3、4 例）

- `Signatures.NonCircularReturnAsync`：无 composite 的常见输入直接做环判定，不建 `Stack<Signature>`（保留 `ResolvedReturnType is null` 前置，与原循环语义逐项等价）。
- `TypeKeys.GenericReducibleAsync`：非交集且非含交集联合的输入直接返回 false，不建 `Stack<Type>`。

### 2.5 扫描脚本

`built/scan-work-containers.mjs`（不跟踪，与 bytecheck 脚本同目录同惯例）：词法识别入口段容器构造，排除 `??=` 惰性与 `Interlocked.Exchange` 池化两型良好形态，输出候选清单。是否升格为 CI 门禁（带 mutation probe）留待下轮决定承载物位置。

---

## 3. GC 停顿占比：方法与数字

**方法**：真实工程夹具（`packages/typescript` 原位、`--customConditions @typescript/source --noEmit`、每跑前删 tsbuildinfo——composite 项目 `--noEmit` 仍写 buildinfo，不删则下一轮变增量，这是本轮踩过两次的坑）交错配对，从 `--extendedDiagnostics` 统计读 `GC pause time (process)` 与 `Total time`。

| 形态 | 停顿（s） | 墙钟（s） | 占比 |
| --- | ---: | ---: | ---: |
| r26 默认（8 checker，3 组） | 0.198 / 0.223 / 0.242 | 1.058 / 1.098 / 1.112 | 中位 **20.3%** |
| r26 `--checkers 1`（2 组） | 0.191 / 0.224 | 2.076 / 2.105 | **10.0%** |
| r26 巨文件（2 组，前一脚本口径） | 0.103 / 0.106 | 0.711 / 0.784 | ≈14% |
| 空转小编译（启动地板参照） | 0.034 | 0.187 | — |

扣启动地板（约 0.03~0.06 s）后，编译期归属停顿：默认形态约 15%、单 checker 约 8%~9%。两种形态都越过或贴近 r25 定的 10% 决策线，且方向一致：**停顿随并行度提高在墙钟中的占比上升**（8 checker 形态墙钟短、分配率不变，STW 窗口直接冻结全部检查线程）。

交叉证据：AB114 既有数据里单 checker 形态墙钟−CPU 仅 +15 ms 且 Server GC 停顿期间 GC 线程本身在烧 CPU，符号无法定论——这正是必须直接测停顿时长的原因，本轮补上了。

**对路线的影响**：
1. r22 路线图 S 层（池化）由"跳过"改为**重新立项**。注意两个前置：① r22 实施轮自己的复价是 11 MB 上限（按 r14 计数）、r25 估计是 60~120 MB，两数矛盾，r27 动工前必须先用本轮已有的探针口径重数一次；② 池化的真收益现在有两条兑现通道（停顿减少 + 局部性），不是 r22 当时假设的纯内存项。
2. 更广的推论：任何把 822 MB 摊薄的工作现在都有墙钟贴现，"分配侧收工"表述作废；但散帧本体仍是合法数据结构，下一刀应该切在**可复用临时对象**（S 层目标），不是继续逐帧抠。

---

## 4. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | Release 0 警告 0 错误；AOT 发布成功（`pkgs/r26`，sha256 `c31470aed3e92080…`） |
| 确定性分配 | 真实工程 827.03 → 822.33 MB（−4.48 MiB，−0.57%）；巨文件 ±8.7 KB（噪声，该负载无实例化，预期持平） |
| 逐字节一致 | `built/r26-bytecheck.mjs`（r23 ↔ r26）：18 合成形状 + 5 staged + 巨文件 + 真实工程 **25/25** |
| safety 套件 | 95 flags **90 通过 / 5 失败**，与 r22/r23 逐项相同（checker-relation-context / program-emit / developer+lsp-native-watch 需目录参数 / npm-process 环境态） |
| 墙钟 | AB115（7 负载 × 15 对，逐行 spread ≤ 0.30 批次全有效）：中位差 −3.6%（tiny-files）~ +2.6%（host-paths），全部不显著 |
| 计数不变量 | LinkStore creates 464,301 两侧一致；r26 三组 links 完全相同 |

---

## 5. 下一步（按优先级）

1. **r27 = S 层池化重数与实施**：先用本轮探针口径重数 RelationOperation / mappingScratch / 成员表临时字典的可复用量，裁决 11 MB 与 60~120 MB 之争；若 ≥ 60 MB 则按 checker 级暂存池实施（r25 §5.3 设计），门禁带停顿对比（现在有 `GC pause time` 行可直接 A/B）。
2. 245 项容器候选按频度分诊（探针 Own calls 加权），下一批确认热点同轮修复。
3. host-paths（对 Go x1.87）探针归因，r25 阶段 3 仍开放。
4. 维持不做：R 层同步化、AST arena、跨 checker 缓存共享、AVX/裁剪开关（依据见 `csharp-perf-state-r22` 记忆与 r24 定价）。

---

## 6. 工作树状态

- 行为改动 12 文件：`Checking/`（Checker.Source、Links、Signatures、StructuredMembers、TupleTypes、TypeKeys、TypeMapper、TypeParameterScopes）、`Diagnostics/`（CompilationCapture、CompilationStatistics）、`Emission/`（EmitContext、SyntaxRewriter）。
- 纯诊断新增：GC 停顿行、`Count*()` 门控计数器。
- 工具：`built/r26-bytecheck.mjs`、`built/scan-work-containers.mjs`（均不跟踪）。
- 夹具污染已清理（本轮测量产生的 `tsconfig.tsbuildinfo` 已删，`git status` 仅剩 12 个预期修改）。

### 进度追踪

| 维度 | 状态 |
| --- | --- |
| 实现进度 | r26 改动集 100%（审计 → 实施 → 测量 → 报告闭环）；S 层池化 0%（r27 立项） |
| 验证完成度 | 逐字节 25/25、safety 90/95（基线持平）、分配配对 3+2 组、AB115 7 负载、GC 停顿 3+2+2 组——全部完成；未验证项：AsyncLocal 门控的单点墙钟归因（落在批次噪声内，无法归因） |
