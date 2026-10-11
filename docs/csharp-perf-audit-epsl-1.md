# EPSL 审计 1：接入后首轮门禁全跑 + A 批收敛（2026-10-11）

> **元数据** ｜ 类型: audit ｜ 日期: 2026-10-11 ｜ 审计: EPSL-1（接入当日触发，SOP 见 `~/.zcode/perf-template/audit/carpet-audit-sop.md`）
> 产品: `pkgs/epsl-a1/lib/tsc.exe`（sha256 前 16 `b7a89cd1cd9352e7`，29,808,128 B）= r28 产品代码 + 3 处 LSP 侧 analyzer 修复（A 批）
> 数据来源: Release 全解决方案构建；`built/epsl-a1-bytecheck.mjs`（25 夹具，r28 对照）；95 flags safety 套件（重建后实测）；真实工程确定性分配 4 组；`bench/AB123`（epsl-a1 vs Go 默认，23 负载 × 15 对，--no-gc-env）
> 关联: `perf-budgets.md`（预算线）、`.ai/perf-ledger.md`（三表）、`docs/csharp-perf-report-r30.md`（上一轮）

---

## 0. 看点

1. **墙钟预算四线全绿**（AB123，epsl-a1 vs Go 默认，23 负载 × 15 对）：重负载 11 项均值 **x1.428**（预算 ≤1.50）、medium-checkers-1 **x2.009**（≤2.20）、巨文件 **x1.425**（≤1.55）、启动族最大 empty-project **x1.298**（≤1.35）。批有效：控制组 medianRatio 1.0026、bootstrap 95% CI [0.981, 1.020] 含 1.0、p95rel 6.1%、23 行零弃对、最差行 spread 2.09（≤3）。
2. **预算线全绿**：真实工程 CLR 总分配 811.42~811.55 MB（4 组，带宽 136 KB，确定性达标），预算 ≤820 MB；与 r28 锚点 811.52 MB 持平（A 批不触 CLI 路径的预期成立）。
3. **A 批闭环**：接入时清点的 3 处 LSP 侧违例当日修复（CA1851×2、CA1861×1），analyzer 门禁从 8 条升到 10 条 error，全解决方案 Release 0 警告 0 错误。
4. **行为等价三重确认**：逐字节 25/25（vs r28，含 real-project 645 文件树哈希）、safety 90/95 且失败集合与 r22 已知基线逐项相同、LinkStore creates 464,301 与健康形态逐位一致。
5. **阶段 2 按停止条件豁免**：r29（纯计划）+ r30（纯否决）连续两轮零落地，产品源码深读触发 SOP 停止条件②；本轮唯一开放面维持 r31 GC 堆数（ledger 待勘区在案）。

## 1. 门禁全表（阶段 1）

| 门禁 | 预算/预期 | 实测 | 判定 |
| --- | --- | --- | --- |
| 构建（csharp/ Release 全解决方案） | 0 警告 0 错误 | 0/0（10 条 analyzer error 生效） | 绿 |
| 逐字节产物（25 夹具，vs r28） | 100% | 25/25（退出码+stdout+文件树哈希） | 绿 |
| safety 套件（95 flags） | ≥90/95 且失败集合=已知基线 | 90/95，失败 5 项与 r22 集合逐项相同 | 绿 |
| 真实工程 CLR 总分配 | ≤820 MB | 中位 811.5 MB（811,418,912~811,554,752，4 组） | 绿 |
| LinkStore creates（健康形态） | 464,301 | 464,301（4 组逐组一致） | 绿 |
| Stack guard yields | 0 | 0（4 组一致，与 ledger 表3 大栈否决互证） | 绿 |
| GC 停顿（真实工程） | 参考项（无预算线） | 0.190~0.210 s（r27d 锚 0.206） | 观察项 |
| 墙钟预算四线（vs Go 默认） | 见 §2 | 四线全过（x1.428 / x2.009 / x1.425 / x1.298） | 绿 |
| 复杂度阶梯测试 | budgets §3 待建 | 不存在（L1 缺口；同日修复轮闭环，见 §8） | 缺口→闭环 |

