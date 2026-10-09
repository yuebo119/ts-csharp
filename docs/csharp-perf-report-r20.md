# r20 审计报告：.NET 11 适配核查与剩余优化项实测，现行配置即为最优

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r20 ｜ 主题: net11-adaptation-audit
> 涉及 git 节点: `706f6ddab0`（r19 net10 测量，工作树基线，net11.0 状态）
> 数据来源: 三个配对批次（AB101/AB102/AB103，每批 7 负载 × 15 组交替配对，`--no-gc-env`）；三个 AOT 变体构建；CPU 指令集探针；Microsoft Learn 文档查证
> 关联: `docs/csharp-perf-report-r18.md`（GC 配置）、`docs/csharp-perf-report-r19.md`（.NET 10 对比）

---

## 0. 本轮结论

**项目已全面适配 .NET 11，现行配置在可测空间内就是最优；本轮测试的三个剩余开关两个无收益、一个显著更差，均不采纳。** 工作树无改动（保持 `706f6ddab0` 的 net11.0 状态），本轮只提交本报告。

| 候选 | 批次 | 结果 | 处置 |
| --- | --- | --- | --- |
| `IlcInstructionSet=avx512` | AB101 | 7 负载全部噪声内（0.975~1.022） | 不采纳 |
| `DebuggerSupport/MetricsSupport/EventSourceSupport/MetadataUpdaterSupport=false` | AB102 | 6 项噪声、1 项勉强显著（−1.5%），二进制仅小 2 KB | 不采纳 |
| `UseSizeOptimizedLinq=false` | AB103 | **6/7 显著更慢**（启动 +27%、checkers-8 +12%、declarations +9%），二进制 **+14 MB** | 不采纳（现默认值更优） |

---

## 1. 适配核查：已在用的 .NET 11 特性

| 项 | 状态 | 位置/证据 |
| --- | --- | --- |
| 目标框架 net11.0 + LangVersion 15.0 | 已用 | `Directory.Build.props:3-4`，全仓唯一定义点 |
| Runtime Async（生产） | 已用 | `Features=runtime-async=on`；r19 实测这是 .NET 11 相对 .NET 10 的最大单项优势（net10 经典异步重负载慢 16%~41%） |
| Server GC + DATAS 关闭 | 已用（r18 落地） | `TypeScript.CommandLine.csproj`，重负载比默认快 14%~31% |
| `OptimizationPreference=Speed` | 已用 | `Directory.Build.props:7` |
| `InvariantGlobalization=true` | 已用 | `Directory.Build.props` |
| `SearchValues<byte>`（.NET 8+ API） | 已用于热路径 | `Scanner.cs:23-25` 标识符/注释停止集、`Wtf8.cs:39` 非法前导字节集，配 `IndexOfAny`/`IndexOfAnyExcept` |
| UTF8 `BigInteger.Parse` 重载（.NET 11） | 已用 | `ExpressionTypes.cs`、`TypeInference.Templates.cs`、`Scanner.cs` 共 4 处 |
| NativeAOT 全裁剪 + `IlcTreatWarningsAsErrors` | 已用 | 产品 0 警告发布 |

源码级无遗漏：扫描器与 WTF-8 解码这两个最热的字节搜索路径都已用 `SearchValues`，类型节点的 LINQ 已在 r15/r17 从热路径清除。

---

## 2. 实测的三个候选开关

### 2.1 IlcInstructionSet=avx512（AB101）

动机：本机 CPU（Ryzen 9 8945HX，Zen 4）实测支持 AVX2/AVX512F/AVX512BW/VNNI，而 AOT 默认可移植基线（SSE2），扫描器的向量化路径可能受益。二进制 29,760,512 B（比基线小 19 KB）。

| 负载 | r18 | avx512 | 比值 | CI |
| --- | ---: | ---: | ---: | --- |
| medium | 113.1 | 111.3 | 0.984 | [0.970, 1.001] |
| medium-checkers-1 | 212.8 | 208.3 | 0.978 | [0.948, 1.005] |
| tiny-files | 322.3 | 314.2 | 0.975 | [0.961, 1.002] |
| declarations | 102.9 | 101.8 | 0.989 | [0.957, 1.085] |
| huge-file | 549.9 | 551.2 | 1.002 | [0.990, 1.017] |
| medium-checkers-8 | 113.9 | 114.5 | 1.005 | [0.985, 1.033] |
| version | 56.1 | 57.3 | 1.022 | [0.975, 1.197] |

