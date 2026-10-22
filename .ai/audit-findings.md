# 审计发现（ts-csharp 常驻审计代理）

> 编号规则：`F-<轮次>-<序号>`。每轮追加一节，不改历史条目。修复完成后在原条目标 `closed`，附提交号与门禁输出行。

---

## 第 1 轮：门禁有效性（2026-10-22）

模式 A 只读审计加手工变异。范围：Compatibility 台架的 93 个 safety 旗标与 `perf-verify.mjs` 的 6 夹具逐字节门禁。产品代码零改动，全部变异已回退。

### 三句话定位

本轮目标面是门禁有效性（覆盖率的目录分布、10 个高风险站点的手工变异、断言强度），该面在否决表里没有记录（性能三表只约束性能方向，门禁质量从未被定价），本轮采用模式 A 只读审计，变异作为临时手段且全部回退。

### 0. 基线与收尾状态

| 项 | 实测 | 时间 |
| --- | --- | --- |
| `dotnet build csharp/TypeScript.slnx -c Release` | 0 警告 0 错误 | 47 s 冷，14.7 s 增量 |
| `node csharp/tools/run-safety-suite.mjs` | 93 旗标枚举，90/93 通过，失败集合 = 文档基线 | 104 s |
| `perf-verify --label audit-r01-pre` | 6 夹具 201 产物 | 27 s |
| 收尾复验 `--compare audit-r01-post` | BYTECHECK-OK（干净重建与基线逐字节一致） | 27 s |
| `git status` | 仅 `?? .ai/prompts/` `?? .zcode/`，无产品代码残留 |  |

### 1. 覆盖率基线（safety 套件口径）

`dotnet-coverage collect` 包住整套 safety 套件，按目录聚合。口径是 `TypeScript.Compiler` 的程序集，只含 93 个 safety 旗标执行到的路径，不含 6 夹具 CLI 运行路径。列名「条目」是 cobertura `<class>` 数，不是文件数。

| 目录 | 条目 | 行覆盖 | 分支覆盖 |
| --- | ---: | ---: | ---: |
| Storage | 8 | 0.0% (0/88) | 0.0% (0/28) |
| Experiments | 13 | 0.0% (0/924) | 0.0% (0/848) |
| Semantics | 21 | 30.8% (9398/30513) | 8.8% (436/4960) |
| Protocol | 33 | 32.4% (1800/5556) | 25.6% (1410/5506) |
| LanguageServices | 379 | 33.7% (6786/20152) | 21.0% (8324/39704) |
| Api | 85 | 34.0% (1056/3109) | 22.7% (734/3240) |
| Execution | 36 | 47.6% (1004/2110) | 32.6% (962/2948) |
| Configuration | 48 | 48.0% (2084/4344) | 44.3% (1610/3636) |
| Ast | 206 | 55.2% (6394/11590) | 48.6% (4734/9750) |
| Emission | 178 | 58.5% (13983/23923) | 47.6% (13312/27946) |
| Syntax | 70 | 61.8% (9529/15426) | 59.0% (10504/17802) |
| Resolution | 47 | 63.0% (2368/3760) | 49.3% (2252/4564) |
| Projects | 99 | 67.7% (3306/4881) | 71.0% (3812/5368) |
| Checking | 846 | 67.9% (56733/83507) | 54.8% (51494/94032) |
| Programs | 73 | 68.3% (2532/3709) | 57.0% (2826/4956) |
| Mapping | 35 | 70.8% (1386/1957) | 54.3% (740/1364) |
| Binding | 27 | 80.5% (3726/4626) | 74.1% (5136/6928) |
| LanguageServer | 102 | 82.7% (4520/5468) | 64.0% (2194/3430) |
| Incremental | 31 | 82.8% (1679/2027) | 70.0% (1684/2404) |
| Hosts | 21 | 83.7% (1076/1286) | 74.4% (848/1140) |
| Watching | 26 | 90.5% (896/990) | 65.7% (636/968) |
| Text | 13 | 90.6% (2079/2295) | 71.2% (510/716) |
| Diagnostics | 31 | 93.3% (10179/10912) | 64.0% (1034/1616) |
| **合计** | 2429 | **58.6%** (142514/243195) | **47.2%** (115192/243854) |

### 2. 手工变异矩阵

10 个站点各注入一个语义变异，增量构建后先跑逐字节门禁，未红再跑整套 safety。变异串、结果与拦截载体如下。

