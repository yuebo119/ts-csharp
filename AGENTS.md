# AGENTS.md（typescript-cs）

本仓是 TypeScript 的 C#/.NET 11 移植（产品源码在 `csharp/`，性能战役文档在 `docs/csharp-perf-*`）。当前只承载 EPSL 性能工程接入节，其余域未设节。

## 性能工程（EPSL 接入节，2026-10-11）

会话启动清单三件（做性能相关工作前确认）：

1. `perf-budgets.md`（仓库根）——性能门禁阈值单一事实源，已读最新版？
2. 门禁命令——`csharp/` 下 `dotnet build TypeScript.slnx -c Release` 必须 0 警告 0 错误；产品改动另加逐字节产物门禁（25 夹具 bytecheck 形态）与 safety 套件（95 flags，失败集合须等于已知基线集合）
3. `.ai/perf-ledger.md`——勿重开清单与明确不做表，提任何性能建议前必查（防重复提案；r06~r30 全部否决已入账）

- 主方案与纪律：`~/.zcode/references/EXTREME_PERF_SYSTEM.md`（四红线在 §3，深挖协议在 §4.3）；量具手册 `~/.zcode/references/PERF_NATIVE_PLAYBOOK.md`
- 测量协议权威：`docs/csharp-perf-method.md`（配对 A/B、三类可比量分级、噪声下限 1.1%、构建形态易错点）——本仓测量一律按该文件，此处不重复
- 性能深挖只按触发条件启动：门禁红 / 量级越界 10× / 新负载类型 / SLO 烧穿 / 阶段边界 / 项目完成；其余场合禁全量地毯扫描
- 复杂度契约与热路径清单见 `perf-budgets.md` §3；任何随两变量乘积伸缩的算法（O(n×m)）进热路径必须显式质询
- 轮次文档约定：`docs/csharp-perf-{plan|report}-rXX.md`；三方对比表当前口径为 r28 表（2026-10-11，`csharp-perf-report-r28-comparison.md`，最新节点 epsl-a1 与 r28 产物逐字节一致）
- 触碰关系调用链（`TypeRelations`/`CompareAsync` 链）的改动，必须先过隔离巨文件批次再谈分配收益（r27 教训，ledger 表3）
