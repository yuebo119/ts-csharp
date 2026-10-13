# r34 报告：对象字面量上下文路径分配削减，兼测量协议两处修正（2026-10-13）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-13 ｜ 轮次: r34 ｜ 主题: object-literal-context-allocation + incremental-state-trap + no-gc-region-retest
> 触发: 用户指令「好，继续」——执行 r33 报告结尾建议（对象数削减为首选，medium check 分配 34% 在对象字面量上下文路径）
> 计划: 承接 r33 §4 下一步建议，无独立 plan 文档 ｜ 产品改动: 1 个提交（d0ce61d61b，F1~F5）

## 1. 结论摘要

对 `MutableAsync → GetAsync → InstantiateAsync → WidenLiteralAsync` 链与对象字面量创建路径做分配归因，落地五个字节一致修复（F1~F5）。配对 A/B（同程序各 3 run、stash 周期隔离、`--noEmit` 无增量态）：

| 夹具 | 基线 CLR 分配 | F1~F5 | 变化 |
| --- | --- | --- | --- |
| 真实工程（291 文件，`--customConditions` 源解析态） | 825,040,360 | 821,850,064 | **−3.19 MB（−0.39%）** |
| medium（67 文件） | 57,651,584 | 54,017,752 | **−3.63 MB（−6.30%）** |
| huge-file（16,384 行） | 267,981,056 | 260,246,712 | **−7.73 MB（−2.88%）** |

产物形态（AOT，326 文件全量 check + emit、状态文件已删）：分配 1,005.1 → 1,001.7 MB（−0.34%），check 汇总时间 1.955 → 1.863 s（−4.7%）；墙钟 8 对交替中位 +0.27%（噪声带内，无墙钟收益）。
本轮另有两个测量协议层面的发现，比 F1~F5 本身更重要：

1. **增量状态文件陷阱**（§4）：`composite` 夹具的增量状态写在 `<outDir>/../<配置名>.tsbuildinfo`，`--outDir` 的多次运行共享同一个兄弟状态文件。r32-comparison 的三节点分配表（371.0/521.5/465.8 MB）与 r33 的「374MB、停顿 0.0ms」全部测于 **check 恢复态**（check 跳过、仅 emit）。绝对值的含义已修正并回改 perf-budgets。
2. **no-GC region 复测否决**（§5）：r33 实验 1 的否决前提（产品配置零停顿）正是恢复态假象。全量态停顿 81.5ms、region 可压到 3.9ms，但墙钟收益低于噪声下限且 `--version` +113%，维持否决。

## 2. 实施逐项（提交 d0ce61d61b）

| 项 | 改动 | 验证 | 数据 |
| --- | --- | --- | --- |
| F1 | `ExpressionContexts.GetAsync`：spread 边界 LINQ 链（4 迭代器 + 2 数组）改单遍循环直算 `firstSpread/lastSpread` | 25 夹具逐字节 | 每次数组元素上下文查询省 6 个临时对象 |
| F2 | `ExpressionContexts.LiteralAsync`：非复合、非实例化上下文类型一次旗标测试即可判定，快路径避开 `Stack<Type>` | 25 夹具逐字节 | 常见上下文（对象/字符串字面量目标）零栈分配 |
| F3 | `ExpressionContexts.WidenLiteralAsync`：唯一符号加宽按联合与否分流，非联合路径不再每次分配 MapAsync 闭包 | 25 夹具逐字节 | 每个加宽字面量省 1 闭包 + 1 状态机 |
| F4 | `ObjectLiterals.CreateAsync`：`IndexInfo` 列表惰性构建（仅计算属性名需要），常见字面量传共享空列表 | 25 夹具逐字节 | 每个对象字面量省 1 空 List |
| F5 | `Checker.LiteralGrammar`：数字字面量语法检查复用单个 Scanner（`Reset` 而非 `new`），LiteralGrammar 不递归故单实例安全 | 25 夹具逐字节 | 每个数字字面量省 ~322 B（scanner + 两个内部列表） |

探针归属（上一会话探针运行，方向性）：F5 单独落地时 objectCheckExpr 探针 −24%、CLR −1.15MB；F1~F4 合计在 medium 夹具 check 汇总分配 −15.1%。本轮以配对总量为权威证据，探针数仅作归因参考。

## 3. 墙钟

AOT 产物（r32 vs r34a，同夹具全量态、删状态文件、8 对交替、项目内 outDir）：中位比值 1.0027（+0.27%），比值分布 0.977~1.017，均值两侧均 1019ms。按 method.md 噪声下限 1.1% 判**不可分辨**：−0.34% 的分配削减经分配器 CPU 起作用，低于本机墙钟分辨率。与 r32 的斜率一致（−22.4% 分配换 x1.428→x1.397，即墙钟弹性约 1:10），本轮 −0.34% 对应预期 ~0.03% 墙钟，测不出属预期。

## 4. 增量状态文件陷阱（对历史数字的修正）

