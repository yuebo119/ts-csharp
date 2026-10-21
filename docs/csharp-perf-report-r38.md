# r38 从零重建基线 + 四方全量对比（2026-10-16）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-16 ｜ 轮次: r38 ｜ 主题: from-scratch-rebaseline + three-way-comparison
> 触发: 用户指令「进行一次全面的性能测试，重建基线，重新测试go版本，和c#版本，给出完整的真实的，性能对比结果表格」
> 数据来源: `bench/AB149`（当前 vs C# 基线）、`bench/AB150`（当前 vs Go 默认）、`bench/AB151`（当前 vs Go@400）、`bench/AB152`（基线 vs Go 默认），每批 23 负载 × 15 组交替配对；分配侧为四个二进制在同一夹具直接运行（各 3 组）；峰值 RSS 同采集器
> 产物: `pkgs/r38-{go,cs,base}` + `manifests/r38-{go,cs,base}.json`

## 1. 结论摘要

三个测量侧全部从源码重建，未使用任何历史测试数据、未复用任何历史二进制：

| 侧 | 源码节点 | 构建 | 与历史二进制的关系 |
| --- | --- | --- | --- |
| Go 参考 | TypeScript 仓 `6ed638d3a5`（campaign 锚节点） | go1.27.1；`CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -ldflags="-s -w" -tags=noembed`（git 工作树构建，vcs 戳入像） | **sha256 `5e46cd5d15187a3c…` 与 r34 fresh 产物逐字节一致**，参考侧完全可复现 |
| C# 优化前基线 | 本仓 init `2aaad02`（树 = Steven He 收尾态；已核验与 TypeScript 仓 `6ed638d3a5:csharp` 内容逐字节相同） | NativeAOT publish（`-p:PublishAot=true -p:TypeScriptExecutableName=tsc -p:EmbedTypeScriptLibraries=false`，SDK 11.0.100-rc.2.26504.105） | 同夹具分配读数与历史 `naot-svr` 二进制差 **0.07%**；输出与 Go/当前逐字节一致（§4） |
| C# 当前 | 本仓 HEAD `24c2c3b` | 同上 | Release 0/0；safety 91/93 失败集合 ⊆ 文档基线 |

全量复测结果（23 行 × 15 对，四批控制组 CI 均含 1.0、0 弃对、`inputsSha256` 四批一致 `b1fd524ccfb8…`、逐字节断言全过）：

| 分组 | 对 C# 基线 | 对 Go 默认 | 对 Go@400 | 基线对 Go 默认 |
| --- | ---: | ---: | ---: | ---: |
| 重负载 11 项 | **+46.3%** | **x1.384** | x1.457 | x2.693 |
| 轻负载 12 项 | −4.4% | x1.347 | x1.381 | x1.293 |

对 Go 的站位与此前四次全量测量（x1.396 / x1.423 / x1.397 / x1.398）一致，真实值在 **x1.40** 附近，本轮读数落在锚带下沿。分配（真实工程，同夹具）：基线 1,163.1 MB → 当前 950.2 MB，**−18.3%**，与历史 −18.0% 一致；当前相对 r34 期二进制再 −0.8%。**机器态无 r36 类异常**：四批控制组比值方向不一（0.9977 / 1.0082 / 0.9700 / 1.0050），全部 C# 二进制未共同变慢。

## 2. 四个测量节点

| 节点 | 标识 | 构建 / 运行配置 | 数据批次 |
| --- | --- | --- | --- |
| **Go 参考基准** | `pkgs/r38-go`（sha256 `5e46cd5d1518…`，与 r34 fresh 逐字节一致） | go1.27.1；`-tags=noembed`；`GOGC=100` | AB150 / AB152 |
| **Go@400** | 同一 `r38-go` 二进制 + `GOGC=400` | 同上（审计调优口径） | AB151 |
| **C# 优化前基线** | `pkgs/r38-base`（sha256 `9a4befa3fc86…`，本仓 init 源码重建） | NativeAOT noembed 形态；出厂默认 GC（DATAS 开） | AB149 / AB152 |
| **C# 当前（r38 节点）** | `pkgs/r38-cs`（sha256 `b0d3ad1f033c…`，HEAD `24c2c3b`） | NativeAOT noembed 形态 + Server GC + DATAS 关闭 + r06~r38 全部改动 | 全部四批 |