| 变异 | 维度 | 站点 | 结果 | 拦截载体 |
| --- | --- | --- | --- | --- |
| M1 两段升序不归并 `runs.Count > 1` → `> 2` | 3.1 | `Checking/TypeAlgebra.cs:222` | 红 | safety 7 个旗标（含 `--checker-algebra-safety`） |
| M2 诊断去重判据取反 | 3.1 | `Diagnostics/DiagnosticCollection.cs:17` | 红 | safety 13 个旗标 |
| M3 候选扩展名顺序 Ts/Tsx 互换 | 3.1 | `Resolution/ModuleResolver.Paths.cs:61` | **绿** | 无 |
| M4 WTF-8 代理区间上界 `0xBF` → `0xBE` | 3.2 | `Text/Wtf8.cs:50` | **绿** | 无 |
| M5 行首列号 `indentSize` → `indentSize + 1` | 3.1 | `Emission/EmitTextWriter.cs:32` | 红 | bytecheck：medium 的 65 个 `.js.map` 全部 DIFF |
| M6 映射段 msgpack 数组长度 `? 5 : 6` 取反 | 3.5 | `Protocol/AstEncoder.cs:149` | **绿** | 无 |
| M7 约束求解丢弃联合首成员 | 3.1 | `Checking/TypeConstraints.cs:289` | **绿** | 无 |
| M8 控制流图允许不可达/重复前驱边 | 3.1 | `Binding/Binder.Flow.cs:19` | **绿** | 无 |
| M9 增量失效判定恒 false | 3.1 | `Incremental/IncrementalProgram.AffectedFiles.cs:60` | 红 | safety：`--incremental-safety`、`--native-command-safety` |
| M10 关系缓存命中结果取反 | 3.1 | `Checking/Relations.cs:133` | 红 | bytecheck：6/6 夹具 exit 0→2 且 stdout 差异 |

5 红 5 绿。两条红由逐字节门禁拦住（M5、M10），三条由 safety 拦住（M1、M2、M9）。M10 的拦截形态很粗：变异让所有夹具报错退出，属于「任何输出变化都能拦」的量级，不代表关系结果本身有细粒度断言。

### 3. 发现卡片

**F-001-01 逐字节门禁的 stdout 比对在全部 6 个夹具上恒为空串比较**

维度：3.9　位置：`csharp/tools/perf-verify.mjs:78-95`、`built/csharp/perf-fresh/fixtures/*/tsconfig.json`
现象：6 个夹具的 `run.log` 全部 0 字节，门禁的 `b.stdout !== r.stdout` 分支只能在夹具从零诊断变成有诊断时触发，对诊断文本、顺序、位置的变化零分辨力。
触发：任一诊断排序或消息文本改动。
复现：`wc -c built/csharp/perf-fresh/verify/audit-r01-pre/*/run.log` 全为 0；变异 M2（诊断去重取反）在 bytecheck 全绿。
影响：静默错结果（诊断面）。
量级：门禁诊断面 0 行输入；M2 存活于 bytecheck，仅 safety 拦住。
置信度：[事实]
建议：测。夹具族增加一个错误密集型（`errdense` 已存在），把 5001 行诊断的 stdout 纳入常规门禁。

**F-001-02 逐字节产物面 97% 由单一夹具贡献，两个夹具产物数为 0，四个已存在夹具未入门禁**

维度：3.9　位置：`csharp/tools/perf-verify.mjs:24`
现象：`specs` 只列 6 个夹具，产物分布为 medium 195、huge 2、dtsheavy 2、longline 2、tiny512 0、small3 0。`tiny512` 与 `small3` 的 tsconfig 是 `noEmit: true`，设计上不产生产物。夹具目录下另有 `editbig`、`errdense`、`errdense-clean`、`inc512` 四个夹具不在这份清单里。
触发：声明发射路径的回归（只有 medium 与 dtsheavy 覆盖）；增量编辑轮（无夹具覆盖）。
复现：`node csharp/tools/perf-verify.mjs --label <新标签> --binary csharp/src/TypeScript.CommandLine/bin/Release/net11.0`，看每行 artifacts 计数。
影响：静默错结果。
量级：201 个哈希中 195 个来自 medium；两个 noEmit 夹具合计 0 产物；增量轮 0 夹具。
置信度：[事实]
建议：测。把 `editbig`（增量三轮）与 `errdense` 纳入常规门禁；对 noEmit 夹具至少比对 `--listFiles` 或诊断输出，避免「0 产物即通过」。

