# 全量重读轮（fresh audit，2026-10-14/15）

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-14/15 |
| 性质 | 独立会话：全量重读 + 审计 + 实施 + 判定（非 r 系列轮次，不触碰对 Go 锚） |
| 锚点 | 入库量具 `csharp/tools/perf-{fixtures,verify,measure}.mjs`；提交 f14ff4b、4eca9f8、f4fd9a3、9bc8966、a568797、9d87a02 |
| 形态 | 本检出 Release（JIT，framework-dependent，net11.0；SDK 11.0.100-rc.1），32 核工作站 |

## 结论摘要

1. 检查相位是三个代表性负载的主导成本（占分阶段时间 65~90%，分配为 parse+bind 合计的 3~7 倍）；其内部由关系引擎驱动（medium 下 relationCompare 子树 inclusive 占 check 分配 89%），但关系机器自身很省，钱花在它调度的成员表解析与类型构造上。
2. 逐节点机制经微基准证实便宜：`TryEnsureSufficientExecutionStack` 0.6~1.2 ns/次、两级 async ValueTask 链 7.6~13.7 ns/次（runtime-async 已拿走经典异步税）。"同步化重写"方向可以关闭。
3. 多 checker 隔离的重复推导真实存在（check CPU c8/c1 = +27~108%、类型对象 +4~31%），但进程分配代价温和（+2~11%），墙钟在 c8 与 c2/c4 间仅 ±4%（配对复测）。默认 8 检查器成立。
4. 落地 3 项代码变更（增量 buildinfo 空转跳过、类型节点解析消冗余容器、打印器列号增量维护），全部过逐字节门禁；另有 6 项候选被判定实验证伪（数据留档于 `.ai/perf-ledger.md`）。
5. 打印器列号修复是唯一"形态敏感"的大额收益：单行 65 万字节 + sourceMap 的负载上 emit summed −50%、总墙钟 −27%；常规形态低于噪声。

## 已实施（均已过 6 夹具逐字节产物门禁 + Release 0/0）

| 项 | 落点 | 数据 |
| --- | --- | --- |
| 无变更轮次跳过 buildinfo 构建与序列化 | `IncrementalProgram.{Emit,BuildInfo}.cs`（f14ff4b、9bc8966） | 空转轮确定性分配 inc512 50.44→49.6 MB、medium 41.25→41.05 MB；medium 空转墙钟 0.639→0.623 s（三连跑不重叠） |
| 类型节点解析消冗余容器与 LINQ | `TypeNodes`/`TypeReferences`/`TypeParameterScopes`/`TypeContext`/`Types`（4eca9f8） | check 分配 medium −0.7~1.8%、dtsheavy −1.5~2.7%；Types 计数不变 |
| 打印器列号增量维护 | `EmitTextWriter`/`SyntaxPrinter`（f4fd9a3） | longline：emit summed 2.60→1.29 s（−50%）、总墙钟中位 5.43→3.96 s（−27%）；medium/huge 噪声内 |
| safety 套件默认 harness 路径修复 | `csharp/tools/run-safety-suite.mjs`（a568797） | 不传参直跑 90/93、失败集合等于文档基线 |
| 验证设施入库 | `csharp/tools/perf-fixtures.mjs`、`perf-verify.mjs`、`perf-measure.mjs`（9d87a02） | `perf-verify pre/post` 端到端 BYTECHECK-OK（6 夹具） |

## 实测数据

夹具相位构成（summed 为跨线程累计，受并行重叠影响；墙钟为实测）：