四批均以 `--no-gc-env` 运行（产品各自烤制的 GC 配置生效，与 r34 锚批次同协议），`inputsSha256` 四批一致（`b1fd524ccfb8aa10`，与历史全部批次同夹具）。分配与 RSS 侧为夹具内直接运行（3 组），不经配对驱动。

## 3. 耗时对比（ms，中位数；比值来自同批配对）

| 负载 | Go 默认 | Go@400 | C# 基线 | C# 当前 | **改善%**（对基线） | 95% CI | 对比 Go 默认 | 对比 Go@400 | 基线 vs Go 默认 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| **huge-file** | 383.4 | 378.9 | 1,517.7 | **534.5** | **+64.8%** | [0.35, 0.36] | **x1.369** | x1.369 | x3.884 |
| **medium** | 91.0 | 84.4 | 283.7 | **111.1** | **+60.8%** | [0.38, 0.41] | **x1.248** | x1.317 | x2.975 |
| **medium-checkers-8** | 90.8 | 87.7 | 273.0 | **110.1** | **+59.7%** | [0.39, 0.41] | **x1.222** | x1.316 | x3.078 |
| **medium-checkers-4** | 92.8 | 85.1 | 271.3 | **123.7** | **+54.4%** | [0.45, 0.46] | **x1.323** | x1.466 | x2.960 |
| **medium-256m-heap-setting** | 92.0 | 85.1 | 280.8 | **117.3** | **+58.2%** | [0.40, 0.44] | **x1.245** | x1.326 | x2.964 |
| **declarations** | 85.9 | 78.7 | 204.0 | **99.2** | **+51.4%** | [0.47, 0.51] | **x1.163** | x1.258 | x2.355 |
| **medium-checkers-2** | 95.5 | 89.2 | 289.1 | **154.6** | **+46.5%** | [0.52, 0.57] | **x1.586** | x1.683 | x2.937 |
| **medium-checkers-1** | 104.2 | 99.8 | 299.8 | **202.0** | **+32.6%** | [0.67, 0.69] | **x1.973** | x2.028 | x2.852 |
| **tiny-files-noemit-on-error** | 234.1 | 232.7 | 469.1 | **325.4** | **+30.6%** | [0.66, 0.73] | **x1.358** | x1.366 | x1.920 |
| **tiny-files** | 234.5 | 229.5 | 435.0 | **322.3** | **+25.9%** | [0.72, 0.76] | **x1.358** | x1.375 | x1.846 |
| **tiny-files-incremental-edit** | 261.6 | 238.5 | 501.0 | **380.3** | **+24.1%** | [0.74, 0.79] | **x1.380** | x1.527 | x1.857 |
| tiny-files-noemit | 120.6 | 110.0 | 150.1 | 159.4 | −6.2% | [1.03, 1.15] | x1.287 | x1.391 | x1.196 |
| host-paths | 53.6 | 52.7 | 92.0 | 96.3 | −4.7% | [1.02, 1.10] | x1.782 | x1.787 | x1.638 |
| project-references-clean | 56.6 | 55.1 | 79.4 | 82.4 | −3.8% | [1.00, 1.07] | x1.449 | x1.481 | x1.405 |
| project-references-noop | 49.5 | 48.6 | 59.9 | 62.6 | −4.4% | [1.03, 1.08] | x1.306 | x1.317 | x1.246 |
| project-references-implementation | 55.5 | 53.4 | 71.0 | 73.3 | −3.3% | [1.01, 1.06] | x1.307 | x1.359 | x1.277 |
| project-references-declaration | 57.0 | 55.6 | 82.9 | 84.5 | −1.9% | [0.98, 1.06] | x1.456 | x1.498 | x1.446 |
| project-references-config | 54.5 | 53.3 | 68.8 | 70.8 | −2.9% | [1.01, 1.06] | x1.312 | x1.371 | x1.297 |
| project-references-package | 55.0 | 53.8 | 81.7 | 83.4 | −2.1% | [0.99, 1.07] | x1.462 | x1.507 | x1.382 |
| small-first-diagnostic | 52.2 | 51.3 | 64.7 | 68.1 | −5.1% | [0.93, 1.17] | x1.290 | x1.322 | x1.252 |
| empty-project | 48.0 | 47.4 | 57.1 | 60.8 | −6.4% | [1.03, 1.18] | x1.214 | x1.225 | x1.165 |
| version（启动） | 47.2 | 46.6 | 53.5 | 55.5 | −3.8% | [1.01, 1.25] | x1.148 | x1.155 | x1.095 |
| help（启动） | 47.7 | 47.3 | 52.7 | 56.9 | −7.9% | [1.03, 1.11] | x1.150 | x1.158 | x1.114 |

