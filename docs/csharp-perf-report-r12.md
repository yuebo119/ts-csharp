# r12 实施报告：上下文属性查询的同步快路径，附一条测量教训

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-09 ｜ 轮次: r12 ｜ 主题: contextual-property-sync-fast-path
> 涉及 git 节点: `bd18c0ea6c`（r11，`pkgs/r11` sha256 `7b4a576c6c92…`）/ 本轮提交
> 数据来源: 产品 AOT 交替对照（同机 3 组）；CoreCLR 诊断构建的探针帧；12 个上下文正例夹具
> 关联: `docs/csharp-perf-report-r11.md`（剩余清单）

---

## 1. 结论

| 指标（巨文件） | r11 | **r12** | 变化 |
| --- | ---: | ---: | ---: |
| **CLR 总分配（AOT 产品）** | 408.3 MB | **406.0 MB** | −2.4 MB（−0.6%） |
| Check（AOT 产品） | 0.277~0.285 s | 0.276~0.286 s | **无变化**（噪声内） |
| Check（CoreCLR 诊断） | 1.081 s | **0.993 s** | −8%（不迁移，见 §4） |
| `ctxElement` 帧（CoreCLR） | 0.073 s / 15.0 MB | **0.051 s** | −30% |
| `mutableContextual` 帧（CoreCLR） | 0.086 s | **0.065 s** | −24% |

快路径命中数实测 **65,536 次**（巨文件 32K 属性 × 两遍），与预期完全一致。

---

## 2. 落地内容

### 2.1 `TypeProperties.PropertyAsync` 的同步快路径

上下文查询链每属性走 `ContextualProperties.GetAsync` → `ConstituentAsync` → `ConcreteAsync` → `PropertyAsync`，而 `PropertyAsync` 开头会执行 `ReducedApparentAsync`，它本身是 `ReducedAsync(ApparentAsync(ReducedAsync(type)))` 三个异步调用。对**成员表已解析的普通匿名对象类型**这三者都是恒等变换，`ResolveAsync` 也已短路。因此在 `PropertyAsync` 入口加同步快路径：

```csharp
if (type is ObjectType obj && (obj.ObjectFlags & ObjectFlags.MembersResolved) != 0
    && (type.Flags & TypeFlags.Instantiable) == 0 && type is not (TypeReference or MappedType or UnionOrIntersectionType)
    && obj.Members is { } members && members.GetValueOrDefault(name) is { } symbol
    && (symbol.Flags & S.Value) != 0
    && (includeTypeOnly || !(type.Symbol is { } owner && (owner.Flags & S.ValueModule) != 0
        && links.Modules.TryGet(owner)?.TypeOnlyExportStars?.ContainsKey(name) == true)))
    return ValueTask.FromResult<Symbol?>(symbol);
```

逐条等价性：

| 条件 | 依据 |
| --- | --- |
| `ReducedAsync`/`ApparentAsync` 恒等 | 二者只变换 union、intersection、mapped、reference 与 instantiable 类型（`Instantiable` 已在条件中排除） |
| `ResolveAsync` 可跳过 | `MembersResolved` 已置位时 `StructuredMembers.ResolveAsync` 立即返回 |
| 成员表查找等价 | 与慢路径同一张 `resolved.Members` 表、同一 `GetValueOrDefault(name)` |
| `ValueAsync` 为真 | 慢路径对非别名的判断就是 `(Flags & Value) != 0`；**别名回落慢路径**（需要 resolver） |
| type-only 导出检查等价 | 慢路径用 `links.Modules.Get(owner)`（会建链接），快路径用 `TryGet`：链接不存在 ⇒ `TypeOnlyExportStars` 为 null ⇒ 判断同样为 false |
| 兜底 | 任何条件不满足即回落 `PropertySlowAsync`，慢路径原样保留 |

### 2.2 上下文查询不再创建链接

`Checker.ObjectElementContextAsync` 原本用 `links.Values.Get(symbol).NameType` 读取名字类型；`Get` 会为该属性符号创建 `ValueSymbolLinks`。改为 `links.Values.TryGet(symbol)?.NameType`（链接不存在时 `NameType` 本来就是 null，语义相同）。

### 2.3 正例夹具（12 个，先建夹具后改代码）

按 r08 的教训，先建立覆盖被快路径"绕过"分支的正例，再动代码：`ctxplain`（普通对象）、`ctxnested`（嵌套对象）、`ctxarray`（数组/元组元素）、`ctxdestr`（解构与函数参数解构）、`ctxopt`（可选属性与 `undefined`）、`ctxindex`（索引签名兜底，含 2 处必报错）、`ctxunion`（联合上下文）、`ctxgeneric`（泛型推断）、`ctxtuple`（元组）、`ctxfunc`（函数表达式参数的上下文签名）、`ctxsatisfies`（`satisfies`/`as const`）、`ctxmapped`（映射类型与 `Record`）。

全部 12 个与未改动产物**逐字节 + 逐诊断**一致；命中计数证明快路径确实被走到（65,536 次），不是"写了但从不触发"。

---

## 3. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（AOT 产品形态，`pkgs/r12` sha256 `f606a09f7885…`） |
| 逐字节一致 | 5 个基准负载（1,223 个产物）+ 18 个语句形态夹具 + 12 个关系边界夹具 + **12 个上下文正例夹具**，全部与未改动产物一致 |
| safety 套件 | `checker-context-query`、`checker-properties`、`checker-objects`、`checker-relations`、`checker-inference`、`checker-mapped-members`、`emit-foundations`、`transpile`、`declaration` 全部通过 |
| 临时探针清理 | 命中计数与统计打印已移除，热路径无计数开销 |

---

## 4. 测量教训（第三次同类实证）

CoreCLR 诊断构建显示 Check −8%、`ctxElement` −30%，但**产品 AOT 上 Check 无变化**。原因是移除的那部分开销是**异步调用链的运行时成本**，而 NativeAOT 的 `ValueTask`/异步机制实现与 CoreCLR 不同（更省）。

同类实证已有三次：r07 的身份哈希（CoreCLR 慢路径占主线程 10%，AOT 无收益）、r11 的 trace 嵌套类型命名错配、本轮的异步链开销。**结论**：CoreCLR 剖析只能回答"热在哪一层"，不能回答"能省多少"；所有微优化（尤其是运行时机制相关的）必须以产品 AOT 的配对测量为准。

本轮改动仍然保留：它在 AOT 上是严格更少的工作（每次命中省 3 个异步调用 + 1 次字典查找，实测命中 65,536 次），且分配下降 2.4 MB、无语义变化、全部语料字节一致。

---

## 5. 剩余清单

| 项 | 量级（AOT 产品） | 说明 |
| --- | ---: | --- |
| Check 总量 | 0.28 s（约 3.0× Go） | 已从 r06 的 0.32 s 降至 0.28 s；`objectLiteral` 仍是最大帧（CoreCLR 0.44 s / 70 MB，其中初始化器检查 0.21 s） |
| 初始化器检查链 | — | 剩余为 `CheckExpressionAsync` 本体与 `WidenLiteralAsync`（加宽/映射/规范化），已无明显的异步链冗余 |
| `symbolTypesGet` | 25.4 MB | 类型解析本体，属合法工作 |
| 启动地板 | ~55 ms | 93% 在 Main 之前，不做代码级投入 |
| 打印器 | 已定界 | 容器数组为 0，剩余为 32,748 次 `List` 容器 |
