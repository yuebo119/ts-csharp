# r10 实施报告：同形匿名对象类型的关系快路径

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r10 ｜ 主题: identical-shape-relation-fast-path
> 涉及 git 节点: `7e831f9da5`（r09，`pkgs/r09` sha256 `cce7e6694c1b…`）/ 本轮提交
> 数据来源: 产品 AOT 交替对照（同机 3 组）；`bench/AB72`（r10 vs r09，23 负载 × 15 组配对，噪声 26.7%）
> 关联: `docs/csharp-perf-report-r09.md`（剩余清单第 2 项）

---

## 1. 结论

| 指标（巨文件，AOT 产品） | r09 | **r10** | 变化 |
| --- | ---: | ---: | ---: |
| **Check** | 0.329~0.353 s | **0.284~0.300 s** | **−13.5%** |
| Emit | 0.234~0.247 s | 0.225~0.245 s | 持平 |
| **Total** | 0.795~0.827 s | **0.752~0.755 s** | **−6.3%** |
| CLR 分配 | 440.3 MB | **427.6 MB** | −12.7 MB（−2.9%） |
| `checkerRelated` 帧（CoreCLR） | 0.19 s / 14.3 MB | **0.032 s / 7.9 MB** | **−83% / −45%** |

配对 A/B（AB72）：巨文件 891 → 846 ms，**wall x0.949 [0.937, 0.970]**（显著）；2 项显著改善、0 项显著变差；23 项平均 x0.999（本负载族收益集中在"同形比较密集"的代码上）。

---

## 2. 改动与健全性论证

### 2.1 位置

`StructuralRelations.RelatedAsync` 在完成廉价判定（`SimpleAsync`、`StructuredOrInstantiable` 过滤）之后、进入 `operation.RecursiveAsync`（会话机制）之前插入：

```csharp
if (operation.Kind is RelationKind.Assignable or RelationKind.Comparable && IdenticalShape(source, target))
    return Ternary.True;
```

放在这里可以同时跳过：会话的键/缓存/maybe 集合/栈、`VarianceAsync`、`AfterVarianceAsync`（逐属性关系 + 索引/签名检查）与多余属性检查。

### 2.2 `IdenticalShape` 的条件（全部为必要前提）

| 条件 | 原因 |
| --- | --- |
| 双方均为 `ObjectType`、非 `TypeReference` | 引用/实例化类型保留完整路径 |
| 双方 `ObjectFlags` 均含 `MembersResolved`，且不含 `JsxAttributes`/`Mapped`/`Reference`/`Tuple` | 成员表可直接读；排除特殊语义 |
| 双方属性数 > 0 且相等 | 空对象与弱类型检查走完整路径 |
| 双方 `IndexInfos`/`CallSignatures`/`ConstructSignatures` 均为空 | 索引与签名比较不可能失败 |
| 每个源属性在目标中存在同名属性，且 `Optional` 与 `CheckFlags.Partial` 一致 | 可选性差异会让完整算法判 False |
| 两侧该属性的**已解析类型引用相同**（`host.ResolvedSymbolType` 只读缓存，不触发解析） | 属性类型相同 ⇒ 属性关系为真 |
| `operation.Kind` 仅限 `Assignable`/`Comparable` | 身份/子类型关系语义不同，不做快路径 |

在上述条件下，完整算法会依次通过：弱类型检查（有共同属性）、逐属性关系（类型引用相同）、多余属性检查（属性名集合相同）、索引与签名检查（两侧皆空），因此答案为 True。任何一条不满足即回落到完整算法，快路径不会产生 False 或 Maybe。

### 2.3 边界夹具（12 个，与未改动的 r09 产物逐字节 + 逐诊断对比）

| 夹具 | 场景 | 参考侧错误数 | 结果 |
| --- | --- | ---: | --- |
| `relmiss` | 多余属性（`{a:1,b:2}` → `{a:number}`） | 1 | 一致 |
| `relopt` | 可选性不匹配（`{a?:number}` → `{a:number}`） | 1 | 一致 |
| `relnum` | 属性类型不匹配（`'x'` → `number`） | 2 | 一致 |
| `relidx` | 目标带索引签名 | 0 | 一致 |
| `relmethod` | 方法 vs 属性函数类型 | 0 | 一致 |
| `relreadonly` | readonly 差异（可赋值） | 0 | 一致 |
| `relnested` | 嵌套对象 | 0 | 一致 |
| `relempty` | 空对象与可选属性 | 0 | 一致 |
| `relgen` | 泛型推断后的对象类型 | 0 | 一致 |
| `relunion` | 目标为对象联合 | 0 | 一致 |
| `relany` | `any` 来源 | 0 | 一致 |
| `relspread` | 展开构造的对象 | 0 | 一致 |

三处必须报错的夹具错误数与文本均一致 ⇒ 快路径既没有把 False 变成 True，也没有吞掉诊断。

---

## 3. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（AOT 产品形态，`pkgs/r10` sha256 `a8e16e97a00b…`） |
| 逐字节一致 | 5 个基准负载（1,223 个产物）+ 18 个语句形态夹具 + **12 个关系边界夹具**（含诊断文本），全部与未改动产物一致 |
| safety 套件 | `checker-relations`、`checker-generic-relations`、`checker-objects`、`checker-assignability`、`checker-context-query`、`checker-inference`、`checker-algebra`、`checker-mapped-members`、`emit-foundations`、`transpile`、`declaration` 全部通过 |
| 配对 A/B | AB72：巨文件 x0.949 [0.937,0.970]（显著），无显著变差项 |
| 确定性分配 | 巨文件 440.3 → 427.6 MB |

---

## 4. 剩余清单

| 项 | 量级 | 前置条件 |
| --- | ---: | --- |
| `Part[]` 直推化（约 40 处长尾容器） | 61 MB（全量 14%） | 机械改造；注意 `Push` 后进先出，多段推入需按反序书写，逐处字节一致验证 |
| 实参位置的上下文类型重复查询 | 17.9 MB | 需按节点+flags 记忆化且能随延迟推断更新 |
| `symbolTypesGet`（类型解析本体） | 25.4 MB / 0.15 s | 属合法工作 |
| 启动地板 | ~55 ms | 93% 在 Main 之前，不做代码级投入 |