改善% 列的中位数与 CI 来自 AB149 同批配对（当前 ÷ 基线）；Go 比值列分别来自 AB150/AB151/AB152 同批配对；不同列的绝对中位数来自不同批次，**跨批不可直接比较**（本机漂移 10~60%），只与同批对照组比值。

### 汇总

| 分组 | 项数 | 平均改善（对基线，AB149） | 平均落后 Go 默认（AB150） | 平均落后 Go@400（AB151） | 基线落后 Go 默认（AB152） |
| --- | ---: | --- | ---: | ---: | ---: |
| 重负载（medium 族 6 + 512 文件族 3 + 巨文件 + 声明） | 11 | **+46.3%**（+24.1% ~ +64.8%） | **x1.384** | **x1.457** | **x2.693** |
| 轻负载（启动、单诊断、工程引用、noemit） | 12 | −4.4% | x1.347 | x1.381 | x1.293 |

战役总位移：重负载族对 Go 默认从 **x2.693**（优化前基线）收到 **x1.384**（当前），差距压缩 48.6%。

## 4. 门禁状态（全部本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `dotnet build csharp/TypeScript.slnx -c Release -p:UseSharedCompilation=false` | **0 警告 0 错误**（60.4 s） |
| safety 套件（93 直接可调用旗标） | **91/93**，失败 {`--program-emit-safety`, `--checker-relation-context-safety`} ⊆ 文档基线，SUITE-OK |
| 逐字节产物等价（`perf-verify` 6 夹具 × 三方） | 当前 / 基线 / Go **三方全等**（退出码 + stdout + 201 个发射产物哈希） |
| AB 批次逐对断言（文件/诊断/发射字节） | 4 批 × 23 负载 × 15 对全部通过（等价三角形：当前≡Go、基线≡Go、当前≡基线） |
| Go 参考可复现性 | sha256 与 r34 fresh 产物逐字节一致 |
| 基线重建可信度 | 同夹具分配读数与历史 `naot-svr` 二进制差 0.07%（1,163.1 vs 1,163.9 MB） |
| 25 夹具 full bytecheck | 本轮未跑（6 夹具 perf-verify + AB 逐对断言覆盖；历史门禁形态，记录为未复跑项） |

## 5. 分配对比

### 5.1 真实工程（`packages/typescript@6ed638d3a5`，fresh copy + `--extendedDiagnostics`，各 3 组）

