# r21 实施报告：分配归因工具链与成员表分配的三处修复，真实工程 −3.5%

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r21 ｜ 主题: allocation-attribution-and-member-table-fixes
> 涉及 git 节点: `8eb0c712f3`（r20 审计，工作树基线）/ 本轮提交
> 数据来源: 帧级独占分配探针（每线程分配增量减直接子帧，ThreadStatic 帧栈加对象池）；产品 AOT 确定性分配（真实工程 2 组、巨文件 2 组）；36 个夹具产物逐字节比对；95 个 safety flags；AB104 配对批次
> 关联: `docs/csharp-perf-report-r20.md`（.NET 11 适配审计）、`docs/csharp-perf-report-r14.md`（关系引擎归因）

---

## 0. 本轮结论

| 指标（产品 AOT，确定性分配） | r18 | **r21** | 变化 |
| --- | ---: | ---: | ---: |
| 真实工程（291 文件）CLR 总分配 | 867,979,136 | **837,203,296** | **−30,775,840 B（−29.4 MiB，−3.5%）** |
| 巨文件 CLR 总分配 | 261,914,040 | **261,519,440** | −394,600 B（−0.4 MiB，−0.15%） |

分配重复性：真实工程两侧各落在 140 KB / 24 KB 区间内，变化量超重复性两个数量级。墙钟（AB104，7 负载 × 15 配对，控制项噪声 28.3%）：全部噪声内，按分配轮的惯例不做声明。

Go 在同负载累计分配约 155 MiB（GOGC=off 提交峰值），本轮把 C# 的 828 MiB 降到 798 MiB，倍数从 5.6 收窄到 5.2。剩余大头是关系引擎与成员解析的合法工作本体，见 §5。

---

## 1. 分配归因工具链（本轮过半时间花在这里）

目标是按**类型和调用点**找可削减分配。三条路依次试过：

1. **EventPipe 分配采样**（`dotnet-trace` + `Microsoft-DotNETCore-SampleAlloc`，含 `gc-verbose` profile、显式 keyword、多种参数组合）：在本机 .NET 11 RC 运行时上**零事件流出**。用一个分配密集的微型程序对照验证，同样零事件，确认是运行时侧问题而非应用问题，放弃该路线。
2. ** nettrace 解析**：TraceEvent 库可读，但事件不存在，无意义。
3. **帧级独占分配探针**（落地）：给既有探针加父子归因，输出每帧"自己"的分配（inclusive 减直接子帧之和）。

探针本身两次自污染，都修正后才得到可信数字，记录备查：

- 第一版每次 `Mark()` 新建 `FrameNode`，约 200 万次调用即 76 MB，且算进父帧，把高层帧（checkerRelated 等）的数字抬高一个量级。改为 ThreadStatic 对象池。
- 第二版用 `AsyncLocal` 传递帧栈，每次写入自身分配（约 300 MB），同样落进父帧。已知悉的代价：跨线程挂起的帧丢失独占归因（不影响 inclusive，与既有 inclusive 数字的假设一致）。

修正后探针开销归零（带探针总分配 845 MiB 对无探针产品 828 MiB 的同期水位），独占表可用。该机制已留在 `CompilationCapture` 内（探针关闭时每次调用只多一次空判断），未来分配轮次可直接复用。

---

## 2. 独占分配排名（真实工程，修复前同口径基线）

| 帧 | 独占分配 | 调用次数 | 每次 |
| --- | ---: | ---: | ---: |
| resolveMembers | 84.5 MiB | 37,508 | 2,318 B |
| checkerRelated | 42.1 MiB | 99,242 | 444 B |
| typeFromNode | 36.1 MiB | 72,380 | 523 B |
| symbolTypesGet | 32.0 MiB | 710,014 | 47 B |
| variableType | 20.0 MiB | 43,249 | 486 B |
| setMembers | 39.6 MiB | 60,972 | 680 B |
| objectCheckExpr | 16.1 MiB | 8,493 | 1,987 B |
| relationRelated | 12.6 MiB | 295,141 | 45 B |
| membersTable / relationCompare / objectLiteral | 9.6 / 9.5 / 5.9 MiB | — | — |
| 其余 20 帧 | 各 < 5 MiB | — | — |

探针可见部分合计约 253 MiB，其余在 parse/bind/emit 与未加帧方法内。

---

## 3. 落地内容（四处修复，同口径 before/after）

### 3.1 `SetCoreAsync`：每个成员一次的 LINQ 闭包（−24.4 MiB，该帧 −59%）

