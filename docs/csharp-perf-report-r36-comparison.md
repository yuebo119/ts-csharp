# r36 对 Go 对比表（nrb1 节点，含机器态异常披露）

| 元数据 | 值 |
| --- | --- |
| 类型 | 三方对比表（对 Go 侧） |
| 日期 | 2026-10-14 |
| 轮次 | r36 |
| 主题 | 独立仓基线节点 nrb1 对 Go 默认全量对比 |
| 节点 | Go 参考 `pkgs/go-v1`（tsc.exe sha256 `5e46cd5d1518…`，GOGC 默认）；C# `pkgs/nrb1`（sha256 `ac7135157f74…`，本仓 `c01f552`） |
| 数据来源 | 当日批 `bench/AB147-nrb1-vs-go-default`（23 负载 × 15 样本，配对交错）；锚定批 `bench/AB129-r34-vs-go-default`（2026-10-12）；判别批 `bench/AB148-probe-r34-vs-nrb1-huge` |
| 关联文档 | `docs/csharp-perf-report-r36-standalone-baseline.md`、`docs/csharp-perf-report-r34-comparison.md` |

## 先读：本批测得的机器态异常（影响全部当日比值）

同一路径的成套证据表明**当日机器态对 C# 侧（NativeAOT 多线程检查器）系统性劣化，Go 侧不受影响**：

1. 同一 r35p2 二进制：昨天 AB144 huge-file wall 542.5 ms（cpu 812.5，cpu/wall 1.50），今天 AB146 wall 729.3 ms（cpu 921.9，cpu/wall 1.26）——wall +34%、cpu +13.5%、有效并行度下降；
2. r34 二进制（两天前 AB134 实测 512~537 ms）今天当场复测 AB148 = 782.6 ms，与 nrb1（767.3）同批仅差 2%——**全部 C# 二进制共同变慢，非某版本代码回归**；
3. Go 二进制三批稳定：huge-file 377.8 / 385.7 / 372.8 ms（±2%）。

结论：下表"今日比值"列（AB147）内部有效（配对交错、逐行 p95/min ≤ 1.29、对照 CI 含 1.0、逐字节输出全等），但**系统性高估对 Go 差距**；代码锚定的对 Go 口径仍以 r34/r35 锚（重负载 x1.398~x1.423 漂移带）为准，待空闲机器复测后重锚。

## 对比表（中位墙钟 ms；今日批 = AB147 当日实测；锚定批 = AB129，2026-10-12）

| 工作负载 | Go 默认(今日) | C# nrb1(今日) | 今日比值 | r34 锚比值(AB129) |
| --- | --- | --- | --- | --- |
| help | 46.64 | 52.60 | 1.128 | 1.230 |
| version | 45.88 | 53.11 | 1.158 | 1.228 |
| empty-project | 46.04 | 55.54 | 1.206 | 1.275 |
| small-first-diagnostic | 50.52 | 64.67 | 1.280 | 1.438 |
| medium | 90.12 | 136.28 | 1.512 | 1.257 |
| declarations | 86.30 | 123.79 | 1.434 | 1.187 |
| tiny-files | 230.63 | 295.80 | 1.283 | 1.345 |
| huge-file | 372.84 | 757.76 | 2.032 | 1.393 |
| host-paths | 51.79 | 92.98 | 1.795 | 1.889 |
| tiny-files-noemit | 117.42 | 139.50 | 1.188 | 1.300 |
| tiny-files-noemit-on-error | 235.21 | 298.54 | 1.269 | 1.374 |
| tiny-files-incremental-edit | 246.74 | 341.17 | 1.383 | 1.439 |
| medium-checkers-1 | 102.46 | 223.11 | 2.178 | 2.070 |
| medium-checkers-2 | 95.04 | 181.92 | 1.914 | 1.630 |
| medium-checkers-4 | 91.18 | 157.58 | 1.728 | 1.392 |
| medium-checkers-8 | 87.94 | 136.19 | 1.549 | 1.274 |
| medium-256m-heap-setting | 90.13 | 135.35 | 1.502 | 1.296 |
| project-references-clean | 54.16 | 78.58 | 1.451 | 1.517 |
| project-references-noop | 47.39 | 59.72 | 1.260 | 1.347 |
| project-references-implementation | 53.92 | 70.51 | 1.308 | 1.368 |
| project-references-declaration | 55.54 | 80.57 | 1.451 | 1.496 |
| project-references-config | 53.26 | 69.01 | 1.296 | 1.363 |
| project-references-package | 53.85 | 78.78 | 1.463 | 1.631 |

## 批次有效性（AB147）

- 逐行 p95/min 双槽 ≤ 3：23/23 通过（本批最大 1.29）；对照组 p95RelativePairDifference 23.5%（单值不否决，逐行散布佐证）。
- 逐字节断言全过（文件/诊断/发射字节）；进程创建计入、暖文件系统、15 样本。
- 驱动：本仓 `csharp/tools/performance-cli.mjs`；Go 经 `--go-executable pkgs/go-v1/lib/tsc.exe`（GOGC 默认口径）。

## 口径注记

- 轻负载标准警示（必复述）：startup 主导行差异 1~4 ms、方向不均匀、CI 多跨 1.0，不构成代码回归信号。
- Go@400 与对 C# 基线（pkgs-fresh/naot-svr）两列未在本日重测：nrb1 与 r35p2/r34 代码同源（AB146/AB148 证等价），沿用 r34-comparison 表锚定值；机器态异常消除前新增列没有意义。
- 机器态异常的观测面移交：复测前置条件为空闲机器（后台进程清单两日相同，触发源不可辨），复测项 = 单批 nrb1-vs-go-default 全量，接受标准 = huge-file 回落至 x1.39~1.43 带。