| 节点 | CLR 总分配 | 相对上一节点 | 相对优化前基线 |
| --- | ---: | ---: | ---: |
| **C# 优化前基线（r38-base，init 源码重建）** | **1,163.1 MB**（三组 1,163.0 / 1,163.1 / 1,163.1，带宽 <0.01%） | — | — |
| **C# 当前（r38-cs，HEAD）** | **950.2 MB**（三组 950.2 / 950.2 / 950.3，带宽 <0.01%） | — | **−18.3%** |
| 参照：历史 `naot-svr` 二进制（同夹具） | 1,163.9 MB | — | 验证基线重建（+0.07%） |
| 参照：历史 r34 期二进制（同夹具） | 957.6 MB | — | 当前较 r34 期再 **−0.8%** |

GC 环境不影响该读数（实测产品配置 950.5/950.4 MB vs 工作站配置 950.7/950.6 MB，差 0.02%），分配量由源码与夹具决定。

**夹具口径披露（必读）**：本夹具文件图 **291** 个源文件（113 src + 178 lib/@types）。历史锚点（r32/r34/r35 的 1,221.7 / 1,001.7 / 998.7 MB）测于 **326** 文件图（多 35 个 `dist/enums/*.enum.d.ts`）。差异根因已用 `--traceResolution` 在全部四个二进制上定位：当前工具链把 `#enums/*` 的 package.json imports 目标（`dist/enums/X.enum.d.ts`）**代换到 `src/enums/X.enum.ts`**（Go、r34 期、基线、当前四侧行为完全一致，各 116 处、0 处落入 dist），因此 dist 枚举不再进入文件图。历史二进制在同一 291 图上同样读低 ~4.7%（naot-svr 1,163.9 vs 1,221.7；r34 期 957.6 vs 1,001.7），证明偏移全部来自夹具图而非二进制。**同夹具内的基线 vs 当前比较（−18.3%）不受影响**；绝对值与历史 326 图锚点不可直接对比（按 1.046 的图系数折算，当前约 994 MB、基线约 1,217 MB，与历史锚同量级）。

### 5.2 仓内夹具（`perf-fixtures` 族，CLR 总分配，各 3 组中位）

| 夹具 | 基线 | 当前 | 改善 |
| --- | ---: | ---: | ---: |
| medium | 440.5 MB | 308.8 MB | **−29.9%** |
| huge | 1,231.5 MB | 557.2 MB | **−54.8%** |
| dtsheavy | 279.9 MB | 227.9 MB | −18.6% |
| tiny512 | 289.9 MB | 240.6 MB | −17.0% |
| inc512 | 333.3 MB | 294.4 MB | −11.7% |

（基线节点无分相位归因，`Alloc check/emit (summed)` 读数缺失属预期；总分配两节点都有。）

### 5.3 峰值 RSS（真实工程，同采集器；口径为进程峰值工作集）

| 配置 | 峰值 RSS |
| --- | ---: |
| 当前 @ Server GC（产品配置） | 832 MB（817/849/832） |
| 当前 @ 工作站 GC | 282 MB（282/284） |
| 基线 @ 工作站 GC（出厂配置） | 257 MB（253/257/261） |
| 基线 @ Server GC（注入无效，仍按烤制配置运行） | 282 MB（286/280/280） |
| Go 参考 @ GOGC=100（默认） | 320 MB |
| Go 参考 @ GOGC=off | 390 MB |

**RSS 不可跨配置比较**：Server GC 多堆预留使当前产品配置读数 ~3 倍于工作站配置（与 method.md §6 / perf-budgets §4 记载一致），基线二进制忽略 GC 环境注入（烤制配置优先）。同配置下（工作站）当前 282 vs 基线 257 MB（+10%，二进制增大与 Server 时代代码路径的固定成本）。Go 的 GOGC=off 读数是堆高水位代理，与 CLR 累计分配字节（950 MB）是不同指标，**不做倍数比较**（ledger「分配相对 Go」行维持待重设状态）。

### 5.4 逐负载峰值 RSS（AB150 同批比值，唯一合法用法）

