# r05 实施报告：P0 单文件发射流水线（已落地）+ 剩余项状态

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-08 ｜ 轮次: r05 ｜ 主题: emit-pipeline-implementation
> 涉及 git 节点: `6ed638d3a5`（优化前基准） / `ae562ede07`（最新，含 P0）
> 数据来源: `bench/AB46`（流水线首版）、`AB47`（线程池版）、`AB48`（门控版）、`AB49`（vs 基准）、`AB50`（vs Go@400）
> 关联方案: `plans/plan_2026-10-08_r05_emit-segments-and-transform-attribution.md`

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| **P0 发射流水线** | **已落地**：巨文件 **1496.7 → 1211.3 ms（+19.1%）**，全量 23 负载 **18 改善 / 5 变慢 / 平均 +14.8% / 最差 −0.9%** |
| P0 的原始设想（按顶层语句分段并行） | **被更优方案取代**：实测两遍（JS / 声明）完全独立且可加，流水线化即可拿到大部分收益，且风险低得多 |
| P1 检查阶段 | 归因已就绪（`VariableDeclaration` 157 MB / 88%），定点改造未实施 |
| P2 变换阶段 | 归因已就绪（前三类占 80%），变换器级归因与改造未实施 |
| P3 打印残余 | 未实施（分析已给边界：~64 MB 为部件元素存储固有成本） |

---

## 2. P0 实施过程（含一次被实测否定的实现）

### 2.1 关键测量：两遍独立且可加

巨文件（r04ship，自报 emit）：

| 变体 | Emit time | Total time |
| --- | ---: | ---: |
| JS + 声明 | 0.651 s | 1.139 s |
| 仅 JS（`--declaration false`） | 0.347 s | 0.896 s |
| 仅声明（`--emitDeclarationOnly`） | 0.289 s | 0.794 s |

0.347 + 0.289 = 0.636 ≈ 0.651 → **两遍互不依赖**；唯一共享物是 checker。

### 2.2 三次迭代（每次都做配对 A/B）

| 版本 | 实现 | A/B 结果 | 结论 |
| --- | --- | --- | --- |
| r05a | 直接 `javascriptPrint = PrintJavaScriptAsync(...)` | huge-file **1.011×**（CI [1.001,1.016] 变慢）、medium 1.002、declarations 0.981 | **否定**：`PrintAsync` 的同步打印部分在调用线程跑完，任务尚未让出，实际没有重叠 |
| r05b | `Task.Run(...)` 放到线程池 | huge-file **0.908×（−9.2%）**；但 declarations **1.037×**、tiny-files **1.047×**（均显著变慢） | 重叠有效，但多文件负载已占满核心，第二路并发造成 GC 争用 |
| **r05c** | 门控 `EmitOptions.PipelineDeclarationTransform`，**仅串行单文件分支**启用 | huge-file **0.908×（−9.2%）**、declarations 0.977、tiny-files 1.018、medium 0.998（后三者 CI 含 1.0） | **采纳** |

### 2.3 最终实现（`CompilerProgram.Emit.cs` / `EmitResult.cs` / `IncrementalProgram.Emit.cs`）

```
JS 变换（checker）→ [ JS 打印（线程池，不接触 checker） ∥ 声明变换（checker）] → 声明打印
```

正确性处理：

1. **共享诊断列表**：声明变换的诊断延后到 JS 打印结束后再 `AddRange`，避免两个 pass 同时读写同一 `List<Diagnostic>`；
2. **跳过判定**：声明输出的跳过改用独立局部变量 `skipDeclaration`，不再复用可能已被 JS 侧置位的 `skipped`；
3. **异常安全**：`finally` 中等待未完成的打印任务，避免未观察异常；
4. **归因正确性**：`Measure("print")` 作用域包在 `PrintJavaScriptAsync` 内部，不跨阶段。

---

## 3. 最终对比（AB49/AB50，噪声 5.5% / 6.9%）

### 3.1 vs 优化前基准（23 负载 × 15 组）

