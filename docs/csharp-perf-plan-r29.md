# r29 规划：用 C#/.NET 11 原生特性替换 Go 移植形状——分派、诊断参数与查找键（2026-10-11）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-11 ｜ 轮次: r29 ｜ 主题: dotnet-native-shape-replacement
> 涉及 git 节点: `4917d8d02c`（r28，工作树基线，本轮无产品源码改动）
> 数据来源: Serena 源码取证（分派形状计数、params 站点、Utf8String 实现、锁站点）；`tsc/internal` Go 对照；既有实测（r20~r28）
> 关联: `docs/csharp-perf-plan-r25.md`、`docs/csharp-perf-plan-r28.md`（流程审计）、`docs/csharp-perf-report-r24.md`（runtime-async 定价）

---

## 0. 结论摘要

本轮换一个透镜：不找流程冗余、不向 Go 对齐（r28 已做完），而是找**移植形状本身限制了 C# 代码**的位置——Go 用机制 A 的地方，移植照抄了 A 的形态，而 .NET 11/C# 15 有原生更优解。三条主建议：

1. `[事实+推断]` **节点分派 Kind 跳转表化（P1）**：Go 的每节点分派是 `switch node.Kind`（整数枚举，编译为跳转表，O(1)）；C# 移植用了类型模式 switch（`case XxxNode x:`，编译为顺序 `isinst` 类型测试链，O(案例数)）。`Checking/` 下类型模式分派 **22 处**、Kind 分派仅 7 处；主语句分派链 165 个 case 标签。每节点平均十几次类型测试 [推断] 占检查阶段 1~5%。
2. `[事实]` **诊断创建侧 `params` 数组 span 化（P2）**：`Diagnostic.Format` 已用 `params ReadOnlySpan<Utf8String>`（仓库自有先例），但创建侧 `CheckerDiagnostic.Create`、`ExplainArguments`、各局部 `Report` 仍是 `params T[]`（约 14 个文件）——每条带参诊断分配 1~3 个堆数组。诊断密集负载（host-paths，对 Go x1.87 的未解缺口）正对症。
3. `[事实+推断]` **Utf8String 字典查找成本（P3，探针前置）**：`GetHashCode() => XxHash3(Span)` 每次查找对全字节重算、无缓存字段（r25 §2.3 遗留）；.NET 9+ 的 `GetAlternateLookup`/构造期哈希是两个原生解法，但净值可能为负（构造期付代价、切片多），必须先跑 r25 留下的 10 分钟命中率探针。

---

## 1. 已充分利用的特性（防重复建议）

| 特性 | 落点 | 依据 |
| --- | --- | --- |
| runtime-async（.NET 11） | 全检查路径，状态机零分配、await 1.30ns | r24 实测；r19 证 .NET 10 经典 async 形态慢 16~41% |
| `SearchValues<byte>` | 扫描器标识符/注释集 | r20 审计确认 |
| `CollectionsMarshal.GetValueRefOrAddDefault` / `AsSpan` | LinkStore、TypeMapper 免复制 | 仓库源码；r26 落地后两项 |
| `Parallel.ForAsync` | emit 按文件并发 | r05 起 |
| `params ReadOnlySpan<T>`（C# 13） | `Diagnostic.Format` | `Diagnostic.cs:23` |
| UTF8 `BigInteger.Parse(ReadOnlySpan<byte>)`（.NET 11 独有） | 字面量解析 4 处 | r19 移植性审计 |
| Span/`stackalloc`、sealed 层级、ValueTask | 全库 | 源码通读 |

基线：`net11.0` + `LangVersion 15.0` + `OptimizationPreference=Speed` + AOT 全链路（`Directory.Build.props`）——C# 13/14/15 的 params span、`field`、扩展成员、`System.Threading.Lock`（.NET 9+）全部可用。

## 2. 建议（按优先级）

### P1 节点分派改为 Kind 跳转表（最大项，分批实施）

- **现状**：Go `checker.go:2305` 起 `switch node.Kind`（枚举跳转表）；C# `CheckSourceElementAsync`（`Checker.Source.cs:135`，165 个 case 标签）、`ExpressionTypes.WorkerAsync`（`:71`）等 22 处类型模式链。Roslyn 对类型模式只能编顺序类型测试（sealed 类为 MethodTable 指针比较，~1~2ns/次），无法建类型哈希表；对密集枚举 switch 编跳转表。
- **量级**：`[推断]` 语句种类在链首 6 位内（热种类靠前，语句分派本身偏差），但**表达式分派才是体量所在**（每个表达式节点都走）：字面量在前、标识符/属性访问/调用在中后段。按每节点平均 8~20 次测试 × 1~2ns × 检查期 10⁵~10⁶ 节点估计 1~5% 检查阶段墙钟。
- **修法**：`switch (node.Kind)`（SyntaxKind 为生成枚举、值密集，直接命中跳转表）→ case 内一次强转。带 `when` 卫句的少数 case 卫句后移；一 kind 多类型分组的 case 保持 or-模式（`case K.A or K.B:`）。
- **分批与门禁**：第一批只改 `ExpressionTypes.WorkerAsync` + `CheckSourceElementAsync` 两个最高频分派，配 AB 配对（medium/huge-file/checkers-1）与逐字节 25/25；正向才推其余 20 处。风险：Kind↔类型 1:1 假设由生成的 AST 工厂保证，default 兜底 + 逐字节门禁覆盖。