| 负载族 | Go RSS | C# RSS | 比值 |
| --- | ---: | ---: | ---: |
| 启动/help/version | 10~16 MB | 14~16 MB | x1.35~1.43 |
| medium 族 | 57~60 MB | 84~92 MB | x1.40~1.59 |
| tiny-files 族 | 40~64 MB | 118~193 MB | **x2.97~3.64** |
| huge-file | 163 MB | 339 MB | x2.08 |
| project-references 族 | 12~22 MB | 15~27 MB | x1.09~1.24 |

## 6. 批次有效性

| 批次 | 用途 | 控制组 medianRatio（CI） | p95rel | 弃对 | 逐行 p95/min（双槽，控流行除外） |
| --- | --- | --- | ---: | ---: | --- |
| AB149 | 当前 vs 基线 | 0.9977（[0.975, 1.012]） | 18.4% | 0 | 23/23 通过（最大 1.60，version:after） |
| AB150 | 当前 vs Go 默认 | 1.0082（[0.858, 1.084]） | 18.8% | 0 | 23/23 通过（最大 1.67，tiny-files:go） |
| AB151 | 当前 vs Go@400 | 0.9700（[0.880, 1.134]） | 21.9% | 0 | 23/23 通过（最大 1.50，tiny-files:go） |
| AB152 | 基线 vs Go 默认 | 1.0050（[0.878, 1.144]） | 19.0% | 0 | 23/23 通过（最大 1.65，tiny-files:go） |

（p95/min 按双槽各自计算后取最大值，口径同 r34/r36； pooled 双槽混算会把慢槽方差放大，不作判据。）

四批 `inputsSha256` 一致、`--no-gc-env` 全部生效、逐字节断言全过。重负载行 CI 全部紧且远离 1.0；轻负载行按不可分辨读（标准警示：startup 主导行差异 1~4 ms、方向不均匀、CI 多跨 1.0，不构成代码回归信号）。

## 7. 机器态披露

- 主机 AMD Ryzen 9 8945HX（16C/32T）、32 GiB、Windows 10；测量窗口 2026-10-16 17:19~17:31。
- 四批记录的外扰 CPU（>0.5 s 阈值）：宿主 ZCode 进程 150~228 CPU-s/批（本会话自身的 agent 运行时与驱动壳）、批 A 另有 Roslyn `VBCSCompiler` 43.1 s（publish 残留，批 A 早期）、输入法与桌面组件 <8 s。按批时长折算宿主占用 ~0.3 核/批（<2% 整机）。
- **无 r36 类机器态异常**：该异常签名是「同一 C# 二进制隔日 wall +34% 且全部 C# 二进制共同变慢、Go 稳定」。本轮四批控制组比值方向不一（0.9977/1.0082/0.9700/1.0050）、C# 侧绝对值与 r34 期同夹具读数一致（huge-file 534.5 vs r34 fresh 517.5，+3.3%；version 55.5 vs 54.2，+2.4%），Go 侧稳定（huge-file 383.4 vs 376.3/385.7），比值落在锚带内。

## 8. 已知例外（非回潮）

- **轻负载 12 项对基线 −4.4%**（version −3.8%、help −7.9%、empty −6.4%）：与 r34-rebaseline 同向同量级（−4.0~−6.4%）。真因是历史基线二进制带旧工具链签名造成的假象被剥离后，当前在启动地层的真实站位（二进制 +5.6% 体积、Server GC 初始化、substrate 差距，r30 host-paths 定论）；不读作 r38 新增回归。version 行 CI [1.01, 1.25] 宽，gate 判 inconclusive。
- tiny-files-noemit 对基线 −6.2%：r18 DATAS 关闭的既有代价，预算已知例外。
- host-paths x1.78：启动地板负载，substrate 差距，本仓不可修。

## 9. 与预算契约的关系（perf-budgets.md §2）