## 2. 墙钟预算四线（AB123）

批有效性先行：控制组 medianRatio 1.0026（CI [0.981, 1.020] 含 1.0）、p95rel 6.1%（历史采纳带 12.9~22.8% 之下）、23 行全部零弃对、行级 p95÷min 最差 2.09（tiny-files-noemit-on-error）≤ 3。批采纳。

| 预算线 | 预算 | 实测（配对中位比值） | 95% CI | 判定 |
| --- | --- | --- | --- | --- |
| 重负载 11 项均值（medium 族 6 + 512 文件族 3 + 巨文件 + 声明） | ≤ x1.50 | **x1.4281** | 逐行 CI 全部不含预算线 | 绿 |
| medium-checkers-1（最差单负载） | ≤ x2.20 | **x2.009** | [1.977, 2.053] | 绿 |
| huge-file（巨文件） | ≤ x1.55 | **x1.425** | [1.391, 1.454] | 绿 |
| 启动族最大（empty-project） | ≤ x1.35 | **x1.298** | [1.263, 1.426]（上缘越线但点估与另两行 help x1.202/version x1.247 均在线内） | 绿 |

行读法：23 行比值全部 >1（C# 仍全面落后 Go 默认，形态与 r23 表一致）；最大两项为 medium-checkers-1 x2.009 与 host-paths x1.766（后者 r30 已定性为 substrate 启动地板，非代码可修面）。project-references-package x1.624、medium-checkers-2 x1.627 属族内正常位。无行需要归因（门禁无红项，阶段 1.5 空转）。

23 行全表（比值，Go 默认为分母）：help 1.202 / version 1.247 / empty-project 1.298 / small-first-diagnostic 1.361 / medium 1.299 / declarations 1.220 / tiny-files 1.340 / huge-file 1.425 / host-paths 1.766 / tiny-files-noemit 1.344 / tiny-files-noemit-on-error 1.397 / tiny-files-incremental-edit 1.442 / medium-checkers-1 2.009 / -2 1.627 / -4 1.372 / -8 1.273 / medium-256m 1.307 / project-references-clean 1.494 / -noop 1.365 / -implementation 1.370 / -declaration 1.540 / -config 1.364 / -package 1.624。

## 3. A 批明细（阶段 3 收敛）

| 项 | 文件 | 修复 | 验证 |
| --- | --- | --- | --- |
| CA1851×2 | `LanguageServer/LspJson.Completions.cs` | `Array(...)` 懒枚举物化 `.ToArray()`（两次 `.Any` 各走一遍枚举器） | 构建 0/0 + 逐字节 25/25 |
| CA1861×1 | `LanguageServer/SessionTelemetry.cs` | `new[]{...}` 常量数组提为 `static readonly string[] RawConfigurationProperties` | 同上 + safety 90/95 |

启用后 analyzer 段为 10 条 error（CA1834/1841/1845/1846/1847/1854/1860/1862/1851/1861）；剩余 2 条缓期（CA1849×42、CA2012×15，checker 双轨 sync/async 既有形态，触碰关系调用链须先过隔离巨文件批次，r27 教训）。

A 批变异探针状态：两条规则在接入轮已做过注入验证（CA1860 探针），本轮修复后 0/0 即零违例证明；未对 CA1851/CA1861 单独注入（接线机制同一，同一 editorconfig 段生效）。

## 4. ledger 交叉核验（阶段 2 替代件）

按四红线精神对表1 已用特性做机械核验（规则化不了的深读豁免依据见 §0 看点 5）：