**机制**（源码 `Incremental/BuildInfo.Options.cs` `GetBuildInfoFileName`）：`composite: true` 时状态文件路径由 outDir 重算——`<outDir>/../<配置名>.tsbuildinfo`。`--outDir /tmp/xxx` 的所有运行因此共享 `/tmp/tsconfig.tsbuildinfo`；删夹具根的 `tsconfig.tsbuildinfo` 不挡它。实测（r32 AOT 产物、326 文件、同一命令）：

| 状态 | check 时间 | CLR 分配 | 说明 |
| --- | --- | --- | --- |
| 无状态文件（首次） | 1.907 s | 1,004.99 MB | 全量 check + 全量 emit（452 文件） |
| 有状态文件（后续） | 0.000 s | 370.87 MB | check 恢复跳过，仍全量 emit |
| `--outDir ./r34out2`（项目内相对路径） | 1.907 s | 1,004.99 MB | 状态文件落夹具根，删之即全量 |

**受影响的历史数字**：r32-comparison 分配表三节点（naot-svr 521.5 / epsl-a1 465.8 / r32 371.0 MB）与 r33 §4.1 的「真实工程 374MB、huge-file 371MB、停顿 0.0ms」均为恢复态。三节点同态对比的相对关系仍有效（epsl-a1→r32 的 −20.4% 是 emit 侧优化的真实反映），但**绝对值不是全量编译成本**，不能再与全量态数字混算。perf-budgets §2 首行已按全量态重设（≤1,050 MB，现行 1,001.8 MB），method.md §7.1 已写入规避规程。

**连带修正**：`--extendedDiagnostics` 统计里的 `GC.GetTotalMemory(forceFullCollection: true)` 会强制一次全量 GC，把「GC pause time」从自然值（全量态 81.5ms）抬到 0.22~0.24s。比较停顿一律不带该旗标。

## 5. no-GC region 复测（推翻 r33 前提，维持否决）

r33 实验 1 因「产品配置下停顿 0.0ms、GC 不触发」否决。该读数来自恢复态（§4），全量态实测：

| 配置 | GC pause | gen0/gen1/gen2 | 峰值 RSS |
| --- | --- | --- | --- |
| 无 region（自然） | 81.5 ms | 3/2/2 | 826 MB |
| region 2048MB | 3.9 ms | 1/1/1 | 945 MB |
| region 1024MB（r33 原默认） | — | 提前结束（gen0=4） | — |

region 机制本身有效（编译期零 collection），但墙钟收益不存在：全量负载 10 对交替中位 **−0.90%**（比值 0.963~1.080，均值 −0.7%），低于 1.1% 噪声下限判不可分辨——停顿与并行 checker 工作重叠，移除不停顿的临界路径。代价侧：`--version` 51.1 → 109.2ms（**+113%**，击穿 perf-budgets §2 启动类 ≤x1.35 线）、峰值 RSS +14%。**当日回退**（代码未入库），ledger 表2 该行已带新数据更新。

结论表述修正：「产品配置不触发 GC」作废；「停顿不是墙钟差距主因」因并行重叠仍成立（r33 的终结论对，推理链错）。

## 6. 门禁状态（终态，全部基于 --no-incremental 重建）

| 门禁 | 结果 |
| --- | --- |
| Release 构建 0 警告 0 错误 | 绿 |
| 逐字节 5 夹具（bash gate）+ 25 夹具 full gate | 5/5 + 25/25 |
| safety 95 flags | 92/95，失败 {checker-relation-context, npm-process, program-emit} 全部属于 r22 以来已知基线，无新失败（基线另两个 developer/lsp-native-watch 本轮提供崭新目录后通过，属环境态成员） |
| 分配 | 三夹具配对见 §1；同侧 3 run 带宽 <0.1% |

## 7. 与预算契约的关系

- §2 首行（真实工程 CLR 总分配）：锚点改全量态 1,001.8 MB（r34 节点，r32 同程序 1,005.2 MB），阈值 ≤1,050 MB 重设；口径注记写入状态文件规避（method.md §7.1）。
- §2 safety 行：失败集合条件由「= 已知基线集合」放宽为「⊆ 已知基线集合」（环境态成员可过），锚点 92/95。
- §2 墙钟各行：随 `docs/csharp-perf-report-r34-comparison.md`（四批 AB129~AB132）刷新为重负载 x1.423 / medium-checkers-1 x2.070 / 巨文件 x1.393 / 启动类 x1.22~1.24，全部仍在预算线内；AB132 对批证实 r34 与 r32 墙钟等价，与 r32 表比值的差为批间漂移。
- §4.1：GC 停顿前提按 §5 修正。
- 产物等价、构建红线两行不动。

## 8. 下一步

对象数削减的剩余目标（按 r33 归因排序）：关系引擎每操作临时对象（`checkerRelated` 探针 297.9MB/真实工程，内部是保留结构本体，r27 已定界）、签名 array+wrapper 对、Utf8String 键字典重算哈希（r30 已否决缓存方案）。按当前弹性（分配 −0.34% → 墙钟 ~0.06%），单项预期都在噪声带内；反超仍需架构级改写（类型/签名结构体化 + arena，月级）。若无新触发条件（门禁红/量级 10×/新负载/SLO 烧穿/阶段边界），建议转入维持态：只做触碰性卫生与门禁维护。
