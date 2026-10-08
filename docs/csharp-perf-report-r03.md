> **元数据** ｜ 类型: report ｜ 日期: 2026-10-08 ｜ 轮次: r03 ｜ 主题: baseline-vs-latest
> 涉及 git 节点: `6ed638d3a5`（优化前基准） / `c929d92b44`（最新，代码节点 `aaafb7ab58`） ｜ 数据来源: `bench/AB37`、`bench/AB33`、`bench/AB35`
> 状态: **当前权威对比表** ｜ 关联: `plans/plan_2026-10-08_r03_baseline-corrected.md`
# C# 编译器性能三态对比：Go 基准 / C# 优化前基准 / C# 最新代码

- 只对比**三个节点**：Go 参考基准、C# 优化前基准、C# 最新代码。已剔除所有"工作区连续快照"（final/final2…final6）数据。
- 所有数值带单位；所有列标注所属 git 提交节点。
- 「改善%」= **相对 C# 优化前基准**的改善（正=更快）；另加**对 Go 基准的对比%**（正=比 Go 慢）。

---

## 0. 三个测量节点（git 提交标识）

| 节点 | git 提交 | 构建与运行配置 | 实测批次 |
| --- | --- | --- | --- |
| **Go 参考基准** | **`6ed638d3a5`**<br>`6ed638d3a5c8098dbdb8281a1cc58f4ddc67d515`<br>（由二进制内嵌 `build vcs.revision` 确证，`vcs.modified=false`） | go1.27.1；`-tags=noembed -trimpath CGO_ENABLED=0 GOAMD64=v1`；运行：出厂默认 `GOGC=100`（另附审计口径 `GOGC=400`） | 默认：AB28 批次<br>调优：AB33 批次 |
| **C# 优化前基准** | **`6ed638d3a5`**（同一提交）<br>csproj **无任何 GC 设置** → NativeAOT 出厂默认（工作站 GC、默认 gen0/LOH） | 二进制 `pkgs/naot-svr`（2026-10-06 20:05 构建；已用字节级检索确证不含任何本次改动的特征串） | **AB34 批次**（与"最新"同批配对） |
| **C# 最新代码** | 分支尖端 **`c929d92b44`**<br>代码节点 **`aaafb7ab58`**（二者代码完全相同，尖端仅多 3 个文档文件） | AOT；工作站 GC + `gen0size=4MiB`、`LOHThreshold=1MiB`（写进 csproj 并由启动器导出） | **AB34**（vs C# 基准）<br>**AB33**（vs Go） |

> 关键更正：本报告之前所有「优化前」数据取自 **R1 批次**，该批次给基线额外传了 `--server-gc`（Server GC 在多文件负载上比出厂默认慢 5–11%），**并非出厂状态**。本文以**出厂默认 GC 的基线**（AB34）为准，结果因此更保守、也更真实。

---

## 1. 耗时对比（单位：毫秒 ms，中位数）