**F-001-03 两个永久红旗标提前中止，其后断言从未执行**

维度：3.9　位置：`csharp/tests/TypeScript.Compatibility/ProgramEmissionTests.Safety.cs:83`、`CheckerProgramTests.cs:162`
现象：`--program-emit-safety` 在第 14 条断言失败（该文件共 20 条），其后 7 条不再执行。`--checker-relation-context-safety` 在第 3 条断言求值时 `Single(...)` 找不到元素，抛 `InvalidOperationException`，方法内共 33 条断言，其后 30 条不执行。两者都在 `run-safety-suite.mjs` 的 `baseline` 集合内，因此永久红不影响门禁判定。
触发：直接运行这两个旗标。
复现：`dotnet csharp/tests/TypeScript.Compatibility/bin/Release/net11.0/TypeScript.Compatibility.dll --checker-relation-context-safety`（exit 1）。
影响：可维护性（门禁有效性）。这两个族（program emit、relation context）实际受到的断言保护分别是 13 条与 2 条。
置信度：[事实]
建议：修测试。relation-context 的首个缺陷是测试自身的 LINQ 假设，先定位 `Single` 无匹配的原因；program-emit 的断言 14 需要判定是产品缺陷还是测试期望过时。

**F-001-04 断言计数无下限，静默退化不可检测**

维度：3.9　位置：`csharp/tests/TypeScript.Compatibility/Program.cs`（各 safety 分派臂）、51 个定义 `Safety()` 的测试文件
现象：分派臂把返回的断言数打印到 stdout 后直接 `return 0`，没有与期望值比较；`grep` 全仓没有 `checks >=` 或期望断言数的断言。测试内部若因语料为空、循环上界变 0、分支提前返回而少跑断言，旗标仍然通过。
触发：测试语料收缩或条件分支导致的断言数下降。
复现：`grep -rn "checks >= \|assertions >= " csharp/tests/TypeScript.Compatibility/` 无匹配；对照 r45 把 `CheckerAlgebraTests.Safety` 从 80 条提到 143 条，无任何门禁记录这个数字。
影响：可维护性。
量级：93 个旗标全部适用。
置信度：[事实]
建议：测。给每个 `Safety()` 一个期望下限（可集中在一张表里），分派臂比较并在不足时非零退出。

**F-001-05 AST 编解码门禁不覆盖映射段编码**

维度：3.5　位置：`csharp/tests/TypeScript.Compatibility/AstCodecTests.cs:19-70`、`Protocol/AstEncoder.cs:149`
现象：`--ast-codec-safety` 用单个极小源文件编码，报文里没有 source map 映射段，`MappingFeature` 与段数组长度前缀那段代码一次都没执行。变异 M6 把数组长度前缀的 5/6 取反，整套门禁零反应。
触发：带 `sourceMap` 的二进制 AST 请求（API/LSP 消费方）。
复现：引用上面的变异串，跑 `run-safety-suite.mjs` 与 `perf-verify.mjs`，两者全绿。
影响：静默错结果（协议面）。消费方按长度前缀读段，读到错位数据。
量级：该分支覆盖率 0；变异存活。
置信度：[事实]
建议：测。给 codec 语料加一个 `sourceMap: true` 且含多段映射的源文件，断言解码后 `Segments` 与编码前逐项相等。

**F-001-06 模块解析候选扩展名顺序无任何覆盖**

维度：3.1　位置：`Resolution/ModuleResolver.Paths.cs:55-63`
现象：无扩展名导入按 `[Ts, Tsx, DTs, Js, Jsx]` 顺序探测。6 夹具与 safety 语料里没有同时存在 `a.ts` 与 `a.tsx` 的目录，顺序互换不改变任何结果。变异 M3 整套门禁零反应。
触发：同时存在 `.ts` 与 `.tsx` 同名模块的真实工程。
复现：变异串见上表，跑全套门禁全绿。
影响：静默错结果（加载到错误的模块）。
量级：门禁覆盖 0；变异存活。
置信度：[事实]
建议：测。加一个双候选夹具（`a.ts` 与 `a.tsx` 并存），或直接对 `AddExtensions` 写单元级断言。

