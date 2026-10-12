# r32 报告：全链路重审后的极致优化实施（2026-10-12）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-12 ｜ 轮次: r32 ｜ 主题: fresh-audit-extreme-optimization 实施
> 触发: 用户指令「不考虑以前的决策和分析，不考虑缓存，完全重新读取所有代码文件，整体综合分析，给出最优的极致性能优化方案」并按该方案完整实施
> 计划: `docs/csharp-perf-plan-r32.md` ｜ 基线: 实施前 HEAD 构建（JIT，`bin/Release/net11.0`，备份于 TEMP）
> 产品改动: 9 个提交（计划之后），全部经 25 夹具逐字节门禁与 95 flags safety 套件验证

## 1. 结论摘要

真实工程夹具（`packages/typescript`，291 文件/107,391 行，tsconfig 自身口径，3 组）：

| 指标 | 实施前 | 实施后 | 变化 |
| --- | --- | --- | --- |
| CLR 总分配 | 480.5 MB | 372.8 MB | **−107.7 MB（−22.4%）** |
| 总墙钟 | 2.00 s | 1.78 s | **−11.0%** |
| GC 停顿 | 0.269 s | 0.265 s | 持平 |

medium 夹具（67 文件/8,140 行）：CLR 分配 79.51 → 79.08 MB（−0.5%）；huge-file（1 文件/16,384 行）：分配 −0.9%，墙钟 4 对交错中位 −1.2%。

分配下降几乎全部来自 emit 打印路径（P0）与文件系统/写盘边界（S2/S3）；解析与检查侧的结构性卫生项（C1/C2/C3/M2/M3）合计再贡献 −2.0%。

## 2. 实施逐项

### P0（emit 热路径，提交 ef67310072 + 55f1d6484c）

| 项 | 改动 | 验证 | 数据 |
| --- | --- | --- | --- |
| E1 | `EmitTextWriter.RawWrite` 仅在 source map 激活时做逐码点换行扫描（`TrackLineStarts`），否则 O(1) 末码点判定（含 U+2028/2029 精确判定）；map 路径加 ASCII 快路径 | 25 夹具逐字节 | print 汇总分配 −37.9% |
| E3 | `Utf16Length` ASCII 段一次向量化扫描代替逐码点解码 | 25 夹具逐字节 | 仅 map 路径付费 |
| E4 | 注释路径改实例级 scratch 列表 + 原地压实 + span 重载（`Comments(ReadOnlySpan<SourceCommentRange>)`），`CommentRanges` 静态入口保留给语言服务调用方；`BlockBody`/`HasHelperText` 手写循环 | 25 夹具逐字节 | 无 map 时每 token 注释过滤零分配 |
| E2 | **回退不实施** | — | 见 §3 |

### P1（checker/parser 分配卫生，提交 f033c23458 + fca67d1db5）

| 项 | 改动 | 验证 | 数据 |
| --- | --- | --- | --- |
| C1 | `TypeCacheKey` 六值内联（构建期栈缓冲，>6 回落数组），联合/引用/实例化缓存探测不再每次分配 long[] | 25 夹具逐字节 | 夹具上约零（Types 4183/Instantiations 16，缓存流量本就极低）；结构性卫生 |
| C2 | `ApparentAsync` 等 4 处 `Utf8String.Copy("String")` 家族改 `Utf8Literals` 缓存静态量；补 ArrayIterator/MapIterator/SetIterator/StringIterator/ClassName/HtmlFor 六个字面量 | 25 夹具逐字节 | 约零（热路径但每次仅 6 字节） |
| C3 | `NewSignature` 空类型参数列表复用共享空 `ReadOnlyCollection` 包装 | 25 夹具逐字节 | 每条空类型参数签名省 32B |
| M2 | `EnvironmentScope`（含三个 List）入有界池（64），End/Restore 时归还 | 25 夹具逐字节 | 与 M3/M4 合计 −4.9 MB |
| M3 | 41 处 `Peek(() => ...)` 中 40 处改 `Func<Parser,bool>` 重载 + static lambda（缓存委托，无 display class）；1 处写回型保留闭包 | 25 夹具逐字节 | 同上 |
| M4 | `CheckerDiagnostic.CreateOwned` 免参数数组拷贝——**当日回退** | — | 见 §3 |
| M1 | **放弃** | — | 见 §3 |

### P2（边界与调度，提交 44a2b834d7 + 4964b58e40）

| 项 | 改动 | 验证 | 数据 |
| --- | --- | --- | --- |
| S2 | `Wtf8.DecodeString` ASCII 快路径（一次向量化有效性检查 + 单遍转换）；已查证 .NET 11 RC1 无 span 版 `File.Exists`/`Directory.Exists`（反射实测），路径字符串分配不可省 | 25 夹具逐字节 | 与 S3 合计 −7.8 MB |
| S3 | `Utf8StringBuilder.DetachText()` 以视图转交写出缓冲（emit writer 取走文件文本后不再追加），每文件省一次全量拷贝 | 25 夹具逐字节 | 同上（输出树 10.3 MB） |
| S1 | `TSHARP_PARSE_CONCURRENCY` 环境变量暴露 parse+bind 槽位上限，默认保持 4 | 不涉及产物 | A/B 见 §3 |
| S4 | **推迟** | — | 见 §3 |

### P3（提交 660f088f3a）

| 项 | 改动 | 验证 | 数据 |
| --- | --- | --- | --- |
| P3-2 | JSDoc tag 检测单遍化：一次 `@` 位置遍历同时判定 deprecated 与 see/link 族，双 flag 齐备早退（原为每 tag 名一次全注释扫描，最多 5 遍） | 25 夹具逐字节 | .d.ts/库源码路径收益，未单列 |
| P3-1 | **推迟**（0/113） | — | 见 §3 |
| P3-3 | **不实施** | — | 见 §3 |