| 负载 | Go 默认<br>(ms) | Go@400<br>(ms) | C# 基准<br>(ms) @`6ed638d3a5` | C# 最新<br>(ms) @`c929d92b44` | **改善%**<br>（vs C# 基准） | C# 最新 vs<br>Go@400 | C# 最新 vs<br>Go 默认 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **medium** | 91.5 ms | 81.5 ms | 260.1 ms | **154.6 ms** | **+40.6%** | +94% | +80% |
| **medium-256m-heap** | 99.2 ms | 80.9 ms | 257.0 ms | **157.0 ms** | **+38.9%** | +97% | +86% |
| **medium-checkers-8** | 95.4 ms | 80.1 ms | 251.3 ms | **157.1 ms** | **+37.5%** | +98% | +81% |
| **medium-checkers-4** | 96.9 ms | 79.8 ms | 260.5 ms | **166.3 ms** | **+36.2%** | +108% | +95% |
| **tiny-noemit-on-error** | 246.2 ms | 223.7 ms | 437.1 ms | **286.3 ms** | **+34.5%** | +37% | +33% |
| **tiny-files**（512 个文件） | 243.5 ms | 220.5 ms | 417.3 ms | **284.8 ms** | **+31.8%** | +36% | +27% |
| **tiny-incremental-edit** | 285.9 ms | 230.9 ms | 467.4 ms | **328.2 ms** | **+29.8%** | +43% | +40% |
| **medium-checkers-2** | 102.0 ms | 85.1 ms | 264.5 ms | **192.0 ms** | **+27.4%** | +128% | +112% |
| **declarations** | 83.0 ms | 74.3 ms | 191.1 ms | **143.6 ms** | **+24.9%** | +98% | +81% |
| **huge-file** | 379.0 ms | 367.6 ms | 1,385.6 ms | **1,122.4 ms** | **+19.0%** | +211% | +220% |
| **medium-checkers-1** | 115.9 ms | 91.8 ms | 286.4 ms | **251.1 ms** | **+12.3%** | +180% | +156% |
| help（启动） | 47.5 ms | 45.5 ms | 52.0 ms | 54.4 ms | **−4.6%** | +20% | +16% |
| version（启动） | 45.9 ms | 45.0 ms | 52.0 ms | 53.6 ms | **−3.1%** | +17% | +17% |
| empty-project | 47.0 ms | 45.1 ms | 55.5 ms | 57.9 ms | **−4.2%** | +23% | +25% |
| small-first-diagnostic | 51.2 ms | 48.7 ms | 64.0 ms | 69.3 ms | **−8.3%** | +42% | +38% |
| host-paths | 54.3 ms | 53.5 ms | 89.9 ms | 93.3 ms | **−3.8%** | +94% | +90% |
| tiny-noemit | 117.2 ms | 112.3 ms | 127.4 ms | 136.2 ms | **−6.9%** | +33% | +19% |
| pr-clean | 60.5 ms | 52.1 ms | 77.1 ms | 80.2 ms | **−4.0%** | +56% | +55% |
| pr-noop | 56.3 ms | 46.2 ms | 58.1 ms | 60.0 ms | **−3.3%** | +31% | +30% |
| pr-implementation | 64.7 ms | 50.4 ms | 67.0 ms | 72.0 ms | **−7.5%** | +45% | +48% |
| pr-declaration | 62.4 ms | 52.6 ms | 77.3 ms | 83.0 ms | **−7.3%** | +57% | +56% |
| pr-config | 59.1 ms | 50.2 ms | 66.4 ms | 71.7 ms | **−8.1%** | +45% | +37% |
| pr-package | 61.0 ms | 51.2 ms | 76.1 ms | 79.9 ms | **−4.9%** | +58% | +53% |

**汇总**

| 分组 | 项数 | 平均改善 | 区间 |
| --- | ---: | ---: | --- |
| 重负载（medium 族、512 文件族、巨文件、声明） | 11 | **+30.3%** | +12.3% ~ +40.6% |
| 轻负载（启动、单诊断、工程引用、noemit、无注释小工程） | 12 | **−5.5%（变慢）** | 慢 3.1% ~ 8.3% |
| 全部 | 23 | +11.6% | — |

> 「改善%」来自 **AB34 同批配对实测**（15 组，噪声 7.2%），12 项回退的 95% CI 全部排除 1.0，即**统计显著**。绝对值列取自各自批次（Go@400 来自 AB33、Go 默认来自 AB28、两侧 C# 均来自 AB34）；本机绝对时间不可跨批次直接相除，「改善%」与「vs Go」才是同批配对的可靠量。

---

## 2. 峰值内存对比（单位：MiB）

