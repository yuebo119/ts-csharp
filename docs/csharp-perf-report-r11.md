# r11 实施报告：打印器容器长尾与工作栈容量，附一次归因修正

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r11 ｜ 主题: printer-containers-and-work-stack
> 涉及 git 节点: `a91f4b98cb`（r10，`pkgs/r10` sha256 `a8e16e97a00b…`）/ 本轮提交
> 数据来源: 产品 AOT 交替对照（同机 3 组）；`bench/AB76`（r11 vs r10，23 负载 × 15 组配对，噪声 35.2%）；诊断探针计数
> 关联: `docs/csharp-perf-report-r07.md`（Part[] 61 MB 的提出）、`r10-comparison.md`

---

## 1. 结论

| 指标（巨文件，AOT 产品） | r10 | **r11** | 变化 |
| --- | ---: | ---: | ---: |
| **CLR 总分配** | 427.6 MB | **408.3 MB** | **−19.3 MB（−4.5%）** |
| Emit 时间 | 0.237~0.248 s | **0.230~0.233 s** | −3% |
| Total 时间 | 0.743~0.770 s | 0.737~0.746 s | −1% |
| 峰值 RSS（AB76 配对） | — | — | 巨文件 x0.97 |

配对 A/B（AB76，噪声 35.2%）：墙钟平均 x1.002（中性），无显著改善项、1 项显著变差（轻负载，绝对值 1~3 ms）。

---

## 2. 落地内容

### 2.1 四个热点发射器改为容器无关（`csharp-perf-report-r11.md` §2.1）

`Annotation`/`Initializer` 原本返回 `S(T(…), N(…))`（每次调用一个 `Part[]`）。新增容器无关的 `PushAnnotation`/`PushInitializer`，并改写四个最高频发射器：

| 发射器 | 原形态 | 现形态 |
| --- | --- | --- |
| `Emit(VariableDeclarationNode)` | `Push(4 参数, 其中 2 个 S(...))` | 三段 `Push`（初始化器 → 注解 → 名字/感叹号） |
| `Emit(ParameterDeclarationNode)` | `Push(6 参数)` | 三段 `Push`（同上） |
| `Emit(PropertyAssignmentNode)` | `Push(6 参数)` | 四段 `Push` |
| `Emit(PropertySignatureDeclarationNode)` | `Push(6 参数)` | 四段 `Push`（含 `Semicolon`） |

**注意点**：`Push` 是后进先出，多段推入必须**按反序书写**（尾组先推、首组后推），否则打印顺序颠倒。

> **勘误（2026-10-09，r13 轮补测）**：本报告初版另写有"每个 `Push` 保持在 ≤4 个参数以内，否则 `params ReadOnlySpan<Part>` 会分配堆数组"，该说法**错误**。实测：`params ReadOnlySpan<T>` 在 17 个实参、100 万次调用下分配 **0 字节**，同规模 `params T[]` 分配 96 字节/次；Roslyn 会为任意实参个数合成栈上内联数组（产品 DLL 中可见 `<>y__InlineArray17` / `<>y__InlineArray19`）。因此拆分多段 `Push` 的收益只来自容器无关化本身，与参数个数无关，无需为控制实参个数而拆分。

### 2.2 工作栈容量预估

`SyntaxPrinter.pending` 是 `Stack<Part>`，其**后备数组按倍增增长**：巨文件的实测峰值深度为 **12,307 个部件**，倍增链的瞬时分配约为最终大小的两倍。`SyntaxPrinter` 新增 `pendingCapacity` 构造参数：

- 串行打印：按 `tree.Statements.Count + 1024` 预估；
- 分段打印：按 `段内语句数 × 3 + 64` 预估（每语句一次推入 3 个部件）。

容量只是提示，超出时仍按原倍增行为增长（语义不变）。

---

## 3. 归因修正：trace 的 `Part[]` 行不是打印器的容器数组

r07 报告把 61 MB 的 `Part[]` 归给打印器的容器（`S(...)`/`Scoped(...)`）。本轮用探针计数逐一验证后**否定了该归因**：

| 探针 | 巨文件实测 |
| --- | ---: |
| `S(...)` 调用数（打印器唯一实现） | **0** |
| `Scoped(...)` 调用数 | **0** |
| `List(...)` 的 `ToArray` 分支调用数 | **0** |
| `Part` 容器持有 `Part[]` 的次数 | **0** |
| `Part` 容器持有 `List<Part>` 的次数 | 32,748 |
| `Checker.SymbolNodePrinter.S(...)` 调用数 | **0** |
| `Push(...)` 参数个数直方图 | 仅 1~3 个参数（≥4 为 0） |

也就是说：夹具上打印器**不产生任何 `Part[]`**，容器全部是 `List`（32,748 次）。而 trace 仍报 `Part[]` 54.6 MB。原因是**命名错配**：代码里存在 5 个同名嵌套类型 `Part`（`SyntaxPrinter`、`Checker.SymbolNodePrinter`、`RelationKey`、`TypeOrder`、`GoRegex`），trace 的短名聚合把它们混为一行；加上 `Stack<Part>` 后备数组的倍增（每实例约 2 MB × 若干实例）才是这行的主要来源。这与 r06 记录的 `List<SyntheticComment>` 异常属同一类问题（计数器证明其为零，而 trace 报 12~20 MB）。

**口径结论**：`dotnet-trace` 的类型级聚合对**嵌套类型**不可靠（短名合并 + 无法用 TypeBulkType 解析外层类型），只能用于发现"哪类对象多"，不能作为配额或改造依据；配额一律以编译器自报计数器与探针帧为准。

---

## 4. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（AOT 产品形态，`pkgs/r11` sha256 `7b4a576c6c92…`） |
| 逐字节一致 | 5 个基准负载（1,223 个产物）+ 18 个语句形态夹具 + 12 个关系边界夹具，全部与未改动产物一致 |
| safety 套件 | `emit-foundations`、`transpile`、`declaration`、`module-generation`、`checker-objects`、`checker-relations`、`checker-members`、`incremental` 全部通过 |
| 确定性分配 | 巨文件 427.6 → **408.3 MB** |
| 临时探针清理 | 计数探针与直方图全部移除，工作树只保留 2.1/2.2 两处真实改动 |

---

## 5. 剩余清单（打印器侧已无大项）

| 项 | 量级 | 说明 |
| --- | ---: | --- |
| `objectLiteral` 帧 | 0.39 s / 69.6 MB | 检查阶段最大单项：属性循环 0.21 s（初始化器检查 0.18 s = 表达式检查 + 上下文查询 + 加宽，主要是异步调用链开销） |
| `symbolTypesGet` | 25.4 MB / 0.11 s | 类型解析本体，属合法工作 |
| `typeFromNode` + `membersTable` | 20.2 / 16.7 MB | 注解类型与成员声明检查 |
| 启动地板 | ~55 ms | 93% 在 Main 之前 |
| 打印器容器 | **0**（已定界） | 热点形状早已容器无关，剩余为 `List` 容器（32,748 次） |