**F-001-07 WTF-8 代理区间边界无覆盖**

维度：3.2　位置：`Text/Wtf8.cs:50`
现象：孤立代理的 3 字节序列由 `source[1] is >= 0xA0 and <= 0xBF` 判定后手工拼码点。把上界改成 `0xBE` 后，`U+DFFF` 解码成替换字符。门禁零反应，说明语料里没有孤立代理。
触发：恶意或畸形源码里的 lone surrogate。
复现：变异串见上表，跑全套门禁全绿。
影响：静默错结果（文本转换）。
量级：`Wtf8` 行覆盖在 safety 套件下未知，该分支零覆盖；变异存活。
置信度：[事实]
建议：测。加编码语料族：`ED A0 80` 到 `ED BF BF` 全区间往返、截断序列、BOM 在中间。

**F-001-08 约束求解丢弃联合首成员不被检测**

维度：3.1　位置：`Checking/TypeConstraints.cs:287-302`
现象：联合/交叉类型的约束求解逐成员递归。把循环改成 `Skip(1)` 后，`constraints.Count != composite.Types.Count`，函数返回 `null` 而非聚合后的基约束。门禁零反应。
触发：联合类型参与的泛型约束求解。
复现：变异串见上表，跑全套门禁全绿。
影响：静默错结果（约束放宽或收紧，进而影响诊断与声明输出）。
量级：变异存活；`--checker-constraints-safety` 未拦住。
置信度：[事实]
建议：测。约束语料补「联合首成员需要基约束」的最小例子，断言基约束与参考实现一致。

**F-001-09 控制流图前驱边守卫不被检测**

维度：3.1　位置：`Binding/Binder.Flow.cs:17-23`
现象：`Add` 拒绝不可达与重复前驱。把守卫改成只判 `label is null` 后，流图允许加入不可达与重复边。门禁零反应。
触发：可达性分析与类型收窄。
复现：变异串见上表，跑全套门禁全绿。
影响：静默错结果（收窄结果与诊断）。
量级：变异存活；`Binding` 行覆盖 80.5%，但该守卫的语义分支未被断言。
置信度：[事实]
建议：测。给流图加结构级断言（前驱集合、不可达标记），不要只靠端到端诊断。

**F-001-10 `--syntax-services-safety` 在覆盖率插桩下确定失败，属假红**

维度：3.4　位置：`csharp/tests/TypeScript.Compatibility/ReferenceTests.cs:86-88`
现象：该旗标单独运行 3/3 通过（337 条断言），在 `dotnet-coverage collect` 下单独运行即失败，报「Disposing a cross-project search and session releases its program graph」。断言形式是对 `WeakReference` 做 3 轮 `GC.Collect()` 后判 `!IsAlive`。
触发：任何覆盖率或 profiler 插桩环境。
复现：`dotnet-coverage collect -f cobertura -o x.xml "dotnet csharp/tests/TypeScript.Compatibility/bin/Release/net11.0/TypeScript.Compatibility.dll --syntax-services-safety"`，exit 1。
影响：可维护性。若后续引入覆盖率 CI，此断言必红，且失败原因与产品行为无关。
量级：确定性复现，1 次即中。
置信度：[事实]
建议：修测试。该断言放进非插桩作业，或改成显式弱引用回收循环加超时重试。

**F-001-11 覆盖率的结构性缺口集中在四层**

维度：3.9　位置：见第 1 节表
现象：`Storage` 与 `Experiments` 在 safety 套件下 0 覆盖；`Semantics` 分支 8.8%、`Protocol` 分支 25.6%、`Api` 22.7%、`LanguageServices` 21.0%。这四层的分支覆盖远低于 `Checking` 的 54.8%。
触发：无。
复现：第 1 节表，`dotnet-coverage collect` 加目录聚合脚本。
影响：可维护性。`Semantics` 是可观测的语义基座（Unicode 归一化、正则属性、数字与大小写映射），0 到 8.8% 的分支覆盖意味着这些表的驱动代码几乎没被执行过。
量级：合计 105,000 行未覆盖（Compiler 全量 243,195 行中 100,681 行未覆盖）。
置信度：[事实]
建议：测。`Experiments` 若是实验岛可归档；`Storage` 与 `Semantics` 需要定向语料。

### 4. 断言强度分级