成员表落盘时按"声明成员还是继承成员"分流，原实现对每个成员执行 `owner.Declarations.Any(d => ...)`，闭包捕获 `value`，每个成员分配一个显示类加委托。真实工程 30.5 万个成员即约 30 MB。改为静态包含循环 `DeclaredIn`；两个 `List<Symbol>` 加 `members.Count` 容量提示。

### 3.2 `ObjectAsync`：实例化成员表被整表拷贝两次（−7.8 MiB）

mapper 非空时 `InstantiateTableAsync` 已产出全新字典，随后基类循环又 `new Dictionary(members, ...)` 整表拷贝一份。改为把新字典的可变引用传出去，基类循环直接继承进去；仅未实例化的表才需要拷贝。`InstantiateTableAsync` 顺带加 `table.Count` 容量提示。

### 3.3 基类循环：无继承索引签名时跳过合并（小幅）

每个基类原必建一个 `List<IndexInfo>` 加 `ReadOnlyCollection` 包装，即使双方都没有索引签名。加空列表早退。

### 3.4 `AnonymousAsync`：字典容量提示（小幅）

匿名对象成员表按 `PropertiesAsync` 结果数预设容量。

另有三处索引循环替换 LINQ（`ContextualProperties` 的两个 List 容量、`TypeReferences.OwnTypeParameters/OuterTypeParameters`、`TypeNormalization.TupleAsync/SingleBaseAsync`），本负载实测收益接近零（这些 LINQ 多在缓存未命中路径），保留为实现正确性。

---

## 4. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | AOT 产品 0 警告 / 0 错误（`pkgs/r21/lib/tsc.exe` sha256 `09cfbcc20d…`，29,789,184 B） |
| 确定性分配 | 真实工程 868.0 → 837.2 MB（−3.5%）；巨文件 261.9 → 261.5 MB（−0.15%） |
| 逐字节一致 | 18 合成形状 + 5 staged 负载（1,882 产物）+ 巨文件 + 12 关系夹具，r18 与 r21 全部一致 |
| safety 套件 | 95 flags 中 **91 通过 / 4 失败**；4 个失败中 2 个需目录参数不可直接调用，另 2 个（`checker-relation-context-safety`、`program-emit-safety`）输出与 r15/r17 基线逐字节相同；`npm-process-safety` 本轮通过（该项历史上随环境波动） |
| 墙钟 | AB104（7 负载 × 15 配对，控制项 p95rel 28.3%、CI [0.912, 1.020]）：全部噪声内，无回归亦不做声明 |
| 探针清理 | 独占归因机制保留在 `CompilationCapture`（关闭时零成本），轮次专用的打印宽度已调回 24 |

---

## 5. 剩余清单与判断

| 项 | 量级 | 说明 |
| --- | ---: | --- |
| resolveMembers | 77 MiB（修复后） | 仍是最大独占帧。剩余为实例化的签名/索引数组、`Concatenate` 每基类数组合并、未实例化表的必要拷贝 |
| checkerRelated | 42 MiB | 主体是 `normalization.RelationTargetAsync` 与 Simple/Weak 检查（无独立帧，需再加一层探针才能拆分） |
| typeFromNode | 36 MiB | `CreateTypeReference` 的集合表达式数组、`NodeArgumentsAsync` 的列表 |
| symbolTypesGet | 32 MiB | 71 万次调用每次 47 B，疑似链接记录创建，待定位 |
| 关系引擎 inclusive 418 MiB | r14/r16 已归因 | 弥散的合法工作；杠杆在比较次数（设计级） |

判断：单点微修复的边际收益已从 r11 的 4.5% 衰减到本轮的 3.5%（且集中在成员表路径）。把 798 MiB 压向 Go 的 155 MiB 需要的不是更多同类修复，而是 r19 报告里那两个 substrate 级差距（无逃逸分析导致的临时分配上堆、每对象头），或检查器同步化重写。建议下一轮先用独占探针拆 checkerRelated 的 42 MiB（加规范化子帧），确认里面是否还有同类缺陷；若仍是个位数百分比，则分配侧收工。

---

## 6. 工作树状态

本轮提交含四个源文件修复（`StructuredMembers.cs`、`ContextualProperties.cs`、`TypeReferences.cs`、`TypeNormalization.cs`）与诊断基础设施的独占归因机制（`CompilationCapture.cs`、`CompilationStatistics.cs`）。