| 夹具 | 文件/行 | 墙钟 | parse | bind | check | emit | 分配 p/b/c/e (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| medium（emit+声明+map+增量） | 95 / 66,373 | 2.5~2.9 s | 0.39 | 0.29 | 3.8~4.4 | 1.3~1.6 | 47/56/679~689/240~251 |
| huge（单文件，emit） | 31 / 151,622 | 5.3~6.3 s | 0.47 | 0.41 | 7.1 | 0.95 | 54/51/703/114 |
| tiny512 | 542 / 3k | 2.9 s | 0.43 | 0.66 | 3.8 | - | 30/76/342/- |
| dtsheavy | 182 / 8k | 2.4~2.8 s | - | - | 2.5 | - | -/-/328/- |
| errdense（5,000 诊断） | 200 / 5k | 2.33~2.47 s | - | - | 3.35 | - | -/-/-/- |

主线程时间线（medium，`--generateTrace` 实测）：createProgram 322 ms → computeIncrementalChanges 71 ms → 检查相位（并行，主线程等待）约 1.78 s → emit 234 ms → 输出/收尾。createProgram 中默认 lib 层（lib.es2017.full 链，30 文件）占约 150 ms；模块解析密度不影响该值（64 文件 × 20 import 与 × 2 import 的 Program time 相同）。

checker 数判定批（每格 3 次中位；墙钟配对复测见账本）：

| 夹具 | 墙钟 c1/c2/c4/c8 (ms) | check CPU c1→c8 | 进程分配 c1→c8 | Types c1→c8 |
| --- | --- | --- | --- | --- |
| medium | 3235 / 3277 / 2658 / 2897 | +108% | +11% | +31% |
| dtsheavy | 2656 / 2334 / 2450 / 2835 | +46% | +5.5% | +16% |
| tiny512 | 2871 / 2539 / 2655 / 2879 | +49% | +6.2% | +16% |
| inc512 | 3361 / 3126 / 2855 / 2752 | +27% | +5.2% | +16% |
| huge | 6345 / 5714 / 5385 / 5741 | +27% | +2.1% | +3.7% |

微基准（与产品同构建属性）：栈守卫 0.6~1.2 ns/次；两级 async 链 7.6~13.7 ns/次（20M 次中位）。

## 证伪清单（数据留档，勿重提案）

| 项 | 证伪数据 |
| --- | --- |
| 「多 checker 分配 ×3.3」 | `Alloc X (summed)` 并行重叠计数假象；进程总量口径 +2~11% |
| 自适应下调 checker 数 | small3 默认 8 检查器 2.77 s vs `--checkers 1` 3.07 s（下调更慢） |
| checker 数下调（扫描读数） | 未配对 3 次中位显示 c4/c2 胜 c8，配对 5 对复测推翻：medium c8 快 4.7%，其余 ±4% 内 |
| `S()`/`Scoped()` 元数特化 | `parts.ToArray()` 即容器唯一必要分配 |
| 增量轮文件 stat/哈希复用 | 哈希对内存文本做，无重复读盘 |
| 配方 token 缓存 / 快照惰性拷贝 | 量级不足（~60 KB/轮 @512 文件） |
| 巨文件打印工作栈容量预置 | 峰值栈深 huge 65,575 parts（≈4 MB 链），占打印分配 ~5% |
| 诊断分组一次成型 | errdense 5,000 诊断：分配 +25%、check CPU +25%、墙钟无可测差异 |

## 门禁状态（全部本轮实测）

- 构建：`dotnet build TypeScript.slnx -c Release` 0 警告 0 错误（含 analyzer 与 AOT 验证）。
- 逐字节：6 夹具（medium/huge/tiny512/dtsheavy/small3/longline）改动前二进制 vs 当前构建，退出码、stdout、发射文件哈希全等（含 .map）；`perf-verify` 可复现。
- safety 套件：90/93，失败集合 = 文档基线三项（`--checker-relation-context-safety`、`--program-emit-safety`、`--npm-process-safety`），content-mappers 通过。
- 未执行：官方 25 夹具 bytecheck、对 Go 配对、AOT 产品形态（锚包与官方夹具不在本检出）。

## 口径注记

- 全部数字为 JIT 形态（本检出 Release 构建），相对归因有效，绝对墙钟不与 AOT 批次直接可比；对 Go 锚维持 r34/r35 带（x1.398~1.423），未重测。
- 自建夹具与官方 harness 同构但非逐字节同源；未设 `skipLibCheck`（默认 lib 参与检查），官方夹具口径可能不同。
- 量具自纠三例已修正后重测：目录计数器跨调用复用（残留 tsbuildinfo 变空转）、并行相位 summed 分配重叠计数、未配对中位漂移 ~±10%。
- 本轮的原始日志与一次性脚本在 `csharp/built/fresh-2026-10-14/`（gitignored）；入库脚本见 `csharp/tools/perf-*.mjs`。
