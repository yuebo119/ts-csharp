# r15 归因与实施报告：类型节点流与类引用的两处按调用分配

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r15 ｜ 主题: type-flow-and-class-reference-allocation
> 涉及 git 节点: `8ba5744823`（r14 归因，工作树基线）/ 本轮提交
> 数据来源: CoreCLR 诊断构建的两层内层探针（每线程分配增量，跨检查器求和）；产品 AOT 确定性分配（同机 3 组）；24 个夹具 + 12 个关系夹具的产物逐字节比对
> 关联: `docs/csharp-perf-report-r14.md`（关系引擎归因，本轮起点）、`docs/csharp-perf-report-r13.md`（上一轮实施）

---

## 0. 本轮结论

| 指标（产品 AOT，确定性分配） | r13 | **r15** | 变化 |
| --- | ---: | ---: | ---: |
| 巨文件 CLR 总分配 | 267,224,456 | **262,038,432** | **−5,186,024 B（−1.94%）** |
| 真实工程（TS 编译器自身 + lib 291 文件）CLR 总分配 | 880,407,840 | **868,757,832** | **−11,650,008 B（−1.32%）** |

分配数字的重复性：巨文件 r13 三组落在 29 KB 区间内、r15 落在 45 KB 区间内；真实工程两侧分别落在 172 KB / 129 KB 区间内。变化量比重复性带宽大两个数量级。

**两处修复都是"每次调用分配一个临时容器"的结构性缺陷**，与 r11（打印器容器）、r13（谓词工作栈）同族：
1. `TypeNodeFlow.ApplyAsync` 每次调用无条件 `new List<Type>()`，而 220,465 次调用里只有 102 次真正往里添加约束（0.046%）。
2. `TypeReferences.ClassReferenceAsync` 每次调用用 Skip/Take/Cast/ToArray 四层 LINQ 枚举器取出形参数组。

---

## 1. 为什么查这四个帧

r14 归因了关系引擎（44.7%，弥散无可修项）后，剩余清单指向四个未归因大帧：`objectLiteral`（100 MB 量级）、`symbolTypesGet`（83 MB）、`variableType`（62 MB）、`typeFromNode`（62 MB）。本轮给这四个帧加内层探针（21 个新帧），先归因再动手。

**口径说明（与 r14 的差异）**：本轮采集时补齐了 `node_modules/@types/node`（22.20.4，package.json 要求 `^22.20.1`；此前该目录是 npm 安装不完整留下的空目录，导致 TS2688、检查阶段整体跳过）。补齐后负载为 291 文件（186 源码 + 105 lib/@types），进程级分配 959 MB（CoreCLR 诊断构建）。该负载在 C# 移植版上有 11 行 TS7006 诊断，Go 基准为 0 行——这是移植版既有的推断差异（r13 报告的 337 行口径对应当时的 @types/node 状态），**修复前后逐字节一致**，不影响本轮结论。

---

## 2. 四个帧的内层拆解（真实工程，CoreCLR 诊断构建，进程级总分配 959 MB）

| 帧 | MiB | 占总分配 | 内层构成 |
| --- | ---: | ---: | --- |
| `relationCompare` | 418.3 | 43.6% | r14 已归因（弥散，无可修项） |
| `resolveMembers` | 203.2 | 21.2% | 成员表解析本体（合法工作） |
| `relationProperties` | 141.5 | 14.8% | r14 已归因（透传） |
| `symbolTypesGet` | 124.8 | 13.0% | `symVariable` 86.0（69%）+ `symInstantiated` 27.8（22%）+ 其余 <3% |
| `typeFromNode` | 84.4 | 8.8% | `typeReference` 46.2（55%）+ `typeIndexedAccess` 11.8 + `typeUnion` 11.3 + **`typeFlow` 7.5（8.9%）** + `typeLiteral` 3.4 + 其余 <3% |
| `variableType` | 81.9 | 8.5% | `varInitializer` 62.9（77%）+ `varAnnotationNode` 14.1 + `varOptional` 2.7 + `varBinding` 2.0 |
| `objectLiteral` | 50.6 | 5.3% | `objectMutable` 44.3（87.5%，透传）+ 其余 <1% |
| `setMembers` | 41.7 | 4.3% | 成员表设置（合法工作） |
| `propertyLookup` | 43.8 | 4.6% | 属性查找慢路径（缓存保护） |

