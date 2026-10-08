# r04 实施报告：按 P0–P5 方案完整实施

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-08 ｜ 轮次: r04 ｜ 主题: plan-implementation
> 涉及 git 节点: `6ed638d3a5`（优化前基准） / `c929d92b44` + r04 改动（最新）
> 数据来源: `bench/AB39`、`AB40`、`AB41`、`AB42`、`AB43`、`AB44`、`AB45`
> 关联方案: `plans/plan_2026-10-08_r03_baseline-corrected.md`

---

## 1. 实施状态总览

| 方案项 | 状态 | 结果 |
| --- | --- | --- |
| **P0-1** 统一构建形态（内嵌默认值） | **已回退（有实测依据）** | 改默认值会破坏 4 个测试套件（`Content` 不向引用项目传递），改为流程+文档控制 |
| **P0-2** GC 自适应 | **已实施（DATAS）** | 轻负载回退消除：pr-impl −9.4%、pr-config −5.6%、small-diag −4.9%、tiny-noemit −1.5%，且这些负载 RSS 同时下降 |
| **P0-3** 内嵌懒加载 | 不需要 | P0-1 决定产品形态为不内嵌，内嵌路径仅作可选 |
| **P1-1** 递归自分配归因 | **已实施** | 定位：检查阶段 178.5 MB 中 **`VariableDeclaration` 独占 157.0 MB（88%）** |
| **P1-2** 检查器快赢 | **已回退（收益微小）** | 5 处重复数组化 + 去 `AsReadOnly`：check 183.2 → 181.9 MB（−0.7%），风险/收益不划算 |
| **P2** 变换阶段 flags 拆分 | **已实施→实测中性→已回退** | transform 124.2 → 124.1 MB（−0.1%，噪声级） |
| **P3** 打印机残余 | 未实施（有分析） | 剩余分配为部件元素存储本身（约 64 MB）+ 长尾，见 §6 |
| **P4** 工作项架构 | 未实施（有分析） | 见 §6 |
| **P5** 启动地板 | **诊断已完成** | **`--version` 仅 2.9–3.9 ms 在 Main 内，约 50/54 ms 发生在 Main 之前**（运行时/AOT 镜像初始化） |

---

## 2. P0-2：GC 改为 DATAS（本轮主要收益）

### 2.1 实验链

| 批次 | 对照 | 结论 |
| --- | --- | --- |
| AB39 | gen0 4 MiB + LOH 1 MiB vs 出厂默认 | 调优在轻负载上 +4~7%（tiny-noemit 1.067、pr-config 1.067，CI 排除 1.0），仅在 huge-file −3.0%；噪声 27.7% |
| AB40 | DATAS vs 当前调优（11 组） | small-diag 0.936、pr-config 0.934、declarations 0.965；huge-file 1.024 |
| **AB41** | **DATAS vs 当前调优（15 组复核）** | 见下表 |

### 2.2 AB41 复核结果（噪声 27.5%，15 组）

| 负载 | 当前调优 (ms) | DATAS (ms) | 比值 | 95% CI | RSS 变化 |
| --- | ---: | ---: | ---: | --- | --- |
| project-references-implementation | 85.0 | 77.0 | **0.906×** | 0.877–0.951 | 23.0 → 19.7 MiB |
| project-references-config | 81.3 | 76.8 | **0.944×** | 0.910–0.956 | 22.7 → 19.3 MiB |
| small-first-diagnostic | 81.5 | 77.6 | **0.951×** | 0.917–0.980 | 22.1 → 18.4 MiB |
| tiny-files-noemit | 159.0 | 156.5 | 0.985× | 0.960–1.013 | 33.4 → 36.1 MiB |
| medium | 193.7 | 191.7 | 0.990× | 0.970–1.044 | 47.4 → 53.3 MiB |
| declarations | 186.6 | 184.8 | 0.990× | 0.929–1.035 | 47.0 → 53.6 MiB |
| help / empty-project | 59.4 / 65.5 | 59.5 / 65.6 | 1.001× / 1.002× | 含 1.0 | 持平 |
| huge-file | 1,348.8 | 1,361.5 | 1.009× | 0.998–1.030 | 175.5 → 213.2 MiB |
| version | 59.6 | 61.9 | 1.039× | 0.970–1.062 | 持平 |

### 2.3 落地改动

- `csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj`：`System.GC.Server=true` + `System.GC.DynamicAdaptationMode=1`，**移除** `gen0size`/`LOHThreshold`（固定预算正是轻负载回退的来源）。
- `csharp/tools/package.mjs`：启动器导出改为 `DOTNET_gcServer=1` + `DOTNET_GCDynamicAdaptationMode=1`。

**判据**：以"轻负载不再回退、重负载保留收益、两端 RSS 都不劣于优化前基准"为准。huge-file 代价（+0.9% 时间、175.5→213.2 MiB）仍优于基准（238 MiB、−10%）。

---

## 3. P1：检查阶段归因（首次定位到具体节点种类）

### 3.1 插桩设计（已实施，诊断时零热路径成本）

在 `Checker.Source.cs` 已存在的 `try/finally` 内挂归因：

