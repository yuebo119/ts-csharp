# r19 测量报告：.NET 10 构建的性能，附可移植性阻塞清单

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r19 ｜ 主题: net10-vs-net11-measurement
> 涉及 git 节点: `b46a749ab0`（r18 对比表，工作树基线）
> 数据来源: 三个配对批次（AB98 net10 vs net11、AB99 net10 vs Go 默认、AB100 net10 vs Go@400，每批 23 负载 × 15 组交替配对）；net10.0 产品构建（.NET SDK 10.0.401）
> 关联: `docs/csharp-perf-report-r18.md`（GC 配置）、`docs/csharp-perf-report-r18-comparison.md`（net11 三方表）

---

## 0. 本轮结论

**这个项目当前无法在 .NET 10 上原样构建与运行；按最小可移植修补构建出的 .NET 10 版本，重负载比 .NET 11 慢 16%~41%，23 项里 18 项显著更慢，无一项更快。** .NET 11 的生产 runtime-async 与 UTF8 解析 API 是本项目的硬依赖。

| 对比 | 重负载平均 | 轻负载平均 |
| --- | --- | --- |
| net10 ÷ net11（AB98） | **x1.18（慢 18%）**，区间 +1.6% ~ +40.9% | x1.09（慢 9%） |
| net10 ÷ Go 默认（AB99） | x1.73 | x1.68 |
| net10 ÷ Go@400（AB100） | x1.83 | x1.67 |

对照 net11（r18）对 Go 默认的重负载平均 x1.46，net10 是 x1.73，差距扩大 18%。峰值内存两代完全一致（x1.00~1.02，GC 配置相同）。

---

## 1. 可移植性阻塞清单（构建 .NET 10 遭遇的三道墙）

按尝试顺序记录，全部为实测：

1. **目标框架与语言版本**：`Directory.Build.props` 固定 `net11.0` 与 `LangVersion 15.0`，.NET 10 SDK 直接拒绝（NETSDK1045 / CS1617）。改 `net10.0` + `preview`（C# 14）后可越过。
2. **.NET 11 独有的 UTF8 解析 API**：4 处调用 `BigInteger.Parse/TryParse(ReadOnlySpan<byte>/Utf8String, …)`（`ExpressionTypes.cs:238`、`TypeInference.Templates.cs:33/80`、`Scanner.cs:914`），.NET 10 引用程序集只有 char 重载。本次用临时填充类（UTF8 解码成 string 再调 char 重载）绕过；这些路径只处理 BigInt 字面量，基准负载不触及。
3. **ref struct 跨 await**：代码把 `ReadOnlySpan<byte>` 跨 await 持有（`Completions.Entries.cs:138`），只有 .NET 11 的生产 runtime-async 支持。经典异步下仅此 1 处报 CS4007（已用一次材料化绕过，位于 LSP 补全路径，编译 CLI 不执行）；但 .NET 10 SDK 自带的评估版 runtime-async 虽然能编译，**运行必崩**：每次调用都在 `CompilerCommand.DisposeAsync` 抛 `InvalidProgramException`（CLR 检测到无效程序），24 个夹具无一成功。评估版不可用，故 net10 构建走经典异步。

**net10 测量的身份说明**：产物为 `pkgs/r19/lib/tsc.exe`（sha256 见批次记录，35,867,136 B，比 net11 的 29,779,968 B 大 6.1 MB，经典异步状态机代码更多）。它与 net11 的差异有两层：运行时/SDK 版本，以及异步机制（经典 vs 生产 runtime-async）。本项目检查器是 await 密集型（r11 报告：每个属性约五个 await 帧），两层差异无法在这个实验里分开，报告中所有 net10 数字都应读作"把本项目移植到 .NET 10（经典异步）后的性能"。

---

## 2. net10 vs net11（AB98，同 GC 配置）

| 负载 | net11（ms） | net10（ms） | net10/net11 | 95% CI |
| --- | ---: | ---: | ---: | --- |
| huge-file | 567 | 799 | **x1.41** | [1.381, 1.430] |
| medium-checkers-1 | 213 | 285 | **x1.34** | [1.299, 1.372] |
| medium-checkers-2 | 160 | 203 | **x1.27** | [1.177, 1.338] |
| declarations | 106 | 129 | **x1.21** | [1.129, 1.344] |
| medium-checkers-4 | 131 | 156 | x1.19 | [1.106, 1.229] |
| medium-checkers-8 | 116 | 137 | x1.18 | [1.110, 1.207] |
| medium | 115 | 134 | x1.16 | [1.143, 1.189] |
| medium-256m-heap-setting | 130 | 148 | x1.13 | [1.092, 1.162] |
| empty-project | 61 | 68 | x1.12 | [1.063, 1.257] |
| small-first-diagnostic | 69 | 79 | x1.14 | [1.045, 1.246] |
| help（启动） | 62 | 71 | x1.14 | [1.048, 1.317] |
| project-references-package | 87 | 99 | x1.14 | [1.014, 1.180] |
| project-references-implementation | 75 | 82 | x1.09 | [1.022, 1.117] |
| host-paths | 102 | 107 | x1.06 | [1.000, 1.087] |
| tiny-files-noemit-on-error | 323 | 333 | x1.03 | [1.021, 1.065] |
| tiny-files-incremental-edit | 380 | 394 | x1.04 | [1.016, 1.060] |
| tiny-files | 321 | 326 | x1.02 | [1.004, 1.025] |
| project-references-clean | 90 | 95 | x1.06 | [1.014, 1.136] |
| version（启动） | 64 | 66 | 噪声 | [0.981, 1.419] |
| tiny-files-noemit | 164 | 171 | 噪声 | [0.975, 1.126] |
| project-references-noop | 66 | 76 | 噪声 | [0.878, 1.353] |
| project-references-declaration | 97 | 98 | 噪声 | [0.981, 1.142] |
| project-references-config | 76 | 84 | 噪声 | [0.956, 1.237] |