读法：帧是包含式的。四个目标帧的结论：

- **`objectLiteral` 无可修项**：`objectMutable` 44.3 MB 几乎全部由 `objectCheckExpr` 30.0 MB（表达式检查本体）构成，是透传；其余子帧均 <1 MB。r13 修掉 `Maybe` 后这里已无"每调用一容器"缺陷。
- **`variableType` 无可修项**：`varInitializer` 62.9 MB 的主体是 `DeclarationInitializerAsync` 转发到的表达式检查（`QuickExpressionTypeAsync` / `Expressions.CheckAsync`），透传。
- **`symbolTypesGet` 无可修项**：`symVariable` 86 MB 正是 `VariableTypes.GetAsync`（含上面的 `varInitializer`），`symInstantiated` 27.8 MB 是泛型实例化本体。
- **`typeFromNode` 有两处可修**：`typeFlow` 7.5 MB 与 `typeReference` 内的 LINQ 链。

---

## 3. 修复一：`TypeNodeFlow.ApplyAsync` 的约束列表改为惰性分配

`ApplyAsync` 在每个类型节点解析后运行，向上遍历父链，只在两种罕见位置收集替换约束：条件类型的真分支（且能推断出约束）、同构映射类型的类型参数位置。原实现无条件 `new List<Type>()`。

**量化（计数器实测）**：220,465 次调用中只有 102 次产生约束（0.046%）。空 `List<Type>` 的对象头是 32 字节，220,465 × 32 = 7.05 MB，与修复前 `typeFlow` 帧的 7.15 MiB 吻合——**该帧几乎全部是空 List 的分配**。

**修复**：`List<Type>? constraints = null`，两处 `constraints.Add` 改为 `(constraints ??= []).Add`，末尾 `constraints.Count == 0` 改为 `constraints is null`。语义逐字等价：原来空列表时返回原类型，现在 null 时返回原类型；有约束时的路径不变。

**效果**（CoreCLR 诊断构建）：`typeFlow` 帧 7,491,528 → 208,800 B（−97.2%）。

---

## 4. 修复二：`ClassReferenceAsync` 的形参提取改为索引循环

原实现用四层 LINQ 取出类的自身类型参数（排除外层参数与 this 参数）：

```csharp
var parameters = type.AllTypeParameters.Skip(type.OuterTypeParameterCount)
    .Take(type.AllTypeParameters.Count - type.OuterTypeParameterCount - (type.ThisType is null ? 0 : 1))
    .Cast<TypeParameter>().ToArray();
```

每次调用分配 Skip/Take/Cast 三个枚举器对象加 ToArray 的结果数组。实测 `ClassReferenceAsync` 在真实工程被调用 41,845 次。

**修复**：手写索引循环，一次分配结果数组。语义等价性：`Cast<TypeParameter>` 对每个元素做硬转换，手写 `(TypeParameter)` 相同；`Take` 的负计数行为（返回空序列）由 `parameterCount <= 0 ? [] : ...` 覆盖；循环次数与 Take 的计数逐字相同。

**效果**（CoreCLR 诊断构建）：`typeReference` 帧 46,239,040 → 41,164,408 B（−11.0%），`typeFromNode` 帧同步 −3.5 MB。

---

