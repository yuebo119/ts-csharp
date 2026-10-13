# r35 报告：.NET 原生形态重写第 0~2 期（2026-10-13）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-13 ｜ 轮次: r35（第 0、1、2 期安全切片已落地；W3 核心与 W4/W5 带前置数据移交后续会话）｜ 主题: dotnet-native-rewrite
> 方案: `docs/csharp-perf-plan-r35-architecture.md`（v2.1）
> 涉及 git 节点: `0d2366fa2f`（第 0 期）/ `0e6152913a`（第 1 期）/ `ba5dc90b95`（第 2 期切片）
> 数据来源: 弹性配对批次 AB140/AB141；隔离配对 AB142~AB145；交错分配测量（3×3，双侧带宽 <0.1%）；--checkers 1 探针归因；25 夹具 bytecheck；95 flags safety

## 1. 结论摘要

三期落地，产物节点 `pkgs/r35p2`：**真实工程全量态分配 998.7 MB（较 r34 锚点 1,001.7 再 −0.29%，累计对基线 −18.3%）、noEmit 态 −0.90%、huge-file −2.96%（两期累计）、medium −0.82%**；墙钟 7 负载配对全部在噪声带内（无显著变化）。门禁全绿（Release 0/0、bytecheck 25/25、safety 91/95 ⊆ 已知基线）。

比数字更重要的两个**测量新知识**：

1. **分配到墙钟弹性不是常数，而是「负载 × 运行时形态」的矩阵**（§2）。产品所在的 AOT 形态在 huge-file 上近线性（1:1.1），medium 并行 1:4.2，串行 1:7.6。旧矛盾（r32 会话内 1:2 vs AOT 表 1:9）就此解决：两个读数都对，只是负载与形态不同。
2. **fixture→真实工程的分配归因完全不同谱系**（§3）：medium 上 62% 在字面量族，真实工程单 checker 的 check 相位里字面量族仅 7.7%，关系引擎族（relationCompare 185 M / checkerRelated 170 M inclusive）主导。W3 的价值集中在 medium/huge-file 夹具族；真实工程侧的字面量收益上限 ~3%。

两处**契约否决**（safety 套件当场抓获，与 r32 M4 同族）：API 边界的 `Array.AsReadOnly` 包装是不可变契约（`module-program-specifiers-safety` 钉死 `IList` 写入必须抛），内部存储的包装才是冗余——45 处去包装与 5 处保留的界线由此划定。

## 2. 弹性测量（第 0 期主交付，AB140/AB141）

方法：丢弃式变体在 `SyntaxNode` 构造注入每节点 224 B 纯幼年垃圾（ThreadStatic 槽换引用保证不可消除且即刻死亡），与基线同批配对 15 对；分配差用诊断运行交错实测。JIT 臂为自包含 coreclr 构建（manifest `runtime: coreclr-validation`）。

| 负载 | 分配差 | AOT 墙钟（CI） | JIT 墙钟（CI） | AOT 弹性 | JIT 弹性 |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium（8 checker） | +20.6% | +4.9%（[−0.2,+11.0]） | +1.9%（[−2.1,+4.3]） | 1:4.2 | 1:10.9 |
| huge-file | +24.0% | **+21.6%（[+18.5,+23.8]）** | +6.8%（[+4.9,+7.6]） | **1:1.1** | 1:3.5 |
| medium-checkers-1 | +20.6% | +2.7%（[−0.5,+7.0]） | +2.2%（[−0.5,+4.2]） | 1:7.6 | 1:9.4 |

**判读**：①方案 §5 判据「弹性 ≥1:4 则 W3 进入两位数期望」在 AOT 形态成立（huge-file 1:1.1、medium 1:4.2），**W3 放行**；②产品是 AOT，AOT 列即战役口径，JIT 一贯更不敏感（1:3.5~1:10.9）——r32 的 1:2 JIT 读数含 CPU 混入（E1/E3 归因风险在方案 v2 已标注）；③huge-file 的高敏感指向其 GC 压力位（366 MB 分配、多 gen0），停顿不与工作重叠的部分在该负载更实质。

方法学坑两枚：`-p:DefineConstants` 不使增量构建失效（第一次变体构建零差，touch 源文件强制重编才生效）；manifest 的 `platformDirectory` 不带 `/lib`（harness 自拼）。

## 3. 探针普查（第 0 期交付）

分阶段类目（`AllocatedParse/Bind/Check/Emit`）已存在；新增唯一缺口探针 `emitBufferGrow`（`Utf8StringBuilder.Reserve` 扩容分支，探针 #39）。归因一律 `--checkers 1`（多 checker 下 summed 类目跨线程通胀，check 3,582 M vs 进程 813 M 不可比）。

**真实工程单 checker**（noEmit，进程 707.0 MB）：parse ≈184.9 M、bind ≈79.9 M、check ≈547.4 M、program ≈87.3 M（summed 有线程跳变残差，相对份额可信）。check 相位探针 inclusive 排序：relationCompare 185.0 > checkerRelated 169.7 > relRecurse 144.2 > recStamp 138.0 > resolveMembers 117.7 > relationRelated 90.7 > symbolTypesGet 67.4 > … > **objectLiteral 42.3**。

**medium 全量 emit 态**（进程 81.3 M）：emitBufferGrow 仅 0.805 M——**medium 侧否证 W7 缓冲假设**；但 huge-file 复测 **16.9 M own（第一大 emit 帧）**——单文件大输出的倍增链成立，W7 在 huge-file 复活并落地为容量预置（§4）。

r34 的「530 MB 未插桩」就此分解：parse/bind/check-未探针/emit 四块中，parse+bind 合计 ~265 M（mostly AST 保留，临时份额由存活集差推），check 未探针残差 = 547 − Σ探针 inclusive。