抽查 10 个旗标，判据是「跑通即通过」还是「钉死具体契约」。变异证据列指本轮矩阵里的对应项。

| 旗标 | 断言形态 | 等级 | 证据 |
| --- | --- | --- | --- |
| `--module-specifiers-safety` | 精确串等价、路径映射枚举、取消令牌逐查询 | 强契约 | 读码 |
| `--program-emit-safety` | 字节等价、文件计数 8、sourceMap 计数 4、取消语义、外来语法拒绝 | 强契约（残缺） | 14/20 后中止 |
| `--checker-relation-context-safety` | 诊断参数序列、RelatedInformation 代码 | 强契约（残缺） | 3/33 处异常中止 |
| `--ast-codec-safety` | 畸形报文拒绝矩阵（12 种变异）+ 父子关系 + 文档缓存 | 强契约（范围偏） | M6 存活 |
| `--checker-algebra-safety` | 153 条，归并序列逐项等价，含变异验证 | 强契约 | M1 被拦 |
| `--build-info-safety` | 签名往返、字段钉死 | 强契约 | 读码 |
| `--incremental-safety` | 失效判定与重用语义 | 强契约 | M9 被拦 |
| `--syntax-services-safety` | 337 条，含引用/实现遍历与释放语义 | 强契约（一处环境脆弱） | 插桩下假红 |
| `--checker-constraints-safety` | 存在 | 覆盖不足 | M7 存活 |
| `--checker-program-safety` | 存在 | 实际不设门（永久红） | 基线集合 |

### 5. 补测优先级

判据是「变异存活 × 生产暴露面」。

1. 约束求解的联合首成员（M7）。泛型约束是所有 strict 工程的必经路径，safety 族已有专门旗标却未覆盖。
2. 控制流图前驱边（M8）。收窄结果直接决定诊断正确性，且 `Binding` 层的高行覆盖掩盖了语义分支的空洞。
3. 模块解析候选扩展名顺序（M3）。决定加载哪个文件，错了不报错。
4. AST 编解码映射段（M6）。二进制 AST 是 API/LSP 的协议面。
5. WTF-8 代理区间（M4）。恶意输入面，与下轮恶意输入审计同源。
6. 夹具面扩容（F-001-01、F-001-02）。增量轮与诊断密集轮进常规门禁。
7. 断言计数下限与两个中断旗标（F-001-03、F-001-04）。

### 6. 下轮候选（按证据强度乘影响面排序）

1. 恶意输入抗性（维度 3.2）。本仓唯一完全没有设施的维度，本轮 M4 存活已证明编码边界是空地；静态守卫矩阵（`StackGuard` 14 处、`MaxDepth` 13 处、`RecursionLimit` 6 处、`checked(` 86 处）可一次读完。
2. 并发与资源生命周期（维度 3.3、3.4）。本轮发现释放语义的断言依赖 GC 时序，说明该面测试脆弱；四个并行相位加三种长驻形态，且 `--incremental-safety` 之外没有跨代际失效的结构级断言。
3. 架构与契约（维度 3.6、3.5）。覆盖率显示 `Storage` 与 `Experiments` 零覆盖，先判定它们是死代码还是未测代码，这直接决定后续审计的减法空间。

### 7. 计划对照

| 专项要求 | 状态 | 说明 |
| --- | --- | --- |
| 覆盖率基线（按目录行/分支） | done | 23 个目录，见第 1 节 |
| 手工变异矩阵（10 站点） | done | 10/10 全部产出结果，无编译失败，无锚点失配 |
| 结果分类（红/没红/编译失败） | done | 5 红 5 绿，无编译失败 |
| 断言强度抽查（10 旗标） | done | 见第 4 节 |
| 只读边界（变异回退、git 干净） | done | BYTECHECK-OK，`git status` 无产品改动 |

### 8. 口径与局限

- 覆盖率只含 safety 套件路径。6 夹具 CLI 运行没有插桩，`Programs`、`Emission` 的实际覆盖高于表中数字。要合并口径需在 `dotnet-coverage` 下再跑一遍 `perf-verify`。
- 变异存活只说明「该变化不被现有门禁检测」，不等于「该变化一定产生错误输出」。M7、M8 的语义错误需要具体输入才可观察，本轮未构造。
- 单机单次运行。safety 套件的环境敏感项只有 `--npm-process-safety`（既有基线项），本轮所有变异跑里失败集合稳定。
