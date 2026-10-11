# r27 报告：S 层重数、RelationOperation 池的实测否决与成员表列表租借（2026-10-11）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-11 ｜ 轮次: r27 ｜ 主题: s-layer-recount-operation-pool-rejected-list-rental-kept
> 涉及 git 节点: `9bd18ba5e3`（r26，工作树基线）/ 本轮提交
> 产品: `pkgs/r27d/lib/tsc.exe`（最终形态）；中间判别品 `pkgs/r27`（全集）/`r27b`（仅 Filter）/`r27c`（仅 Operation 池）保留备查
> 数据来源: 源码级重数；5 个 AOT 产品的隔离巨文件批次（AB116~AB120）+ 全负载 AB121；真实工程/巨文件交错确定性分配（各 3/2 组）；GC 停顿配对；25 夹具逐字节；95 safety flags
> 关联: `docs/csharp-perf-report-r26.md`（S 层立项与前置）、`docs/csharp-perf-plan-r22.md`（S 层定义）

---

## 0. 本轮结论

| 指标（产品 AOT，确定性分配） | r26 | **r27d** | 变化 |
| --- | ---: | ---: | ---: |
| 真实工程 CLR 总分配（291 文件，交错 3 组） | 822,423,760 | **811,532,512** | **−10,891,248 B（−10.39 MiB，−1.33%）** |
| 巨文件 CLR 总分配（2 组） | 390.50 MB | 387.08 MB | −3.42 MiB（−0.88%） |
| GC 停顿（真实工程，3 组中位） | 0.247 s | 0.206 s | −0.041 s（三对全部同向，方向性） |
| 对优化前基线累计 | −4.5% | **−6.3%**（866.0 → 811.5 MB，对 Go ~155 MiB 约 x5.2） | — |

**路线裁决**：S 层按 r26 的裁决执行完毕后**关闭**——重数证明其可回收量只有 ~11-14 MB（r25 的 60~120 MB 上界被源码定界推翻），旗舰项 RelationOperation 池化实测**墙钟回归被否决**（见 §2），次旗舰列表租借保留并贡献了本轮全部收益。S 层之后，分配侧的下一项（`members.Values.ToArray()` ×3，约 3.9 MB）已低于投入线。

**诚实的负结果（本轮最重要的知识增量）**：一个生命周期完美匹配（每次顶层查询一个）、重置清单完备（5 字段）、尺寸合理（~96 B）的对象池，在唯一高强度工作负载上稳定回归 2~3% 墙钟（三个独立批次重现）。分配收益（−4.3 MiB）与墙钟代价完全不成比例，机制指向 AOT 对关系调用链的内联/布局扰动——这是本战役第三个布局敏感样本（前两个：r12 的 CoreCLR/AOT 差异、r20 的 avx512 噪声）。**教训升级为规则：任何触碰关系调用链的改动，必须先过隔离巨文件批次再谈分配收益。**

---

## 1. 重数：S 层的真实可回收量（源码定界）

对 r22 路线图 S 层三项逐一以 r26 探针口径重数：

| 项 | r22 估计 | 源码定界结果 | 裁决 |
| --- | --- | --- | --- |
| S1 `RelationOperation` 池化 | 49,069 次 | 3 个构造点、~96 B/次 ≈ **4.3~4.7 MB**；可变状态全集 = kind/session/reportErrors/Explanation/suppressed | 实施 → **实测否决**（§2） |
| S2 泛型关系键 `List<Part>` + `Dictionary<Type,int>` | 1,218 次 | `parts` 列表是键的载荷、随关系缓存整编译期存活——**不可池化** | 否决（前提不成立） |
| S3a `SetCoreAsync` 双 `List<Symbol>`（r26 新识别） | — | 60,972 次 × 2 列表 ≈ **6~8 MB** | 实施 → **保留**（§3） |
| S3b `members.Values.ToArray()` ×3 | — | ≈ 3.9 MB，需逐点审计 `IndexInfosAsync` 的保留语义 | 低于投入线，不实施 |
| recStamp 25.3 MB / resolveMembers 78 MB | — | 内部是保留结构（成员表、类型对象）与异步机制本体，无池化面 | 确认不可回收 |

**结论：S 层全部可回收面 ≈ 11~14 MB（1.3~1.7%），r25 的 60~120 MB 上界不成立。** recStamp 与 resolveMembers 的独占字节是数据结构本体，不是临时容器。

## 2. S1 RelationOperation 池：实施、测量、否决（完整记录）

**实施**：照 `RelationSession` 的现成租借模式（`RentSession`/`ReturnSession`）给 `RelationOperation` 加了按 `RelationKind` 的可用栈 + `Reset(kind, session, reportErrors)`（五字段重置清单，诊断套件覆盖 Explanation/suppressed 的漏重置风险）。三个构造点全部切换。

**测量与二分**（隔离巨文件批次，全部控制组有效 ratio 0.975~1.009）：