## 4. 各期落地与实测

| 期 | 内容 | 分配实测（交错 3×3） | 墙钟 |
| --- | --- | --- | --- |
| 0（`0d2366fa2f`） | W6 递归栈池化（单缓冲容量 64，深度预算 ≤50 永不增长）+ emitBufferGrow 探针 | 站点级归零（无独立夹具级测量，约束路径小块） | 未单测（并入 p1 批次） |
| 1（`0e6152913a`） | W1 消包装 45 处 + W2 成员表统一 SymbolTable + LINQ 残留 | 真实工程 noEmit **−0.90%**、huge-file −0.47%、medium −0.10% | AB143 全 CI 跨 1.0（中性） |
| 2 切片（`ba5dc90b95`） | W7-lite emit 容量预置 + ObjectAsync 排序去 LINQ | huge-file **−2.49%**、medium −0.72%、declarations −0.9% | AB144 huge-file 0.990 [0.975,1.019]（方向符合不显著）；declarations 见 §5 教训 3 |

第 1 期过程修正：无容量提示的 `SymbolTable()` 小表按 1→2→4→8 四次重分配生长，一度把 medium 读成 +0.18%；字面量表补 `Properties.Count` 容量提示后转负。契约点回退：`ModuleSpecifierGenerator`（两处）、`SemanticTokens`、`ProjectSnapshot`（两处）保留包装。

W7 池化形态否决理由（所有权审计）：`DetachText` 视图跨越 `emitOptions.WriteFile` 钩子与可替换 `IFileSystem`（LSP 内存文件系统可保留文本），归还池即悬垂——容量预置拿到同源收益（孤儿链消除）而不动所有权。

## 5. 过程教训（三条，均带数据）

1. **safety 契约抓获**：第 1 期全量去包装后 `module-program-specifiers-safety`/`module-generation-safety` 新失败（`Mutable naming result`）——测试钉死 `((IList<Utf8String>)result.Specifiers)[0] = x` 必须抛 `NotSupportedException`。裸数组的 `IList` 写入会成功。界线：**内部存储的包装是冗余，API 边界的包装是不可变契约**。
2. **gate 脚本谓词缺陷**：bytecheck 的 tsbuildinfo 归一化分支判定 `line.endsWith(".tsbuildinfo")`，但树行格式是 `path + " " + sha256`（行尾是哈希）——谓词永假，real-project 一度误报 FAIL。修正为 `line.split(" ")[0].endsWith(...)`。r32 脚本同缺陷（其 NOTE 记录来源存疑）。
3. **批内位置假象**：AB143/AB144 两批 declarations 连续边缘正向（+1.4%/+4.0%，CI 下界 ~1.0006），累计批次 AB145（p2 vs p0）读 **0.976 [0.909,1.015]**——不存在回归。教训：**同负载连续两批边缘同向时，累计批次是仲裁者**，且分配侧可先行排除（declarations 分配实测 −0.9%）。

## 6. 门禁状态（r35p2 终态）

| 门禁 | 结果 |
| --- | --- |
| Release 构建 0 警告 0 错误 | 绿（每期） |
| 逐字节 25 夹具（`built/r35-*-bytecheck.mjs`，双 AOT） | 25/25（real-project 仅 latestChangedDtsFile 并行序差异） |
| safety 95 flags | 91/95，失败 ⊆ 已知基线 |
| 分配 | 全量态 998.7 MB（3 run 带宽 0.007%）；noEmit 806.2→…；§4 各行 |
| 墙钟 | AB142~AB145（对 fresh 基线累计 medium 0.426 / huge-file 0.363） |

## 7. 未竟项与交接（W3 核心、W4、W5）

- **W3 字面量形状结构体化（方案主攻）**：前置全部就绪——弹性已放行（§2）、W2 使能器已落地、逐站点分配普查在方案 §4.W3 表。剩余工作量：`LiteralShape` 栈形状 + 逃逸判定 + 闭包显示类消除（池化状态对象，仿 RentLists LIFO）+ 每属性 Symbol/LinkStore 融合。**r27 布局敏感先例覆盖：必须单独过隔离巨文件批次**。预期按新弹性修正：medium −30% 分配 ≈ −7% 墙钟（1:4.2），huge-file 侧更高；真实工程侧 ≤3% 分配（普查 §3）。
- **W4 closed/union**：`closed` 整链 ~15 类 + `LangVersion=preview` 白名单；union 是 preview 特性（GA 前语法可变），墙钟预期 <0.5%，正确性动机为主。独立会话执行。
- **W5 FrozenDictionary**：预期 <0.5% 墙钟；触发条件：触碰全局只读表的轮次顺手做，不单独立项。
- **观测移交**：`emitBufferGrow` 探针已入库；真实工程侧下一个有斜率的分配面是关系引擎族（relationCompare/checkerRelated inclusive ~170-185 M 单 checker），但 r27 已否决 RelationOperation 池且表3 勿重开——除非布局扰动归因先行解决，此面保持关闭。

## 8. 与账目的关系

- ledger 表1 新增：约束递归栈池化、集合表达式消包装对、checker 成员表统一 SymbolTable、emit 容量预置、字面量物化排序去 LINQ、emitBufferGrow 探针（本轮随提交登记）。
- ledger 表2 新增：W7 缓冲池化形态（所有权否决）、无容量提示 SymbolTable 小表生长形态（修正后失效）。
- perf-budgets §2 分配锚点更新为 998.7 MB（r35p2 节点）；「分配相对 Go」行维持待 Go 侧重测状态。墙钟锚点（x1.396~1.423）未动（本轮墙钟中性，未触发对 Go 全量批次）。
- 方案文档（v2.1）不再回改；本报告为执行记录与移交基线。
