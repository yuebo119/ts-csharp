# r06 实施报告：单文件分段打印、变换过关与双变换并发

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-08 ｜ 轮次: r06 ｜ 主题: segmented-print-and-transform-parallelism
> 涉及 git 节点: `1fb3d194f6`（r05c 基线）/ `3938435bc6`、`608e689093`、`142bb2a497`、`2b2399167e`（本轮）
> 数据来源: `bench/AB54`、`AB56`、`AB57`（vs r05c）、`AB55`（vs Go 出厂默认）；工作区 `C:\ai\projects\tsbench`
> 关联方案: `docs/csharp-perf-plan-r06.md`

---

## 1. 结论

| 指标（巨文件，AOT 产品形态） | r05c | **r06** | 变化 |
| --- | ---: | ---: | ---: |
| Emit | 0.607 s | **0.27 s** | **−55%** |
| Check | 0.319 s | 0.34 s | ≈0（诊断口径含探针开销） |
| Parse / Bind | 0.065 / 0.054 s | 0.066 / 0.054 s | 持平 |
| **Total** | **1.163 s** | **0.88 s** | **−24%** |
| CLR 分配 | 513.4 MB | 479.7 MB | −6.6% |

配对 A/B（`AB57`，15 组交替，噪声 23.4%）：

| 负载 | r05c | r06 | 比值 | 95% CI |
| --- | ---: | ---: | ---: | --- |
| **huge-file** | 1161 ms | **882 ms** | **x0.760** | [0.751, 0.764] |
| medium-checkers-1 | 274 | 255 | x0.933 | [0.907, 0.960] |
| medium-checkers-2 | 214 | 201 | x0.943 | [0.925, 0.964] |
| medium-checkers-4 | 182 | 174 | x0.951 | [0.911, 0.984] |
| 其余 19 项 | | | 平均 x0.995 | 仅 1 项显著变慢：tiny-files-noemit x1.013 [1.004, 1.030] |

全部 23 项平均 x0.982，13 项改善，4 项显著改善，1 项显著变差（+1.3%，noemit 负载）。

与 Go 出厂默认对照（`AB55`，15 组交替）：

| 负载 | Go 默认 | C# r06 | 比值 | r05c 时 |
| --- | ---: | ---: | ---: | ---: |
| **huge-file** | 428 ms | 974 ms | **x2.28** | x3.36 |
| medium-checkers-1 | 119 | 271 | x2.28 | x2.56 |
| medium | 103 | 182 | x1.77 | x1.93 |
| declarations | 95 | 161 | x1.70 | — |
| tiny-files | 278 | 366 | x1.32 | x1.30 |
| help / version / empty-project | 53 / 51 / 52 | 60 / 59 / 64 | x1.14 / x1.16 / x1.23 | 持平 |

内存：重负载 12/23 低于 Go（medium 族 x0.90~0.92、tiny-files x0.96），巨文件 x1.24。

---

## 2. 落地内容（四个提交）

### 2.1 分段并行打印（`3938435bc6`）

单文件无法利用文件级并行，其打印此前全串行。现在把顶层语句按数量均分成至多 4 段（打印器上限 8，`TSHARP_EMIT_SEGMENTS` 可覆盖），每段独立 `SyntaxPrinter` + `EmitTextWriter`，最后按段序拼接。

- **资格条件（每条都是"跨段必须共享"的行为）**：无 sourceMap / 无显示用位置表、源文件无 `//` 或 `/*`（注释定位与注释驱动的 ASI 保护都跨语句带状态）、无合成注释、无生成名、无 emit helper（helper 文本工厂会在打印期间产生名字，因此在头部打印后再复核一次）。其余一律按原路径串行打印。
- 每段仍以文件根节点 `BeginNode` 开场，使该段看到与串行相同的容器/注释状态。
- `InitializeNames` 的标识符集合改为**惰性构建**（它只为"生成名不与声明名冲突"而存在，变换未产生名字的文件不再付这次全树遍历）。
- 效果（巨文件，CoreCLR 同二进制 A/B）：print 0.85 → **0.34 s**，emit 1.48 → 1.08 s；AOT 上 emit 0.607 → 0.274 s。

### 2.2 变换过关：按触发器跳过整趟遍历（`142bb2a497`、`608e689093`）

`--extendedDiagnostics` 新增逐变换器计时（`xform:*`）。巨文件上的实测：

| 变换器 | 耗时 | 该文件是否可能命中 | 处置 |
| --- | ---: | --- | --- |
| ClassFields | 0.147 s | 无 class | **跳过** |
| TypeEraser | 0.141 s | 有类型注解 | 保留（真实工作） |
| RuntimeSyntax | 0.084 s | 无 TS 专用修饰符/枚举/命名空间/`import =` | **跳过** |
| Module | 0.081 s | ESM 输出且无 import/export 声明 | 保留（`export {}` 判定与 helper 导入依赖文件内容，未敢跳过） |
| ConstEnum | 0.074 s | 无属性/元素访问 | **跳过** |
| ImportElision | 0.052 s | 无 import/export/JSX/`export =` | 保留遍历，但**跳过 checker 侧链接标记**（0.050 → 0.003 s） |
| Using | 0.042 s | 无 `using` | **跳过** |
| EsDecorators | 0.025 s | 无装饰器 | **跳过** |