| 负载 | Go 默认<br>(MiB) | Go@400<br>(MiB) | C# 基准<br>(MiB) @`6ed638d3a5` | C# 最新<br>(MiB) @`c929d92b44` | **降幅%**<br>（vs C# 基准） | C# 最新 ÷<br>Go@400 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **huge-file** | 160.6 MiB | 194.4 MiB | 237.5 MiB | **175.9 MiB** | **−25.9%** | **0.90×** |
| medium-checkers-1 | 56.8 MiB | 58.8 MiB | 55.5 MiB | **43.1 MiB** | **−22.3%** | **0.73×** |
| medium-checkers-2 | 59.2 MiB | 59.4 MiB | 54.8 MiB | **45.4 MiB** | **−17.2%** | **0.76×** |
| medium-checkers-4 | 59.5 MiB | 60.0 MiB | 55.0 MiB | **45.8 MiB** | **−16.7%** | **0.76×** |
| tiny-incremental-edit | 64.2 MiB | 70.1 MiB | 44.6 MiB | **37.3 MiB** | **−16.4%** | **0.53×** |
| declarations | 54.3 MiB | 55.7 MiB | 55.2 MiB | **47.5 MiB** | **−13.9%** | **0.85×** |
| medium | 59.8 MiB | 60.0 MiB | 55.0 MiB | **47.8 MiB** | **−13.1%** | **0.80×** |
| medium-checkers-8 | 59.2 MiB | 61.6 MiB | 54.7 MiB | **47.4 MiB** | **−13.3%** | **0.77×** |
| medium-256m-heap | 59.6 MiB | 60.1 MiB | 55.0 MiB | **47.4 MiB** | **−13.8%** | **0.79×** |
| tiny-files | 50.3 MiB | 52.6 MiB | 40.8 MiB | **36.5 MiB** | **−10.5%** | **0.69×** |
| tiny-noemit-on-error | 54.6 MiB | 61.3 MiB | 41.1 MiB | **38.5 MiB** | **−6.3%** | **0.63×** |
| version / help | 10.0 / 10.3 MiB | 10.1 / 10.3 MiB | 10.4 / 11.0 MiB | **10.4 / 10.9 MiB** | ≈0% | 1.03× / 1.06× |
| empty-project | 11.7 MiB | 11.6 MiB | 13.2 MiB | 13.3 MiB | +0.8% | 1.15× |
| pr-noop | 12.4 MiB | 12.4 MiB | 12.3 MiB | 12.3 MiB | ≈0% | **0.99×** |
| tiny-noemit | 39.3 MiB | 39.7 MiB | 33.3 MiB | 33.8 MiB | +1.5% | **0.85×** |
| pr-package | 20.3 MiB | 17.7 MiB | 21.4 MiB | 22.5 MiB | +5.1% | 1.28× |
| pr-clean | 21.4 MiB | 18.8 MiB | 23.0 MiB | 23.7 MiB | +3.0% | 1.26× |
| pr-declaration | 21.5 MiB | 19.1 MiB | 23.5 MiB | 24.0 MiB | +2.1% | 1.25× |
| host-paths | 18.9 MiB | 17.3 MiB | 20.0 MiB | 22.8 MiB | **+14.0%** | 1.32× |
| pr-implementation | 20.9 MiB | 18.2 MiB | 19.7 MiB | 23.2 MiB | **+17.8%** | 1.28× |
| pr-config | 20.5 MiB | 18.0 MiB | 19.4 MiB | 23.2 MiB | **+19.6%** | 1.29× |
| small-first-diagnostic | 18.1 MiB | 16.5 MiB | 18.4 MiB | 22.4 MiB | **+21.7%** | 1.36× |

**汇总**

| 维度 | 结果 |
| --- | --- |
| 重负载内存 | 全部下降，**huge-file −25.9%** 最大 |
| 轻负载内存 | **多数变差**（pr-config +19.6%、small-diag +21.7%），因 gen0 预算放大到 4 MiB |
| 23 项平均 RSS | 下降 **3.7%** |
| 低于 Go@400 的负载数 | **13 / 23** |

---

## 3. 确定性证据（单位：MB / 秒 s，逐字节可复现）

分阶段分配（巨文件）：

| 阶段 | C# 基准 (MB) @`6ed638d3a5` | C# 最新 (MB) @`c929d92b44` | 变化 |
| --- | ---: | ---: | ---: |
| **总计** | **960.1 MB** | **519.7 MB** | **−45.9%** |
| 程序构建 program | 63.9 MB | 63.8 MB | 持平 |
| 解析 parse | 42.2 MB | 42.2 MB | 持平 |
| 绑定 bind | 20.9 MB | 20.9 MB | 持平 |
| 检查 check | 183.0 MB | 183.2 MB | 持平（未触碰） |
| **发射 emit** | **711.7 MB** | **271.3 MB** | **−61.9%** |
| ├ 变换 transform | 124.2 MB | 124.2 MB | 持平（未触碰） |
| └ **打印 print** | **587.4 MB** | **147.0 MB** | **−75.0%** |

AOT 分阶段时间（巨文件，5 次取优）：

| 阶段 | C# 基准 (s) @`6ed638d3a5` | C# 最新 (s) @`c929d92b44` | 变化 |
| --- | ---: | ---: | ---: |
| 解析 / 绑定 / 检查 | 0.071 / 0.063 / 0.324 s | 0.069 / 0.052 / 0.326 s | −3% / −17% / 持平 |
| **发射 emit** | **1.064 s** | **0.618 s** | **−42.0%** |
| **总计 total** | **1.621 s** | **1.175 s** | **−27.5%** |
| （Go@400 同负载参考） | 0.368 s | 0.368 s | — |

---

## 4. 轻负载回退的归因（AB35 实测）

把两侧 GC 配置**对齐**（都用法出厂默认 gen0/LOH）后重测，用以区分"代码变化"与"GC 调优"：

| 负载 | 含 GC 调优<br>(AB34 比值) | 仅代码变化<br>(AB35 比值) | GC 调优的贡献 |
| --- | ---: | ---: | ---: |
| help | 1.046× | 1.042× | +0.4% |
| version | 1.031× | 1.041× | −1.0% |
| empty-project | 1.042× | 1.044× | −0.2% |
| small-first-diagnostic | 1.083× | 1.037× | +4.4% |
| tiny-files-noemit | 1.069× | 1.013× | +5.6% |
| pr-implementation | 1.075× | 1.034× | +4.0% |
| pr-config | 1.081× | 0.991× | +9.1% |
| **medium** | 0.594× | 0.623× | **−4.6%** |
| **declarations** | 0.751× | 0.769× | **−2.3%** |
| **huge-file** | 0.810× | 0.888× | **−8.8%** |