| 指标 | 预算 | 本轮实测 | 判定 |
| --- | --- | --- | --- |
| 重负载墙钟平均（11 负载族）对 Go 默认 | ≤ x1.50 | **x1.384** | 内（锚带 x1.398~1.423 下沿） |
| 最差单负载 medium-checkers-1 | ≤ x2.20 | x1.973 | 内 |
| 巨文件 | ≤ x1.55 | x1.369 | 内 |
| 启动类负载（version/help/empty-project） | ≤ x1.35 | x1.148~x1.214 | 内 |
| 真实工程 CLR 总分配 | ≤ 1,050 MB | 950.2 MB（291 图口径） | 内（326 图折算 ~994 MB 亦内） |
| 产物等价 | 逐字节 100% | 6 夹具三方全等 + AB 逐对断言 | 内（25 夹具 full gate 未复跑，见 §4） |
| safety 套件 | ≥ 90/95 且失败 ⊆ 基线 | 91/93 ⊆ 基线 | 内 |
| 构建红线 | Release 0/0 | 0/0 | 内 |

## 10. 复现指引

```bash
# Go 参考（TypeScript 仓 6ed638d3a5 的 git 工作树，vcs 戳入像是逐字节复现的必要条件）
cd <TypeScript 仓> && git worktree add --detach <wt> 6ed638d3a5
cd <wt>/tsc && CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -ldflags="-s -w" -tags=noembed ./cmd/tsc

# C# 基线（本仓 init 树）+ lib 供给（该节点 csproj 从 ../../../tsc/internal/bundled/libs 取 lib）
git -C <ts-csharp> archive 2aaad02 csharp | tar -x -C <base-src>
cp -r <wt>/tsc/internal/bundled/libs <base-src>/tsc/internal/bundled/
cd <base-src>/csharp && dotnet publish src/TypeScript.CommandLine/TypeScript.CommandLine.csproj \
  -c Release -r win-x64 -p:PublishAot=true -p:TypeScriptExecutableName=tsc \
  -p:EmbedTypeScriptLibraries=false -p:UseSharedCompilation=false -o <out>

# C# 当前：同命令于 HEAD 工作树（lib 由 csharp/external/tsc/internal/bundled/libs 供给）

# 四批配对（campaign 扩展驱动 = 仓内 performance-cli.mjs + --no-gc-env/per-backend env；r38 驱动副本文末）
node perf-cli.mjs --manifest manifests/r38-cs.json --baseline-manifest manifests/r38-base.json \
  --no-gc-env --samples 15 --directory bench/AB149-r38-current-vs-baseline
node perf-cli.mjs --manifest manifests/r38-cs.json --go-executable pkgs/r38-go/lib/tsc.exe \
  --no-gc-env --samples 15 --directory bench/AB150-r38-current-vs-go-default
node perf-cli.mjs --manifest manifests/r38-cs.json --go-executable pkgs/r38-go/lib/tsc.exe \
  --go-env GOGC=400 --no-gc-env --samples 15 --directory bench/AB151-r38-current-vs-go400
node perf-cli.mjs --manifest manifests/r38-base.json --go-executable pkgs/r38-go/lib/tsc.exe \
  --no-gc-env --samples 15 --directory bench/AB152-r38-baseline-vs-go-default

# 分配（真实工程夹具：src + dist/enums 35 声明 + @types/node@22.20.1；每次 fresh copy）
node r38-measure-real.mjs 3
```

驱动说明：r38 使用 tsbench campaign 驱动副本（`tsbench/r38/driver/perf-cli.mjs`，与仓内 `csharp/tools/performance-cli.mjs` 的唯一差异是 `--no-gc-env` 与 per-backend 环境变量两个 campaign 扩展；其 `common.mjs` import 已重定向到本仓）。summary.json 中 `binaries.driver` 记录的是仓内驱动哈希（驱动代码内硬编码路径），实际运行的是上述副本，特此披露。