| 负载 | 基准 (ms) | r05c (ms) | 改善% | 负载 | 基准 (ms) | r05c (ms) | 改善% |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| medium-256m-heap | 287.6 | **173.3** | **+39.7%** | tiny-files-noemit | 140.9 | 136.8 | +2.9% |
| medium-checkers-8 | 288.8 | **175.4** | **+39.3%** | pr-config | 73.9 | 72.8 | +1.4% |
| medium | 278.9 | **174.1** | **+37.6%** | pr-declaration | 84.7 | 83.6 | +1.3% |
| medium-checkers-4 | 273.4 | **175.8** | **+35.7%** | pr-clean | 83.6 | 82.9 | +0.9% |
| tiny-noemit-on-error | 465.5 | **310.1** | **+33.4%** | host-paths | 98.9 | 98.2 | +0.7% |
| tiny-files（512 文件） | 452.0 | **310.9** | **+31.2%** | help | 53.1 | 52.8 | +0.5% |
| medium-checkers-2 | 291.1 | **206.4** | **+29.1%** | version | 52.5 | 52.3 | +0.3% |
| declarations | 211.2 | **153.9** | **+27.1%** | empty-project | 56.4 | 56.5 | −0.2% |
| tiny-incremental-edit | 502.4 | **367.6** | **+26.8%** | pr-package | 83.4 | 83.8 | −0.5% |
| **huge-file** | 1,496.7 | **1,211.3** | **+19.1%** | pr-implementation | 71.8 | 72.2 | −0.7% |
| medium-checkers-1 | 311.3 | **260.6** | **+16.3%** | pr-noop | 63.5 | 64.0 | −0.9% |
| | | | | small-first-diagnostic | 64.8 | 65.4 | −0.9% |

### 3.2 轮次演进

| 指标 | r03（AB37） | r04（AB44） | **r05c（AB49）** |
| --- | ---: | ---: | ---: |
| 改善项 | 11 / 23 | 15 / 23 | **18 / 23** |
| 变慢项 | 12 / 23 | 8 / 23 | **5 / 23** |
| 平均改善 | +13.4% | +13.7% | **+14.8%** |
| 最差项 | −5.7% | −5.6% | **−0.9%** |
| 统计显著回退 | 3 项 | 0 项 | **0 项（且最差仅 −0.9%）** |
| 巨文件 | +19.5% | +14.7% | **+19.1%** |

### 3.3 vs Go@GOGC=400（AB50）

| 负载 | C# 比 Go 慢 | 变化（相对 AB45） |
| --- | ---: | --- |
| huge-file | **+206%** | 238% → 206% |
| medium-checkers-1 | +171% | 192% → 171% |
| medium-checkers-2 | +135% | 134% → 135% |
| medium-checkers-4 | +110% | 113% → 110% |
| medium-256m-heap | +103% | 99% → 103% |
| medium | +99% | 92% → 99% |
| medium-checkers-8 | +98% | 104% → 98% |
| declarations | +90% | 90% → 90% |
| tiny-files | +34% | 34% → 34% |
| help / version | +15% / +18% | 持平 |

**内存**：**12/23 项低于 Go@400**（增量编辑 0.65×、noemit-on-error 0.80×、checkers-8 0.86×、checkers-1 0.87× 最优）。

---

## 4. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | **0 警告 / 0 错误** |
| 输出逐字节一致 | AB46–AB50 全部批次、23 负载 × 15 对，逐字节通过 |
| safety 套件 | **87 / 89**；`program-emit-safety` 在未改动基线上同样失败；`npm-process-safety` 为**环境性不稳定**（未改动基线 2/6 失败，含流水线 3/6 失败，该测试只涉及 npm 进程树清理与取消传播，与发射无关） |
| 确定性分配（巨文件） | 513.4 MB（基线 960.1 MB，−46.5%） |

---

## 5. 剩余项（P1–P3）状态与依据

| 项 | 现状 | 已具备的依据 | 下一步 |
| --- | --- | --- | --- |
| **P1 检查阶段** | 295 ms（3.21× Go），179.8 MB | 节点级归因：`VariableDeclaration` **157 MB（88%）**，即匿名对象类型构造 + 可赋值性关系 | 下沉到方法级归因（`GetTypeFromTypeNode`/`GetTypeOfExpression`/`IsRelatedTo`/`GetPropertiesOfType`）→ 关系缓存条目结构体化、成员表去冗余排序/数组、空集合延迟分配 |
| **P2 变换阶段** | 124 MB | 节点级归因：`VariableStatement` 33.5 / `VariableDeclaration` 33.2 / `SourceFile` 31.6 MB = 80%；`VisitListAsync` 已 copy-on-write | 帧扩展为"变换器 × 节点种类"→ 消除每语句节点重建与变量环境操作 |
| **P3 打印残余** | 147 MB | ~64 MB 是约 100 万 `Part` 的固有元素存储；`S()` 65,536 次已是精确数组 | `Part.Kind` 跳转表分派；`Modifiers`/`BlockBody` 直推化；与 P0 协同写入池化缓冲 |

---

## 6. 提交

| 提交 | 内容 |
| --- | --- |
| `5a98b0f669` | 变换阶段按节点种类归因（含两条不变式修正） |
| `0d0ca94fb8` | r05 方案文档 |
| **`ae562ede07`** | **P0 发射流水线（3 文件）** |