## 3. 放弃、推迟与回退项（均带数据）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| E2 braceMap gate on sourceMap | **回退** | 前提被证伪：braceMap 位置数学不只服务 MapPosition，还喂 `state.Cursor`（Code() 末尾 `state.Cursor = end`），决定下一次注释扫描起点。gate 后带注释文件发射字节改变（medium 复现实测：token 间多空格）。MapPosition 本身在无 map 时已 no-op，原实现无浪费 |
| M1 NodeList 单分配 | **放弃** | 所有权分析证伪：池化 List 的缓冲会被下一个列表复用，`ToArray()` 是 AST 长期属主所必需；包装器随 AST 永生无法归还。双分配是该设计的下限 |
| M4 诊断参数免拷贝 | **当日回退** | `checker-program-safety` 钉死契约：调用方可能在 Create 之后修改传入数组（测试逐字验证）。违反契约的优化不给过 |
| S4 诊断分组一次成型 | **推迟** | 目标负载（错误/include 密集型诊断）不在测量语料中（夹具全 clean，IncludeDiagnostics 近空），O(文件×诊断) 无对象可测；诊断管线对输出顺序敏感，不落地不可测项。待错误密集型夹具 |
| P3-1 顶层 await span 级重解析 | **推迟** | 前置统计：真实工程 113 个非声明文件中顶层 await 为 **0**。无语料覆盖则收益不可测，且重解析语句拼接微妙（扫描器重定位/JSDoc/错误恢复）。计划自带闸门「占比低则降级」命中 |
| P3-3 扫描器微结构 | **不实施** | ledger 表2 已定界（解析占墙钟 8.3%，扫描器内部 10% 优化 <0.9% < 噪声下限 1.1%），本场独立复算一致（parse 0.229s/3.33s=6.9%）。其中 per-token 取消检查约 1ms（低于噪声两个数量级）且移除会降低 Ctrl-C 粒度（语句级无现存检查） |
| S1 改默认并发 4→8 | **不改** | 10 对交错：8 槽 7/10 对占优、中位 −1.6% 墙钟，但 summed parse CPU +45%（builder 共享字典争用），tiny-files 无差异（−0.6% 噪声带内）。信号处于批次分辨率（±1.5%）边缘，按纪律保持默认，旋钮保留供后续 A/B |

## 4. 过程教训（当晚实测）

1. **产物新鲜度再次咬人**：快速连续增量构建后 bytecheck 出现「Heisenbug」（同一份代码加打印后行为改变）。根因是 MSBuild 增量构建在时间戳打平时跳过重编，bytecheck 跑了旧二进制。最终所有判定基于 `--no-incremental` 重建。教训与 AGENTS.md「目录里已有产物 ≠ 本次命令产出」一致，本轮为此多花约 40 分钟。
2. **ugrep -o 在 CRLF 文件上会把 `\r` 带进匹配**：导致 safety 脚本里 flag 尾部带 `\r`，程序落入 usage 分支 exit 1，一度误报 94/95 失败。修正为 `tr -d '"\r'` 后 91/95（4 失败全在已知基线集合）。
3. **M4 的契约违反被 safety 套件当场抓住**——正向夹具存在的价值再次验证（与 r08 const-type-parameter 门禁教训同族）。

## 5. 门禁状态（终态）

门禁脚本（`built/` 为 gitignored 目录，沿用 epsl-a1-bytecheck.mjs 惯例；如遗失按本报告口径重建）：`built/r32-bytecheck.mjs`（5 夹具 before/after）、`built/r32-bytecheck-full.mjs`（25 夹具 + latestChangedDtsFile 归一化）、`built/r32-determinism.mjs`（before 二进制自确定性探针）。

| 门禁 | 结果 |
| --- | --- |
| Release 构建 0 警告 0 错误（含 analyzer 段） | 绿（每次提交前 --no-incremental 重建） |
| 逐字节 25 夹具（seg/staged/huge-file/real-project，退出码+stdout+全树哈希） | **25/25**；real-project 的 tsbuildinfo 曾仅 `latestChangedDtsFile` 不同（并行 emit 完成顺序的计时字段，冷跑下两侧一致），门禁脚本已对该字段归一化并输出 NOTE || safety 95 flags | **91/95**，4 失败（checker-relation-context / program-emit / developer / lsp-native-watch）全部属于 r22 以来已知基线集合；npm-process 本轮通过（环境波动项） |
| 分配 | 真实工程 −22.4%（确定性，3 组带宽 <0.1 MB） |
| 墙钟 | 真实工程 −11.0%（3 组）；huge-file 4 对交错 −1.2%；medium 无差异 |

## 6. 与预算契约的关系（perf-budgets.md §2）

- 真实工程 CLR 总分配预算 ≤820 MB：现 372.8 MB（r28 锚点 811.5 MB 起算，累计 −54%）。
- 分配相对 Go ≤x5.5：本项未重测 Go 侧，r28 口径 x5.2 起算，分配下降应同向改善；三方对比表刷新留待下一节点（本report不改表）。
- 重负载墙钟平均对 Go ≤x1.50、medium-checkers-1 ≤x2.20：未重测 Go 侧，−11% 墙钟应同向改善，留待 AB 批次刷新。

## 7. 下一步建议

1. 跑一轮对 Go 的 AB 批次（含本终态），刷新三方对比表与 §6 两个墙钟预算行。
2. S4（诊断分组）与 P3-1（span 级重解析）各需要一个针对性夹具（错误密集型工程 / 含顶层 await 的模块）才能验证，建议随语料扩展启动。
3. S1 的争用根因（builder 共享字典）若在未来的大项目负载中成为墙钟瓶颈，先修争用再重估 8 槽默认。