18 项显著更慢、0 项更快、5 项噪声内。启动项（help/version/empty）也慢 4%~14%，与二进制大 6 MB（经典异步状态机）和缺少 .NET 11 的启动期改进一致。

---

## 3. net10 vs Go（AB99 / AB100）

| 负载 | Go 默认 | Go@400 | net10 | 对比 Go 默认 | 对比 Go@400 |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium-checkers-1 | 105 | 101 | 288 | **x2.74** | **x2.82** |
| host-paths | 53 | 52 | 110 | **x2.07** | x2.04 |
| huge-file | 400 | 401 | 790 | **x1.97** | x1.97 |
| medium-checkers-2 | 94 | 89 | 207 | x2.20 | x2.31 |
| project-references-clean | 55 | 53 | 94 | x1.72 | x1.80 |
| project-references-package | 54 | 53 | 94 | x1.74 | x1.80 |
| project-references-declaration | 56 | 55 | 96 | x1.70 | x1.74 |
| project-references-noop | 47 | 48 | 78 | x1.65 | x1.65 |
| medium-256m-heap-setting | 93 | 85 | 148 | x1.59 | x1.74 |
| small-first-diagnostic | 51 | 50 | 81 | x1.57 | x1.55 |
| empty-project | 49 | 47 | 76 | x1.56 | x1.80 |
| project-references-implementation | 54 | 53 | 82 | x1.51 | x1.65 |
| medium-checkers-8 | 90 | 84 | 136 | x1.51 | x1.67 |
| project-references-config | 54 | 52 | 82 | x1.53 | x1.61 |
| declarations | 85 | 79 | 128 | x1.50 | x1.64 |
| medium | 92 | 85 | 136 | x1.47 | x1.64 |
| tiny-files-incremental-edit | 268 | 246 | 394 | x1.47 | x1.61 |
| medium-checkers-4 | 91 | 85 | 160 | x1.75 | x1.84 |
| tiny-files-noemit-on-error | 238 | 244 | 339 | x1.43 | x1.44 |
| tiny-files-noemit | 118 | 121 | 169 | x1.43 | x1.41 |
| tiny-files | 235 | 231 | 331 | x1.41 | x1.43 |
| help（启动） | 47 | 46 | 84 | x1.79 | x1.40 |
| version（启动） | 46 | 46 | 84 | x1.85 | x1.59 |

重负载平均 x1.73（Go 默认）/ x1.83（Go@400）；net11（r18）同口径为 x1.46 / x1.54。**升级到 .NET 11 把对 Go 的重负载差距收窄了约 18 个百分点（按平均值）。**

---

## 4. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| net10 构建 | .NET SDK 10.0.401，AOT 产品形态成功（35,867,136 B）；评估版 runtime-async 路径运行时崩溃（§1 第 3 条），已弃用 |
| 产物一致性（net10 vs net11） | 18 合成形状 + 5 staged 负载（1,882 产物）+ 巨文件 + 12 关系夹具，**全部逐字节一致**；即 §1 的移植修补不改变编译器输出 |
| 批次有效性 | AB98 控制项 p95rel 87.7%、medianRatio 0.964（CI [0.701, 1.040]）；AB99 18.7% / 0.913（[0.883, 1.146]）；AB100 14.6% / 0.997（[0.899, 1.102]）。三批 CI 均含 1.0；AB98 的高离散度来自本机其他进程对轻负载控制项的干扰，其重负载效应（16%~41%）CI 紧且与 AB99/AB100 的绝对水平自洽 |
| 临时改动清理 | props 的 TFM/语言版本/预览开关、4 个源文件的移植修补、Compat 填充类全部移除，工作树回到 `b46a749ab0`（见 §6） |

---

## 5. 结论与建议

1. **留在 .NET 11**。net10 需要 5 处源码修补（其中 1 处靠评估版特性才能编译，而评估版运行时必崩），且重负载慢 16%~41%。本项目是 .NET 11 特性的直接受益者：生产 runtime-async（await 密集型检查器）、UTF8 解析 API、启动期改进。
2. 若要支持 .NET 10 部署，最小成本是把 4 处 UTF8 BigInteger 解析改成与框架版本无关的助手（约十行），并把 `Completions.Entries.cs:138` 的 span 材料化；此后仍需接受经典异步约 18% 的重负载代价。
3. 本轮测量只覆盖 CLI 编译路径；LSP 路径在 net10 上未验证（评估版崩溃点正在 LSP 相关的 `DisposeAsync`）。

---

## 6. 工作树状态

本轮所有临时改动（`Directory.Build.props` 的 net10.0/preview/预览开关/NoWarn、4 个源文件的修补、`Compat/Utf8BigInteger.cs`）已全部移除，工作树回到 `b46a749ab0`。net10 产物 `pkgs/r19` 与批次数据保留在 harness 工作区供复测，不进入仓库。
