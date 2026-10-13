# r33 报告：反超 campaign——结构性杠杆全测（2026-10-13）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-13 ｜ 轮次: r33 ｜ 主题: surpass-go-campaign
> 触发: 用户指令「要做反超，极限优化，把所有可能都实践」
> 上游: `docs/csharp-perf-report-r32.md`（实施轮）、`docs/csharp-perf-report-r32-comparison.md`（重负载 x1.397）
> 产品改动: 无（两个当日回退：no-GC region 与其插桩；旋钮 TSHARP_PARSE_CONCURRENCY 上轮已落）

## 1. 结论

对「反超 Go」的四个结构性杠杆逐一实测，**全部无收益**，其中两个推翻了战役既有前提。剩余差距是纯每操作 CPU 常数，本报告记录了每个杠杆的实测数据与关账理由。已落地的 r32 一轮（分配 −22.4%、重负载比值 x1.428→x1.397）仍是唯一有效的推进。

## 2. 实验记录

### 实验 1：no-GC region（`GC.TryStartNoGCRegion`）——产品配置下证伪，当日回退

动机：r26 以来「GC 停顿占墙钟 10~20%」是战役内反复引用的前提，若成立，给一次性编译包一个 no-GC 区域可把停顿归零。

过程与数据：
- 探针（Server GC 同款配置）：`TryStartNoGCRegion(512MB)` 成功，区域内 400MB 分配停顿 0ms；8 线程并发 477MB 停顿 3.2ms；区域耗尽不抛异常（运行时自动结束区域退回普通 GC），`EndNoGCRegion` 重复调用才抛。
- 落入 CLI 入口（Program.cs，watch/api/lsp 除外），JIT 构建 + 工作站 GC 环境实测：真实工程停顿 190→1.8ms、墙钟 −12.1%；medium −3.0%、huge-file −12.1%；字节 5/5 一致。
- **产品配置（AOT + 烤制 Server GC）下证伪**：同样负载无区域时停顿就是 **0.0ms、全程仅 1 次 gen0**（Server GC 的 gen0 预算足够大，374MB 分配不触发第二次 collection）；A/B 配对 596 vs 579ms（噪声内）；而 1GiB 预留给 `--version` 稳定 +20ms（10 对交错，中位 93.5→113.5ms）。提交 d9591a82ee，当日以 7f25797a5b 回退。

**前提修正**：原 10~20% 停顿测自 method.md §6 的工作站 GC 测量环境（`DOTNET_gcServer=0` 强制 24 次 gen0、~190ms 停顿），不是产品行为。已同步修正 perf-budgets §4.1 与 ledger 表2。教训：跨环境搬运 GC 结论失真；墙钟对比必须用产品配置。

### 实验 2/4：gen0 预算 pin 与 GCLatencyMode——moot

产品配置下 GC 不触发（见实验 1），预算 pin 与延迟模式没有作用对象，未投入实测。csproj 注释里「4MiB pin 拖慢短命负载 3~8%」是旧环境结论，同样不再适用。

### 实验 3：R2R 自包含（动态 PGO + 分层编译）替代 NativeAOT——否决

动机：NativeAOT 拿不到动态 PGO 的守卫去虚拟化与条件逃逸分析；R2R 能拿到，且检查器是接口密集代码。

实测（同源、同烤制 GC 配置、均带区域插桩前的干净源码、AB120 夹具、3 对）：medium AOT 237ms vs R2R 454ms；huge-file AOT 640ms vs R2R 1664ms。**R2R 慢 2~2.6 倍**：AOT 的全优化码生成胜过 PGO 稳态收益，短命进程的 JIT Warmup 成本压倒性。NativeAOT 形态保持。（附带发现：AOT 与 JIT 构建在重负载上墙钟接近，AOT 优势集中在启动。）

### 实验 4：parse/bind 槽位默认 4→8——产品配置下反向，默认 4 确认

动机：r32 轮在 JIT+工作站 GC 下测得 8 槽中位 −1.6% 墙钟（但 summed CPU +45%）。产品配置下重量（AOT、真实工程、5 对交错）：**c4 中位 616ms vs c8 650ms（−5.2%）**——builder 共享字典争用超过并行收益，默认 4 正确；此前的 −1.6% 同属环境假象。旋钮 `TSHARP_PARSE_CONCURRENCY`（r32 落入）保留供后续 A/B。

## 3. 与 Go 的剩余差距归因（修正后）

产品配置下停顿≈0，x1.397 的差距全部是每操作 CPU 常数：async 帧往返（1348 个 async 方法/6688 处 await，同步完成不分配但每帧有 builder/awaiter 成本）、Utf8String 键字典每次重算哈希、150 个服务对象的接口分派、关系/实例化引擎的每操作临时对象。分配削减（r32 方向）只经分配器 CPU 与缓存局部性起作用——r32 的 −22.4% 分配换来 x1.428→x1.397 即此路径的实证斜率。按此斜率，再砍 30% 分配约再换 3~4% 墙钟；反超需要把分配密度再砍一个量级或换架构（类型/签名结构体化 + arena），后者是月级重写且无人测过上限。

## 4. 门禁与产物状态

- 工作树：干净（两次插桩提交后回退，净产物改动为零；r32 落的 TSHARP_PARSE_CONCURRENCY 旋钮保留）。
- ledger 表2 新增 4 行（no-GC region / R2R / gen0+latency / parse 槽位），均带数据；perf-budgets §4.1 新增停顿前提修正。
- 下一步建议：若继续追求墙钟，唯一有实证斜率的方向是对象数削减（object-literal 上下文路径占 medium check 分配 34% 为首选目标），单项预期 1~2%，需按 r32 的字节门禁 + 配对 A/B 流程逐个做。