## 5. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | AOT 产品形态 0 警告 / 0 错误（`pkgs/r15/lib/tsc.exe` sha256 `8bcc62ccff4d…`，29,781,504 B） |
| 确定性分配 | 巨文件 −1.94%、真实工程 −1.32%，各 3 组交替（§0） |
| 逐字节一致（合成形状） | 18 个语句形状（plain/annot/func/klass/ifelse/nosemi/directives/shebang/blanks/singleton/templ/deco/usingx/constenum/privfield/crossenum/constarg/constprop）产物 + 诊断全部一致 |
| 逐字节一致（staged 负载） | 5 个负载目录递归比对 **1,882 个产物，0 处差异**（declarations 132、medium 194、tiny-files 1538、host-paths 8、huge-file 5，另巨文件全量夹具 5） |
| 逐字节一致（关系夹具） | 12 个关系边界夹具（relmiss/relopt/relidx/relnum/relmethod/relreadonly/relnested/relempty/relgen/relunion/relany/relspread）产物 + 诊断一致（relmiss/relnum/relopt 的 exit 2 为夹具预期诊断） |
| 逐字节一致（真实工程） | 291 文件负载的诊断输出逐字节一致（11 行，exit 2 两侧相同） |
| safety 套件 | 95 flags 中 **90 通过 / 5 失败**；3 个可调用失败（`checker-relation-context-safety`、`npm-process-safety`、`program-emit-safety`）经 stash 后在未改动源码上以**同一输出、同一退出码**复现，另 2 个（`developer-safety`、`lsp-native-watch-safety`）需目录参数不可直接调用。与 r13 口径（90 通过 / 3 失败）一致 |
| 探针清理 | 21 个内层帧、4 个计数器、报表宽度改动全部移除，工作树只保留 `TypeNodeFlow.cs` 与 `TypeReferences.cs` 两处真实改动 |

---

## 6. 墙钟测量（AB82，r15 vs r13 直接对照）

批次：23 负载 × 15 组交替配对，同可执行文件控制项 `p95RelativePairDifference` = **11.9%**（medianRatio 0.996，CI [0.972, 1.034]），判为有效（参照：r11 判废线 35.2%、r13 批 21.9%）。槽位间外部 CPU 消耗对称（ZCode 21,286s vs 21,438s、VBCSCompiler 1,229s 持平），无槽位时段偏置。

| 结果 | 项数 | 说明 |
| --- | ---: | --- |
| 显著更快 | 0 | — |
| 噪声内 | 22 | 含 huge-file +0.7%（820.5 → 814.5 ms，CI [0.986, 1.010]）、medium-checkers-2 +3.0%（CI 含 1.0） |
| 显著变慢 | 1 | `project-references-implementation` 73.1 → 76.8 ms（+5.1%，CI [1.006, 1.141]，+3.7 ms） |

**本轮改动不给出墙钟收益声明**：22/23 项在噪声内，收益全在分配侧（§0）。两处修复只删除每次调用的容器分配、不增加任何工作，与唯一显著变慢项（轻负载，73 ms 中约 55 ms 在 Main 之前）没有合理因果路径。该项按 r13 对 `host-paths` 的先例记为**待复核项**，未归因到任何代码改动；建议空闲机器复测。

---

## 7. 剩余清单

| 项 | 量级（真实工程，探针求和值） | 说明 |
| --- | ---: | --- |
| `relationCompare` 族 | 418 MB（43.6%） | r14 已归因：弥散，无单项超 3%，杠杆在比较次数而非单次成本，属设计级改动 |
| `resolveMembers` + `setMembers` | 245 MB（25.5%） | 成员表解析与设置本体，合法工作 |
| `symVariable` → `varInitializer` | 86 → 63 MB | 初始化器表达式检查本体，透传 |
| `typeReference` 剩余 | 41.2 MB | 类型引用解析（符号查找 + 实例化），合法工作 |
| 顶层缓存命中率 | 未知 | r14 建议的计数项，需要先加计数器再决定是否动缓存策略 |

---

## 8. 工作树状态

本轮探针与计数器已全部移除。提交只含 `TypeNodeFlow.cs`（惰性约束列表）与 `TypeReferences.cs`（索引循环替代 LINQ 链）两处改动。