### P2 诊断创建侧 params span 化（对症 host-paths）

- **现状**：`CheckerDiagnostic.Create(node, message, params Utf8String[])`（`CheckerDiagnostic.cs:22`）、`RelationOperation.ExplainArguments(code, params object[])`（`TypeRelations.cs:283`）、`Checker.MissingProperties` 等处局部 `Report(code, params Utf8String[])`、以及 `ReportUnused` 里手工建的 `arguments = [...]` 数组。每条带参诊断 1~3 个堆数组（24B 头 + 元素），诊断密集负载上成规模。
- **修法**：创建签名改 `params ReadOnlySpan<Utf8String>`（`Diagnostic.Format` 已示范模式；诊断对象内部存储仍可物化为数组——分配从"每调用"降到"每条被保留的诊断"）。`object[]` 参数的 `ExplainArguments` 同理用 `params ReadOnlySpan<object>`。
- **门禁**：诊断输出逐字节（bytecheck 语料含报错夹具）+ host-paths/medium AB 配对；分配配对看诊断密集形态。
- **量级**：`[推断]` host-paths 类负载分配 −1~3%；干净工程近零。

### P3 Utf8String 查找成本（探针前置，可能净负）

- **现状**：`Utf8String.GetHashCode() => Hash(Span)`（`Utf8String.cs:63`）——成员表/符号表（`Dictionary<Utf8String,...>`）每次 TryGetValue 对 8~15 字节标识符重算 XxHash3；`implicit operator Utf8String(ReadOnlySpan<byte>) => Copy(value)` 还会对 span 键做字节复制。
- **两个原生解法**：①构造期一次性算哈希存字段（`readonly struct` 拷贝安全，因为字段随构造初始化）——代价是所有从不做键的 Utf8String（字符串拼接、诊断文本）也付哈希；②.NET 9+ `IAlternateEqualityComparison<ReadOnlySpan<byte>, Utf8String>` + `GetAlternateLookup`——span 探针免键构造，但不解决已物化键的重复哈希。
- **前置探针（r25 §2.3 遗留，仍未跑）**：成员表查询计数 + 键长度分布 + 同键重复查询率（探针基础设施已有）。命中率与重复率高才值得做；`[推断]` 1~3%，且方向①可能净负。
- **同族小项**：`TypeMapper.Direct` 构造时 `Array.AsReadOnly` 双包装（`SourceTypes/TargetTypes` 属性，`TypeMapper.cs:170-171`）——消费侧全在库内，可存裸数组省每映射器两个包装对象。

### P4 卫生项（无墙钟主张，随手批）

- 23 处 `lock (x)` → `System.Threading.Lock` 类型字段（.NET 9+，争用路径更便宜；本库多为冷路径，纯卫生）。
- `OptionDefinitions.All.First(o => o.Name == ...)`（`Resolution.cs:102`、`CompilerProgram.cs:496`）——线性 LINQ 扫描，换预建 `FrozenDictionary<Utf8String, OptionDefinition>`（查询面在选项解析/库路径，一次性或低频）。
- `BuildGraph` 尾部 `Where().OrderBy().Concat().ToArray()` 四遍 LINQ（`CompilerProgram.cs:506-507`）——一次性，仅在顺手时改。

### P5 明确不做（与既有否决一致）

| 项 | 理由 |
| --- | --- |
| 自定义 Utf8String 全量换 BCL `System.Utf8String` | arena 级重写，接口面全库渗透 |
| 数组/对象池化扩张 | r27 实测 AOT 布局回归（RelationOperation 池） |
| 向量化（AVX-512/Vec256） | r20 三批实测零收益或更差 |
| 经典 async 形态回退 / ValueTask 池 | r24 定价：runtime-async 已零分配 |
| R 层同步化重写 | r23/r24 关闭（栈守卫零触发、异步税 2ns） |

## 3. 实施序与门禁总表

| 序 | 项 | 前置 | 门禁 |
| --- | --- | --- | --- |
| 1 | P3 探针（查询计数/键长/重复率） | 无 | 探针报告决定 P3 去留 |
| 2 | P2 params span（~14 文件） | 无 | 逐字节 25/25 + safety + host-paths/medium AB + 诊断密集分配配对 |
| 3 | P1 第一批（两处高频分派） | 无 | AB（medium/huge-file/checkers-1）+ 逐字节；正向再推全量 22 处 |
| 4 | P1 全量 + P4 卫生批 | 第 3 步正向 | 同上 |

## 4. 本轮未做与未验证

- 未改产品源码；P1 的 1~5% 与 P2 的 1~3% 均为 [推断]，需按 §3 门禁实测裁决。
- P1 未清点全部 22 处分派的各自 case 数与热种类位置（仅取证两个最高频入口）；分批实施时逐处清点。
- 表达式分派的完整链长与热种类位置未逐一标注（`ExpressionTypes.WorkerAsync` 仅读前 75 行）。
