# r28 报告：五处流程偏离的修复——emit 复用诊断池 + 四处每文件分桶（2026-10-11）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-11 ｜ 轮次: r28 ｜ 主题: flow-deviation-fixes-emit-pool-reuse-and-per-file-bucketing
> 涉及 git 节点: `5c59e222bf`（r28 审计文档，工作树基线）/ 本轮提交
> 产品: `pkgs/r28/lib/tsc.exe` sha256 `30d057197c337e5f…`；对照 `pkgs/r27d`
> 数据来源: 25 夹具逐字节；95 safety flags；真实工程 noEmit 分配配对（3+3 组）；medium emit 重建量化（r27d 2 组对照 + r28 2+2 组）；AB122 配对批次（7 负载 × 15 对）
> 关联: `docs/csharp-perf-plan-r28.md`（审计与 F1~F5 定义）

---

## 0. 本轮结论

r28 审计发现的五处移植偏离全部修复（7 个产品文件）。语义门禁全绿（逐字节 25/25、safety 90/95 已知集合）。收益分两条线：

| 线 | 结果 |
| --- | --- |
| **F1 emit 池复用**（medium 夹具，emit 形态，r27d → r28） | 分配 85.08 → **82.08 MB（−3.5%）**；LinkStore creates 27,123 → **20,827（−23%，emit 期重建份额消失）**；Types 计数 6,287 → 4,183（emit 期多建的 2,104 个类型归零） |
| **墙钟（AB122，7 负载 × 15 对）** | **7/7 全部负向**；扣控制组 0.987 偏置（~1.3%）后 declarations −2.7%、huge-file −3.4%、host-paths −2.3%、checkers-1/8 −1.2/−1.3%，medium/tiny-files 落噪声内。huge-file 墙钟 −4.67% 而 cpuMs 两侧相同（1046.9/1046.9）：省的是等待（GC 停顿窗口与锁争用）不是 CPU 工作，与"分配 → 停顿"通道假设（r26 提出、r27 方向性支持）第三次吻合。**这是 r18 换 GC 配置以来第一个可宣称的墙钟改善** |
| 真实工程 noEmit 分配 | r27d 811.41 → r28 811.52 MB，持平（预期内：F1 不触及 noEmit 形态；F2~F5 的闭包/LINQ 节省低于噪声地板） |

---

## 1. 落地明细（7 文件）

### F1 emit 复用诊断期 checker 池（`Incremental/IncrementalProgram.Emit.cs`）

- 并发分支：`pool = checkerPool ??= await Program.CreateCheckerPoolAsync(false, …)`——原来无条件新建整池。
- 串行分支：缓存池存在时按文件借该文件的 checker（`AcquireAsync(file.Syntax)`，与并发分支同语义），不存在时保留原"单 checker"路径（LSP 直发等无诊断期场景）。
- 与 Go 参考对齐：`emitHost.go:39` 的 `program.GetTypeCheckerForFile` 借诊断期同池热 checker。
- 失败路径不变：`EmitAsync` 的 catch 已把 `checkerPool` 置空（`Diagnostics.cs:15` 同款），池跨阶段复用的失效语义闭合。

### F2~F5 每文件收尾流程分桶（4 文件）

| 项 | 原状 | 现状 |
| --- | --- | --- |
| F2 未用作用域（`Checker.Function.cs` + `Checker.Unused.cs`） | checker 级全局 `HashSet`，每文件全量扫描 + `Binding` 查找过滤 | 登记时按 `Binding(node)?.SourceFile` 分桶（与原消费过滤同键），每文件只遍历本桶 |
| F3 重命名绑定元素（同上两文件） | 全局 `List`，每文件过滤扫描 | 登记时按 `SemanticSyntax.Source` 分桶 |
| F4 迭代诊断（`Checker.Iteration.cs` + `Checker.Source.cs`） | 全局 `List`，每文件 `Where+ToArray`（枚举器+数组分配）+ 尾部 `RemoveAll`（捕获闭包） | 登记分桶；消费 `TryGetValue+Remove`，尾部 `Remove` 清理循环内迟到登记（与旧语义逐项等价，含"消费快照后新增即弃"的行为） |
| F5 缺失属性（`Checker.Access.cs` + `Checker.MissingProperties.cs`） | 全局 `List`，每文件索引扫描 + `RemoveAll` | 登记分桶；消费只读本桶，循环内追加仍可见（保持旧行为），方法尾 `Remove` |

语义保持要点：分桶键与原消费过滤键逐一相同（F2 用 Binding 源、F3/F4/F5 用语法源）；迟登记的丢弃行为两版一致；桶迭代顺序 = 原全局序在本文件子集上的投影。`DeferredIterationDiagnostics` / `DeferredMissingProperties` 保留只读视图属性（测试工程 3 处引用编译通过）。

---

## 2. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | Release 0 警告 0 错误；测试工程重建 0/0；AOT 发布成功 |
| 逐字节一致 | `built/r28-bytecheck.mjs`（r27d ↔ r28）**25/25**——含全部 emit 产物夹具，这是 F1（换 emit checker 来源）的主语义门禁 |
| safety 套件 | 95 flags **90 通过 / 5 失败**，与已知基线集合逐项相同 |
| 确定性分配 | 真实工程 noEmit 3+3 交错：r27d 中位 811.41 / r28 中位 811.52 MB（持平，两侧带宽 ~170 KB）；medium emit −3.0 MB（§0）；`LinkStore creates` 真实工程 464,301 两侧一致 |
| 墙钟 | AB122 见 §0；控制组 ratio 0.9871（有效），已在宣称中扣减偏置 |

## 3. 观察（未定论，记录备查）

emit 形态的 Types 总数（4,183）低于 noEmit 形态（5,790）——两种 CLI 形态在 composite/isolatedDeclarations 配置下的检查路径差异未展开分析；不影响本轮结论（同形态 r27d↔r28 对比有效）。

## 4. 下一步

1. 刷新三方对比表（r28 节点 vs Go 默认/Go@400/优化前基线，23 负载全量）——r28 的墙钟收益需要全量表确认重负载族位置。
2. host-paths 探针归因（r25 阶段 3 仍开放；本轮它 −3.6% 顺带受益）。
3. 245 项容器候选按频度分诊（每轮队列）。

## 5. 工作树状态

- 产品改动 7 文件：`Incremental/IncrementalProgram.Emit.cs`、`Checking/Checker.{Iteration,Source,Access,MissingProperties,Function,Unused}.cs`。
- 工具：`built/r28-bytecheck.mjs`（不跟踪）；测量脚本 `$TEMP/r28-measure.sh`。

### 进度追踪

| 维度 | 状态 |
| --- | --- |
| 实现进度 | r28 审计五项偏离修复 100%；三方表刷新 0%（下一轮） |
| 验证完成度 | 逐字节 25/25、safety 90/95、分配 3+3+2+2 组、AB122 7 负载、emit 重建量化——全部完成；未验证：emit 形态 Types 低于 noEmit 的机制（已记录为观察） |
