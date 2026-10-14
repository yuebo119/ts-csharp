# typescript-csharp

TypeScript 编译器的 C#/.NET 11 移植与性能战役仓库，完全独立。

本仓库自 hez2010/TypeScript（fork 自 microsoft/TypeScript）的 `f29aeb9f825d` 处独立，
git 历史仅保留 C# 工作的 260 个提交（作者、日期与提交信息逐字保留）；
上游 TypeScript/JavaScript 源码与 Go 实现的历史不在本仓库，需要时查原仓库归档。

## 构建

```bash
cd csharp
dotnet build TypeScript.slnx -c Release   # 门禁：0 警告 0 错误
```

产品发布（NativeAOT）：

```bash
dotnet publish csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj -c Release -r win-x64 \
  -p:PublishAot=true -p:TypeScriptExecutableName=tsc -p:EmbedTypeScriptLibraries=false -p:UseSharedCompilation=false
```

## 性能工程（EPSL）

- `perf-budgets.md`：性能门禁阈值单一事实源
- `.ai/perf-ledger.md`：勿重开清单与明确不做表，提性能建议前必查
- `docs/csharp-perf-method.md`：测量协议（配对 A/B、三类可比量分级）
- 轮次文档：`docs/csharp-perf-{plan|report}-rXX.md`
- 测量基建设在仓外 `C:\ai\projects\tsbench`，不含在本仓库

## 当前性能（对 Go 对比）

节点：C# `pkgs/nrb1`（本仓基线，2026-10-14 重锚）vs Go 参考 `pkgs/go-v1`（GOGC 默认）。
口径：tsbench 配对交错 A/B、15 样本、中位墙钟（ms）、逐字节输出断言全过。
比值两列来源：`AB147`（2026-10-14 当日批）与 `AB129`（2026-10-12 r34 锚定批，代码同源）。
**注意**：当日机器态对 C# 侧系统性劣化（同一二进制隔日 wall 542.5→729.3 ms，r34 老产物当日复测同幅变慢，Go 侧三天三批 ±2% 稳定，AB148 判别批证实非代码因素），当日列高估差距，权威口径为右列（重负载族对 Go 默认 **x1.398~x1.423** 漂移带），待空闲机器复测后重锚。

| 工作负载 | Go 默认(今日) | C# nrb1(今日) | 今日比值 | r34 锚比值 |
| --- | --- | --- | --- | --- |
| help | 46.6 | 52.6 | 1.13 | 1.23 |
| version | 45.9 | 53.1 | 1.16 | 1.23 |
| empty-project | 46.0 | 55.5 | 1.21 | 1.28 |
| small-first-diagnostic | 50.5 | 64.7 | 1.28 | 1.44 |
| medium | 90.1 | 136.3 | 1.51 | 1.26 |
| declarations | 86.3 | 123.8 | 1.43 | 1.19 |
| tiny-files | 230.6 | 295.8 | 1.28 | 1.35 |
| huge-file | 372.8 | 757.8 | 2.03 | 1.39 |
| host-paths | 51.8 | 93.0 | 1.80 | 1.89 |
| tiny-files-noemit | 117.4 | 139.5 | 1.19 | 1.30 |
| tiny-files-noemit-on-error | 235.2 | 298.5 | 1.27 | 1.37 |
| tiny-files-incremental-edit | 246.7 | 341.2 | 1.38 | 1.44 |
| medium-checkers-1 | 102.5 | 223.1 | 2.18 | 2.07 |
| medium-checkers-2 | 95.0 | 181.9 | 1.91 | 1.63 |
| medium-checkers-4 | 91.2 | 157.6 | 1.73 | 1.39 |
| medium-checkers-8 | 87.9 | 136.2 | 1.55 | 1.27 |
| medium-256m-heap-setting | 90.1 | 135.4 | 1.50 | 1.30 |
| project-references-clean | 54.2 | 78.6 | 1.45 | 1.52 |
| project-references-noop | 47.4 | 59.7 | 1.26 | 1.35 |
| project-references-implementation | 53.9 | 70.5 | 1.31 | 1.37 |
| project-references-declaration | 55.5 | 80.6 | 1.45 | 1.50 |
| project-references-config | 53.3 | 69.0 | 1.30 | 1.36 |
| project-references-package | 53.9 | 78.8 | 1.46 | 1.63 |

轻负载行（startup 主导，45~90 ms 段）差异 1~4 ms、方向不均匀，CI 多跨 1.0，不构成代码回归信号。
批次有效性、逐字节断言与完整证据链见 `docs/csharp-perf-report-r36-comparison.md`；测量协议见 `docs/csharp-perf-method.md`。

## 已知边界

- `csharp/external/tsc/` 的内嵌数据（108 个 lib.d.ts、13 个本地化诊断 json.gz）
  复制自原仓库 `tsc/` 树（Apache-2.0，出处见 `LICENSE.txt` / `NOTICE.txt`）。
- `csharp/oracle/` 与 `csharp/tools/` 中的 Node 再生成脚本引用原 monorepo 的
  `tsc/`、根 Node 工作区与本地 git 历史，在本仓库不可用；
  产品构建（dotnet）不经过它们。
- `.github/workflows/csharp.yml` 保留原样；其 `npm ci` / hereby 步骤面向原
  monorepo 设计，在本仓库运行前需改造。