**结论**：

1. **纯启动类（help/version/empty）的回退几乎全部来自代码/镜像变化**（+4.1~4.4%），与 GC 配置无关——这三项不编译任何文件，说明是 AOT 镜像布局/体积变化导致的进程启动差异。
2. **小文件族的额外回退主要来自 gen0/LOH 调优**（+4.0~9.1%），但同一调优在重负载上回收 2.3~8.8%（huge-file −8.8% 最明显）。
3. 因此当前 GC 配置是**"以小型负载 +4~9% 时间换取重负载 −2~−9% 时间与内存下降"**的取舍，并非普适最优。

---

## 5. 诚实结论

**改善（相对出厂默认 GC 的 C# 基准，同批配对实测）**

1. **重负载 11 项平均快 30.3%**，区间 +12.3% ~ +40.6%；最大来自 medium 族（+40.6% / +38.9% / +37.5% / +36.2%）与 512 文件族（+34.5% / +31.8% / +29.8%）。
2. **巨文件快 19.0%**（1,385.6 → 1,122.4 ms），其发射阶段快 42%、打印分配降 75.0%、总分配降 45.9%。
3. **巨文件内存降 25.9%**（237.5 → 175.9 MiB），并在此负载上首次低于 Go@400（0.90×）。
4. 全部 23 项**平均改善 11.6%**、平均内存下降 3.7%。

**回退（必须承认）**

1. **轻负载 12 项平均慢 5.5%**（慢 3.1% ~ 8.3%），CI 全部排除 1.0。
2. 其中 **help/version/empty 的 +3~4% 由代码/镜像变化造成**（AB35 归因），属需修正的真实回退；**小文件族的额外 +4~9% 来自 gen0/LOH 调优**。
3. **部分轻负载内存也变差**（pr-config +19.6%、small-diag +21.7%），同样是 4 MiB gen0 预算所致。

**对 Go 的对比（同批配对）**

- 以 **Go@400** 为参照：C# 最新在重负载上仍慢 **+36% ~ +211%**（medium +94%、declarations +98%、huge-file +211%），在部分小工程上慢 +17% ~ +58%。
- 以 **Go 默认 GOGC=100** 为参照：数值略优（medium +80%、declarations +81%），但结论不变。
- **内存**：13/23 项低于 Go@400（增量编辑 0.53×、noEmit-on-error 0.63×、tiny-files 0.69×），是唯一可与 Go 抗衡的维度。

**与旧报告的差异说明**：此前的"21/23 改善、medium −43%、RSS −63%"取自 **R1 批次（基线被人为设为 Server GC）**。以真实出厂基线重测后，正确结论是 **11/23 改善、12/23 回退、平均 +11.6%**，内存平均 −3.7%。这是本次审计最重要的更正。

---

## 6. 复现

```bash
# C# 最新 vs C# 优化前基准（出厂默认 GC，同批配对）
node tools/perf-cli.mjs --manifest manifests/final7.json \
  --go-executable pkgs/naot-svr/lib/tsc.exe \
  --csharp-env "DOTNET_gcServer=0,DOTNET_GCgen0size=0x400000,DOTNET_GCLOHThreshold=1000000" \
  --samples 15 --directory bench/AB34-final7-vs-baseline-cs

# C# 最新 vs Go@400（公平口径）
node tools/perf-cli.mjs --manifest manifests/final7.json \
  --go-executable go-v1/tsc.exe --csharp-env "<同上>" --go-env "GOGC=400" \
  --samples 15 --directory bench/AB33-final7-vs-go-gogc400

# 代码 vs GC 调优的归因（两侧 GC 对齐）
node tools/perf-cli.mjs --manifest manifests/final7.json \
  --go-executable pkgs/naot-svr/lib/tsc.exe \
  --csharp-env "DOTNET_gcServer=0,DOTNET_GCgen0size=0,DOTNET_GCLOHThreshold=0" \
  --samples 9 --directory bench/AB35-final7-code-only-vs-baseline
```

原始数据：`bench/AB34-final7-vs-baseline-cs`（基准 vs 最新）、`bench/AB33-final7-vs-go-gogc400`（vs Go）、
`bench/AB35-final7-code-only-vs-baseline`（归因）、`bench/AB28-final6-vs-go`（Go 默认口径）。