| 声明 | 树上证据 | 结果 |
| --- | --- | --- |
| SearchValues（扫描器） | `Syntax/Scanner.cs` | 在 |
| 成员表 LIFO 租借 | `Checking/StructuredMembers.cs:362`（RentLists，租时 Clear） | 在 |
| Filter 双遍化 | `Checking/TypeAlgebra.cs:466`（count-then-fill 注释与实现） | 在 |
| emit 复用诊断 checker 池 | `Incremental/IncrementalProgram.Emit.cs:87`（`checkerPool ??=`） | 在 |
| DATAS 关闭 | `TypeScript.CommandLine.csproj:35`（`GarbageCollectionAdaptationMode=0`） | 在 |

## 5. 收敛与移交

- A 批：闭环（§3）。
- B 批移交：r31 GC 堆数轮（HeapCount 4/8 × AB × 停顿行直读；ledger 待勘区首项）。
- C 批/待建：复杂度阶梯测试（budgets §3 草案）；三方表全量刷新（本轮完成 Go 默认臂，Go@400 与优化前基准臂未跑，r28 墙钟收益的全表定位仍待专项轮）。
- 明确不做：无新增（本轮无新否决项；既有 16 项见 ledger 表2）。

## 6. 口径注记

- 分配为确定性指标（★★★）：`CLR allocated bytes` 进程级行；`Alloc check (summed)` 等分相行是并行 checker 的包含性计数（3.5 GB 量级），**不是**总分配，勿混用（本轮实测确认双轨并存）。
- 墙钟仅同批配对比值可比（★★★）；AB123 控制组与行级 spread 校验见 §2；跨批绝对值禁比。
- safety 的 5 个已知失败：`checker-relation-context-safety`、`program-emit-safety`、`developer-safety`/`lsp-native-watch-safety`（需目录参数）、`npm-process-safety`（环境态）——r22 §93 基线。
- 本轮审计触发依据：EPSL 接入完成（阶段边界）+ 用户显式指令；非"感觉该优化了"反触发形态。

## 7. 尾注

- 明细数据：`/tmp/epsl-a1-build.log`、`/tmp/epsl-safety.log`、`/tmp/epsl-alloc.log`、`bench/AB123-epsl-a1-vs-go-default/summary.json`
- 基线状态：r28 产品（`pkgs/r28`）与固定节点 `pkgs/go-v1`/`naot-svr` 未动；epsl-a1 产品与 `manifests/epsl-a1.json` 新增（tsbench 工作区，不入库）。

## 8. 勘误与同日修复轮闭环（2026-10-11 晚，用户指令"根据报告全面修复"）

| 项 | 原判定 | 闭环结果 |
| --- | --- | --- |
| 复杂度阶梯测试 | L1 缺口 | 已建：`--parser-ladder`（Compatibility 工程，三档 1k/10k/100k 语句，时间带宽 [4,26]、分配带宽 [8,12]）；首轮实测时间比 6.2×/6.9×、分配比 10.12×/9.95×（线性）；`--parser-ladder-probe` 以合成二次方比率验证门禁能红（按设计 exit 1）✓ |
| CA1851/CA1861 变异探针 | 未单独注入 | 已补做：注入双违例探针文件，CA1851×2 + CA1861×1 全部红 ✓（探针即删） |
| LSP 运行时覆盖 | 误记为"未验证" | 勘误：两处修复路径均有直接运行时覆盖——`SessionTelemetry.ProjectInfo` 由 `--telemetry-safety`（TelemetryTests.cs:32）、`LspJson.CompletionOptions` 由 `--syntax-services-safety`（SyntaxServiceTests.cs:204-210）执行，两者都在本轮 90 通过集合内 ✓ |
| 三方表剩余两臂 / r31 | B/C 批移交 | 见 r31 轮文档与本轮对比表（修复轮执行） |

### 进度追踪

| 维度 | 状态 |
| --- | --- |
| 实现进度 | 审计阶段 1/1.5/3 100%；A 批 100%；阶段 2 豁免（停止条件②） |
| 验证完成度 | 构建/逐字节/safety/分配四门禁实测完成；AB123 批有效性校验与四线比对完成（全绿）；阶梯测试未建（缺口在案） |