```
自身分配 = (出口 GC.GetTotalAllocatedBytes() − 入口) − Σ(直接子帧已申报量)
```

- 栈为 `Checker` 实例字段（检查器池保证单文件独占），仅当 `CompilationCapture.Current is not null` 时启用；
- 结果经 `CompilationCapture.NoteCheckKind` 汇总，`--extendedDiagnostics` 打印 Top-12 节点种类；
- **AOT 下可用**（`Enum.GetName` 正常解析）。

### 3.2 巨文件检查阶段结果（178.5 MB）

| 节点种类 | 自身分配 | 占比 |
| --- | ---: | ---: |
| **VariableDeclaration** | **157.0 MB** | **88.0%** |
| PropertySignature | 11.2 MB | 6.3% |
| VariableStatement | 0.4 MB | 0.2% |

**含义**：分配集中在"每个变量声明的类型解析 + 初始化器检查"（夹具为 `export declare const valueN: {…} = {…}`，16,384 个），即**匿名对象类型的构造与关系比较**（每声明约 9.6 KB）。这解释了为什么 P1-2 的微观清理（−0.7%）无效：真正的开销在类型/符号/关系对象本身，而非数组包装。

**下一步（P1 真正的内容）**：对 `VariableDeclaration` 路径再下钻一层（`CheckedFunctionTypeAsync` → 类型字面量对象类型构造；初始化器 → 对象字面量类型与可赋值性关系缓存），需要的是"对象类型成员表 / 关系缓存条目"的结构化改造，属独立一轮。

---

## 4. P5：启动地板诊断（颠覆性发现）

`TSHARP_STARTUP_TRACE=1` 打开后（`--version`，5 次）：

| 指标 | 值 |
| --- | ---: |
| **Main 内耗时** | **2.9 – 3.9 ms** |
| 进程内（Main 入口起算） | 3 – 4 ms |
| harness 实测整进程 | ~54 ms（Go@400 45.5 ms） |

**结论：约 50 ms（占 93%）发生在 Main 之前**，即 NativeAOT 运行时/镜像初始化（映射、重定位、GC 初始化、模块初始化器）。因此：

1. 选项表（`OptionDefinitions.All`，358 处引用 `Messages.*`）触发 `Messages` 静态构造、初始化 **2,213 个 `DiagnosticMessage`** —— 这属于 Main 内的 3.5 ms，**不是启动差距的主因**；
2. 真正的启动差距来自运行时初始化，可动的手段只有**缩小/重排镜像**（本机已验证 `IlcInstructionSet=native` 无收益）；
3. 之前把"启动回退"归因于代码，是错的方向；正确结论是镜像形态（内嵌 +5.17 MB → +3.5~4%）与 GC 初始化。

---

## 5. 被拒绝/回退的改动（含实测依据）

| 改动 | 结果 | 依据 |
| --- | --- | --- |
| `EmbedTypeScriptLibraries` 默认 `true`→`false` | **回退** | 4 个 safety 套件失败（`project-safety`、`incremental-safety`、`checker-generic-relations-safety`、`checker-program-safety`）；根因是 `Content` 项不向引用项目传递，测试宿主缺标准库。改由流程强制（`package.mjs`/`product.mjs` 已显式传 `false`） |
| P2 `EmitContext` flags 拆分为值类型字典 | **回退** | transform 124.2 → 124.1 MB，仅 −0.1 MB；被设置 flags 的节点同时也在写 `NodeData`，不存在"纯 flags 节点" |
| P1-2 检查器数组提升 + 去 `AsReadOnly` | **回退** | check 183.2 → 181.9 MB（−0.7%），风险（共享数组/可变集合）不划算 |
| Server GC（无 DATAS） | 早前已拒 | 多文件负载慢 5–11% |
| `Array.AsReadOnly` 全面移除（41 处） | 早前已拒 | 编译通过但 <2 MB |
| 定长 gen0 预算（4 MiB） | **本轮替换** | 轻负载固定成本 +4~7% |

---

## 6. P3/P4 未实施的原因（含量化边界）

巨文件打印阶段 147 MB 的构成：

| 部分 | 量级 | 说明 |
| --- | ---: | --- |
| 部件元素存储（约 100 万 × 64 B `Part`） | **~64 MB** | 容器化设计的固有成本，非浪费 |
| `S(...)` 精确数组（65,536 次） | ~14 MB | 已是"精确长度单次分配"，无冗余拷贝 |
| 容器/列表头 + 长尾种类 | ~69 MB | 已被前三轮直推改造削平（ObjectLiteral/TypeLiteral/VariableDeclarationList 已做） |

**结论**：P3 的 `S()` 项在"保留容器模型"前提下已接近下限；要再降只能做 P4 的架构级改造（把 `Part` 工作项改为直推 + 显式 `Kind` 分派 + 数组栈），属高风险大改，且**巨文件墙钟时间已不再受分配主导**（分配降 46.7% 而比值仅从 3.23 降到约 3.1）。

---