| 变体 | 巨文件墙钟 | 批次 |
| --- | ---: | --- |
| r27 全集（Operation 池 + 列表租借 + Filter） | **+2.45% / +3.04%** | AB116 / AB117（两次重现，行内 spread 0.03~0.05） |
| r27b 仅 Filter | +0.65%（噪声） | AB118 |
| r27c 仅 Operation 池 + Filter | **+2.27%** | AB119 → **元凶锁定** |
| r27d 仅列表租借 + Filter | **−1.02%** | AB120 |

cpuMs 同向移动（AB116 huge-file 1062.5 → 1125 ms）排除了负载伪影。机制上最可能是改写 `RelationOperation` 类结构（主构造函数参数集变化）扰动了 AOT 对 `CompareAsync → CompareCoreInnerAsync → host.RelatedAsync` 链的内联决策；无法进一步归因（EventPipe 在本机 .NET 11 RC 不可用），按经验裁决放弃。

**处置**：`TypeRelations.cs` 与测试适配整体还原到 r26 形态（保布局也保语义），池代码不留产品。中间品 `pkgs/r27/r27b/r27c` 与 `built/r27-bytecheck.mjs` 保留供复核。

## 3. S3a 成员表列表租借：保留

`SetCoreAsync` 的 declared/inherited 两个 `List<Symbol>` 改为按 `StructuredMembers`（每 checker 一份）的 LIFO 栈租借：嵌套安全（`NamedAsync` 的别名解析可重入成员查找，嵌套调用租到另一对）、异常自愈（租时 Clear 而非还时）、容量跨调用保留。

帧级落点：`setMembers` 独占 16.45 → 6.64 MB（**−60%**）。过程级：真实工程 −10.39 MiB、巨文件 −3.42 MiB。墙钟：巨文件两批次符号相反（−1.02% / +1.73%，控制组均有效）→ 效应不可解析，按惯例不宣称；checkers-1/checkers-8 双双 −1.1%（同批 suggestive，不显著）。

GC 停顿配对（真实工程 3 组）：r26 中位 0.247 s → r27d 0.206 s，三对全部同向下降。这是 r26 提出的"停顿通道"假设的第一个方向性支持（−1.3% 分配 → −17% 相对停顿），但样本小（3 对）、墙钟批次未解析，**只记方向性观察，不立结论**。

## 4. M1 `Filter` 双遍化（随本轮顺带）

`TypeAlgebra.Filter` 的 `Where(predicate).ToArray()` 改为计数+直填两遍（省枚举器；谓词必须纯函数已注释注明，唯一调用点是旗标测试）。r27b（仅此项）巨文件 +0.65% 噪声、逐字节 25/25 通过。

## 5. 验证门禁（最终形态 r27d）

| 门禁 | 结果 |
| --- | --- |
| 构建 | Release 0 警告 0 错误；测试工程重建 0/0（`TypeRelations` 还原后无测试适配残留） |
| 确定性分配 | 真实工程 −10.39 MiB（−1.33%），两侧带宽 102/388 KB 比变化小两个数量级；巨文件 −3.42 MiB；`LinkStore creates` 464,301 两侧一致 |
| 逐字节一致 | `built/r27d-bytecheck.mjs`（r26 ↔ r27d）**25/25** |
| safety 套件 | 95 flags **90 通过 / 5 失败**，与 r22/r23/r26 已知基线集合逐项相同（npm-process 为已知环境态波动） |
| 墙钟 | AB120（巨文件）−1.02% / AB121（7 负载）−1.2%~+1.7% 混合且符号不稳定 → 全部按噪声处理，不宣称墙钟 |
| 停顿 | 真实工程 3 组方向性下降（0.247 → 0.206 s 中位），只记观察 |

## 6. 下一步

1. **host-paths 归因**（r25 阶段 3，对 Go x1.87 两代稳定）：探针拆诊断子帧，是分配侧关闭后唯一未开的方向。
2. NativeAOT GC 堆数/区域开关检索（需先按 P0 #4 查证存在性，r18/r20 未覆盖此旋钮）。
3. 245 项容器候选按探针频度分诊（每轮固定队列，本轮已消化 2 项）。
4. 维持不做：R 层同步化、AST arena、跨 checker 缓存共享、AVX/裁剪开关；**新增：RelationOperation 池（r27 实测否决，除非先解决布局扰动问题）**。

## 7. 工作树状态

- 产品改动 2 文件：`Checking/StructuredMembers.cs`（列表租借）、`Checking/TypeAlgebra.cs`（Filter 双遍）。
- `TypeRelations.cs` 与测试工程已还原至 r26 形态（Operation 池的否决通过 git checkout 完成，无残留）。
- 工具：`built/r27-bytecheck.mjs` / `built/r27d-bytecheck.mjs`（不跟踪）；测量脚本 `$TEMP/r27*-alloc-run.sh`。

### 进度追踪

| 维度 | 状态 |
| --- | --- |
| 实现进度 | S 层闭环 100%（重数 → 实施 → 二分 → 裁决）；host-paths 0% |
| 验证完成度 | 逐字节 25/25、safety 90/95（基线持平）、分配 3+2 组配对、5 个隔离批次 + 1 个全负载批次、停顿 3 组——全部完成；未验证：Operation 池回归的机制归因（布局扰动为最优假设，无法在本机取样验证） |