新增 `SourceFeatures`（一趟扫描，按需要提前退出）承载判定；判定条件取自各变换器唯一的触发语法，因此"跳过"与"遍历后原样返回"等价。
JS 变换 0.98 → 0.66 s，emit 1.08 → 0.85 s。

### 2.3 双变换并发（`2b2399167e`）

两遍此前只共享 checker，管道已让"JS 打印 ∥ 声明变换"重叠。进一步观察：**JS 变换本身只有在被门控掉的那几趟里才调用 checker**（import/export 与 JSX 用于链接标记；enum/namespace/class/decorator/access 用于其余变换）。当这些语法都不存在且模块格式属于 ESM 系（`EsModuleTransformer` 不持有 checker，CommonJS 分支才持有）时，声明变换提前启动并与 JS 变换并发。

- 线程安全边界：声明变换全程独占 checker；两遍各自持有 EmitContext 与打印器；`EmitModuleFormat` 在主线程预热后再并发只读。
- 小文件（顶层语句 < 512）不启用：线程交接的成本大于并行收益（`host-paths` 曾因此 +5.0%，加门槛后回到 x1.012）。
- 效果：emit 0.85 → 0.70 s（AOT 上并入 §1 的 0.27 s）。

### 2.4 诊断增强

- `Transform time (summed)` / `Print time (summed)`：管道让"Alloc transform/print"双计重叠区间，时间口径补上了这一缺口，也把变换暴露为并行化打印后的新临界路径。
- 逐变换器计时（`xform:*`）与检查阶段方法级分配帧（`Probe alloc *`，16 帧）。
- 探针改用 `GC.GetAllocatedBytesForCurrentThread()`：既比进程级计数器便宜（诊断模式下 check 1.46 → 1.19 s），在多 checker 并行时归因也更准。

---

## 3. 检查阶段的当前构成（下一步依据）

`--extendedDiagnostics` 的探针帧（巨文件，CoreCLR 诊断构建，包含式）：

| 帧 | 分配 | 占比 | 当时墙钟（临时 `check:` 计时） |
| --- | ---: | ---: | ---: |
| objectLiteral | 100.4 MB | 55% | 0.56 s |
| └ objectProperty（属性循环） | 69.2 MB | 38% | — |
| relation | — | — | 0.27 s |
| symbolTypes | 28.2 MB | 15% | 0.26 s |
| membersTable | 17.5 MB | 10% | 0.12 s |
| resolveMembers / setMembers | 11.9 / 11.7 MB | 13% | 0.07 / 0.03 s |
| LinkStore 创建 | 180,339 个 | — | — |

（`check:` 临时计时作用域在测量后已移除：`Measure` 每次调用写两个 `ConcurrentDictionary` 并分配闭包，在 25 万次调用量级上会给检查阶段加 ~10%，不适合常驻。）

---

## 4. 验证

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（产品形态 AOT，28.4 MB） |
| 逐字节一致 | `AB54/AB56/AB57` 全部批次、23 负载 × 15 对；另加 16 个语句形态夹具（函数、类、块、无分号 ASI、序言指令、shebang、空行、模板字面量、字符串里的注释标记、装饰器类、`using`、同文件与跨文件 const enum、私有字段）× JS/声明/仅声明/无声明/sourceMap/declarationMap 组合，全部与 r05c 未改动 AOT 产物逐字节一致 |
| safety 套件 | 本轮实跑 20 个相关套件，19 通过；`program-emit-safety` 在未改动基线上同样失败（`Program emit assertion 14`） |
| 测量口径 | 噪声 23~29%（本机同时有 Roslyn 语言服务索引），所有结论取自同批次交替配对；绝对值跨批次不可比 |

---

## 5. 未实施与下一步

| 项 | 现状 | 依据 |
| --- | --- | --- |
| 检查阶段对象字面量管线 | 未改 | §3：属性循环 4.2 KB/字面量，`objectProperty` 占检查分配 38%；先做属性符号/链接与 `DeclarationList` 的按需分配更划算 |
| 声明变换重建消除 | 未改 | 声明侧仍占 emit 的约一半（0.13 s AOT 量级）与 `Part[]` 30 MB |
| Module / TypeEraser 遍历 | 未改 | 合计 0.22 s（CoreCLR）≈ 0.09 s AOT；Module 的跳过条件依赖 `export {}` 与 helper 导入语义，风险高于当前收益 |
| `Part` 容器瘦身（P3） | 未改 | `Part[]` 62 MB；打印已在并行，收益主要是分配与 RSS |
| 启动地板 | 未改 | `--version` 整进程 ~59 ms，93% 在 Main 前 |