全部噪声内。控制项 p95rel 16.8%、medianRatio 0.986（CI [0.922, 1.012]）。**结论：收益为零。** 合理解释是本项目热路径以 128 位 UTF-8 处理为主（`SearchValues<byte>` 与 `Vector128` 形态），AVX-512 的 512 位宽度没有对应工作负载；同时启用它会让二进制只能在支持 AVX-512 的 CPU 上运行（官方文档明确桌面场景建议保持默认），零收益换兼容性损失，不采纳。

### 2.2 裁剪开关组合（AB102）

`DebuggerSupport=false`、`MetricsSupport=false`、`EventSourceSupport=false`、`MetadataUpdaterSupport=false`。二进制 29,777,920 B，仅比基线小 2,048 B，说明这些特性在本 SDK 的 AOT 默认裁剪中已被移除，开关接近空操作。计时 6 项噪声、仅 checkers-1 一项 −1.5%（CI [0.968, 0.999] 勉强排除 1.0，在 7 项多重比较下属可解释为偶然）。不采纳。

### 2.3 UseSizeOptimizedLinq=false（AB103）

该属性在 .NET 10+ 随 PublishAot 默认为 true（用体积换 LINQ 吞吐）。本代码库 LINQ 使用面广（关掉后二进制从 29.78 MB 涨到 43.996 MB，+47%），值得实测反向是否更快：

| 负载 | r18 | 完整 LINQ | 比值 | CI |
| --- | ---: | ---: | ---: | --- |
| version | 55.7 | 70.6 | **1.268** | [1.075, 1.291] |
| medium-checkers-8 | 121.2 | 136.3 | **1.124** | [1.073, 1.149] |
| declarations | 105.7 | 114.9 | **1.086** | [1.021, 1.114] |
| medium | 115.0 | 127.6 | 1.109 | [0.998, 1.220] |
| medium-checkers-1 | 215.9 | 224.5 | **1.040** | [1.003, 1.065] |
| tiny-files | 313.9 | 327.3 | **1.043** | [1.033, 1.050] |
| huge-file | 554.3 | 571.2 | **1.031** | [1.015, 1.037] |

**6/7 显著更慢，启动项 +27%**（更大的镜像加载与初始化成本），其余重负载 +3%~12%。现行默认值（size 优化开启）明显更优，本批同时构成了对现有默认值的验证。

---

## 3. 批次有效性

| 批次 | 控制项 p95rel | medianRatio（CI） | 产物断言 |
| --- | ---: | --- | --- |
| AB101 avx512 vs r18 | 16.8% | 0.986（[0.922, 1.012]） | 每配对逐字节一致 |
| AB102 裁剪开关 vs r18 | 26.8% | 0.994（[0.972, 1.030]） | 每配对逐字节一致 |
| AB103 完整 LINQ vs r18 | 25.5% | 0.995（[0.937, 1.029]） | 每配对逐字节一致 |

三批控制项 CI 均含 1.0，槽位无偏置；harness 的每配对产物断言全部通过（三个变体的输出与基线逐字节一致，指令集与裁剪开关不改变编译器行为）。

---

## 4. 结论

1. **留在现行配置**：net11.0 + LangVersion 15 + runtime-async + Server GC（DATAS 关）+ Speed 偏好 + InvariantGlobalization + AOT 全裁剪，是本项目在当前 SDK 下的最优点；三个剩余候选开关均无收益或更差。
2. **AVX-512 留作记录**：若将来出现 512 位向量热路径（例如批量 UTF-8 转码），可重测；当前零收益且损失可移植性。
3. **完整 LINQ 的 +14 MB / +27% 启动代价**从反面证明现行体积优化默认值值得保持。
4. 与 r19 的 .NET 10 结论合并阅读：本项目同时是 .NET 11 的强适配者（runtime-async、UTF8 API、SearchValues 全部在用）与强受益者（同源码 net10 移植后慢 16%~41%）。

---

## 5. 工作树状态

本轮无代码或配置改动（三个变体均不采纳），工作树保持在 `706f6ddab0` 的 net11.0 状态并已通过验证构建（0 警告 / 0 错误）。变体产物（`pkgs/r20a/b/c`）与批次数据保留在 harness 工作区供复测，不进入仓库。