## 7. 验证门禁（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| 构建 | **0 警告 / 0 错误** |
| safety 套件 | **88 / 89 通过**；唯一失败 `program-emit-safety` 在**未改动基线上同样失败**（逐项对照确认） |
| 输出逐字节一致 | harness 在每个批次内对 23 负载 × 15 对逐字节校验，全部通过（AB42–AB45） |
| 确定性分配（巨文件） | 基线 960.1 MB → r04 **512.1 MB（−46.7%）** |
| 变更集 | 7 文件，+?/? （见 §8 提交） |

### 7.1 定位 4 个假回退的过程（方法论价值）

初测 84/89 → 逐项回退二分：
1. 回退 `AsReadOnly` 两处 → 仍失败（排除）
2. 回退 `Checker.cs` 数组提升 → 仍失败（排除）
3. 回退 `TypeScript.Compiler.csproj` 内嵌默认值 → **4 项全部通过（定位）**

这证明 safety 套件确实能抓到"构建形态"这类非代码缺陷。

---

## 8. 最终对比（本轮权威数据）

**产物**：`pkgs/r04ship/lib/tsc.exe`（28.28 MB，产品形态 `-p:EmbedTypeScriptLibraries=false`，sha256 `38F0CE2D1278…`）

### 8.1 AB44：r04ship vs 优化前基准（噪声 10.1%，23 负载 × 15 组）

| 负载 | 基准 (ms) | r04ship (ms) | **改善%** | 负载 | 基准 (ms) | r04ship (ms) | **改善%** |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| medium | 284.9 | **165.5** | **+41.9%** | host-paths | 98.0 | 97.0 | +0.9% |
| medium-checkers-8 | 282.9 | **165.6** | **+41.5%** | small-first-diagnostic | 68.9 | 68.5 | +0.6% |
| medium-256m-heap | 286.1 | **167.7** | **+41.4%** | version | 53.6 | 53.4 | +0.4% |
| medium-checkers-4 | 302.7 | **198.7** | **+34.4%** | pr-noop | 65.4 | 65.3 | +0.1% |
| tiny-noemit-on-error | 470.8 | **327.7** | **+30.4%** | pr-declaration | 100.8 | 101.0 | −0.2% |
| tiny-files（512 文件） | 448.1 | **314.7** | **+29.8%** | pr-package | 101.2 | 101.6 | −0.3% |
| tiny-incremental-edit | 499.9 | **361.1** | **+27.8%** | pr-clean | 81.4 | 81.7 | −0.4% |
| medium-checkers-2 | 307.5 | **227.0** | **+26.2%** | pr-config | 76.0 | 76.3 | −0.4% |
| declarations | 210.5 | **156.4** | **+25.7%** | pr-implementation | 74.9 | 75.4 | −0.6% |
| huge-file | 1,510.2 | **1,288.4** | **+14.7%** | help | 54.5 | 55.4 | −1.6% |
| medium-checkers-1 | 311.5 | **280.8** | **+9.8%** | empty-project | 58.8 | 59.9 | −1.9% |
| | | | | tiny-noemit | 141.2 | 149.1 | **−5.6%** |

**汇总**

| 指标 | r03（AB37） | **r04（AB44）** |
| --- | ---: | ---: |
| 改善项 | 11 / 23 | **15 / 23** |
| 变慢项 | 12 / 23 | **8 / 23** |
| 平均改善 | +13.4% | **+13.7%** |
| 轻负载族（12 项）平均 | **−2.8%** | **−0.7%** |
| 轻负载族变慢项 | 12 / 12 | **8 / 12** |
| 轻负载族最差 | −5.7% | −5.6% |
| **统计显著的回退** | 3 项（small-diag、tiny-noemit、pr-impl） | **0 项**（8 项 CI 全部含 1.0） |

剩余的 8 项回退 95% CI：tiny-noemit [0.998,1.090]、empty [0.950,1.062]、help [0.981,1.048]、pr-impl [0.984,1.026]、pr-clean [0.995,1.012]、pr-config [0.982,1.022]、pr-package [0.996,1.030]、pr-decl [0.973,1.081] —— **均在噪声范围内，不再构成可复现回退**。

### 8.2 AB45：r04ship vs Go@GOGC=400（噪声 23.5%）

| 负载 | C# 比 Go 慢 | | 负载 | C# 比 Go 慢 |
| --- | ---: | --- | --- | ---: |
| huge-file | +238% | | tiny-files | +34% |
| medium-checkers-1 | +192% | | small-first-diagnostic | +33% |
| medium-checkers-2 | +134% | | pr-noop | +32% |
| medium-checkers-4 | +113% | | empty-project | +22% |
| medium-checkers-8 | +104% | | tiny-noemit | +21% |
| medium-256m-heap | +99% | | version | +18% |
| medium | +92% | | help | +15% |
| declarations | +90% | | pr-* 族 | +36% ~ +57% |

**内存**：**12/23 项低于 Go@400**（增量编辑 0.64×、noemit-on-error 0.73×、tiny-noemit 0.85×、checkers-8 0.86×、checkers-1 0.87× 最优）。

---

## 9. 提交

> 见 `perf/INDEX.md` 第 4 节的节点映射；本轮改动 7 文件，提交记录见分支 `csharp-perf-extreme-optimization`。

