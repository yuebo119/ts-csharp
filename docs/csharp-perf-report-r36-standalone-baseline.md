# r36 独立仓库基线重建报告

| 元数据 | 值 |
| --- | --- |
| 类型 | 基线重建报告 |
| 日期 | 2026-10-14 |
| 轮次 | r36 |
| 主题 | 独立仓库（typescript-csharp）完整测试 + 全量性能重建基线 |
| 涉及 git 节点 | 本仓 `main` @ `c01f552`（产物 = `pkgs/nrb1`，tsc.exe sha256 `ac7135157f7499b23203…`） |
| 对照节点 | `pkgs/r35p2`（tsc.exe sha256 `6ff5a708b0ed730629e8…`，r35 第 2 期产物，与本次源码逐字节同源） |
| 数据来源 | tsbench 批次 `bench/AB146-nrb1-vs-r35p2`（23 工作负载 × 15 样本，配对交错） |
| 关联文档 | `docs/csharp-perf-method.md`（测量协议）、`docs/csharp-perf-report-r34-rebaseline.md`（上一次基线重建）、`docs/csharp-perf-report-r35.md` |

## 结论

**独立仓库产物 nrb1 与 r35p2 在全部 23 个工作负载上墙钟等价**：比值区间 0.9924~1.0120，全部落在 1.1% 噪声下限内；RSS 批内比值 0.998~1.005；配对逐字节断言（文件/诊断/发射字节）全部通过。自本批起，C# 侧基线节点锚定 `pkgs/nrb1`（manifest `manifests/nrb1.json`），后续轮次 `--baseline-manifest` 一律使用它；r35p2 退化为对照节点。对 Go 的比值不随基线重锚变化（源码与 r35p2 逐字节同源，其 Go 关系沿用 r34/r35 节点口径：重负载族对 Go 默认 x1.398~x1.423 批间漂移带）。

## 验证门禁（全部本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `dotnet build csharp/TypeScript.slnx -c Release` | 0 警告 0 错误 |
| safety 套件（93 直接可调用旗标） | 91 通过 / 2 失败 = 文档基线集（`program-emit-safety`、`checker-relation-context-safety`；`npm-process-safety` 本轮通过），`--content-mappers` 退出码 0，SUITE-OK |
| RegularExpression / SourceMetadata | 退出码 0 |
| Go oracle 差分（同日，`--oracle` 快照模式） | 362,310 断言全部通过 |
| 产物形态 | tsc.exe + 108 lib.d.ts 齐全，NativeAOT |

## AB146 全量结果（before=r35p2，after=nrb1，中位墙钟 ms）

| 工作负载 | before | after | 比值 | p95/min (b/a) |
| --- | --- | --- | --- | --- |
| help | 50.81 | 51.42 | 1.0120 | 1.12 / 1.07 |
| version | 50.89 | 50.54 | 0.9932 | 1.12 / 1.12 |
| empty-project | 54.45 | 54.97 | 1.0096 | 1.16 / 1.12 |
| small-first-diagnostic | 63.48 | 63.39 | 0.9986 | 1.07 / 1.08 |
| medium | 125.05 | 125.68 | 1.0050 | 1.43 / 1.54 |
| declarations | 114.28 | 114.27 | 1.0000 | 1.08 / 1.18 |
| tiny-files | 280.43 | 280.31 | 0.9996 | 1.06 / 1.07 |
| huge-file | 729.27 | 727.14 | 0.9971 | 1.07 / 1.08 |
| host-paths | 87.83 | 88.48 | 1.0074 | 1.04 / 1.09 |
| tiny-files-noemit | 130.44 | 130.58 | 1.0010 | 1.25 / 1.04 |
| tiny-files-noemit-on-error | 282.49 | 285.40 | 1.0103 | 1.12 / 1.04 |
| tiny-files-incremental-edit | 321.95 | 322.98 | 1.0032 | 1.10 / 1.07 |
| medium-checkers-1 | 211.40 | 212.12 | 1.0034 | 1.14 / 1.07 |
| medium-checkers-2 | 178.62 | 177.64 | 0.9945 | 1.13 / 1.14 |
| medium-checkers-4 | 147.91 | 147.02 | 0.9939 | 1.09 / 1.12 |
| medium-checkers-8 | 124.75 | 124.86 | 1.0009 | 1.08 / 1.03 |
| medium-256m-heap-setting | 125.48 | 125.69 | 1.0016 | 1.09 / 1.06 |
| project-references-clean | 74.99 | 74.98 | 1.0000 | 1.05 / 1.05 |
| project-references-noop | 57.01 | 57.50 | 1.0085 | 1.04 / 1.06 |
| project-references-implementation | 66.10 | 66.23 | 1.0020 | 1.10 / 1.02 |
| project-references-declaration | 77.15 | 76.56 | 0.9924 | 1.06 / 1.05 |
| project-references-config | 65.80 | 65.78 | 0.9997 | 1.06 / 1.06 |
| project-references-package | 74.95 | 75.03 | 1.0010 | 1.03 / 1.06 |

## 批次有效性

- 逐行 p95/min ≤ 3 双槽检查：23/23 通过（本批最大 1.54，远低于阈值）。
- 对照组（同产物同参数自比）：medianRatio 1.0024，95% CI [0.972, 1.026] 含 1.0，无槽位偏置；p95RelativePairDifference 8.1%（单值不作否决依据，逐行散布佐证）。
- 逐字节断言：边界注记确认"Files, diagnostics and emitted bytes compare exactly"，两槽产物输出全等。
- 驱动与口径：`typescript-csharp/csharp/tools/performance-cli.mjs`（自此批次起驱动记录指向独立仓库路径）；15 样本、暖文件系统、新进程含启动；serverGC 显式 0 注入。

## 口径注记

- 轻负载标准警示（必复述）：startup 主导的工作负载（本批 45~90 ms 段）差异 1~4 ms 且方向不均匀，CI 多跨 1.0，不构成代码回归信号，如需细读要求空闲机复测。
- RSS 只用批内比值（本批 0.998~1.005）；绝对值与跨会话趋势不可比（DATAS 预算与工作集修剪的会话态）。
- nrb1 与 r35p2 的 tsc.exe sha256 不同属预期：NativeAOT 二进制跨构建目录不可逐字节复现（路径入像），行为等价由本批逐字节输出断言与 23 行墙钟等价共同证明。
- 本轮未重跑 Go 侧批次：nrb1 与 r35p2 源码逐字节同源，Go 关系已在 r34-comparison（AB129~AB132）与 r35 复测（AB134~AB136）锚定，重锚不改变该关系。
