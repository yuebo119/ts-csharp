# 测量方法学（METHOD）

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-08 |
| 轮次 | r03 |
| 主题 | 测量协议、口径与噪声控制 |
| 适用 | 本目录全部文档 |

---

## 1. 测量工具链

| 组件 | 路径 | 作用 |
| --- | --- | --- |
| 驱动 | `csharp/tools/performance-cli.mjs`（官方）<br>`tools/perf-cli.mjs`（本地分支） | 配对调度、统计、产物比对 |
| 公共层 | `tools/perf-common.mjs` | 进程启动、环境注入、输出采集 |
| 指标采集 | `csharp/tools/performance-metrics.ps1` | 峰值 RSS（`PeakWorkingSet64`）等 |
| 编译器自报 | `tsc --extendedDiagnostics --pretty false` | 分阶段时间 + 分阶段分配字节数（`Alloc * (summed)`） |

**本地分支相对官方的唯一改动**：`GetLastInputInfo` 输入活动门控由"拒绝整批"改为"记录"。原因：本机每秒产生合成输入，官方门控会拒绝 100% 的配对。

## 2. 配对协议

1. 两侧交替执行（A,B,A,B,…），消除顺序与热漂移偏差；
2. 取中位数，并用 bootstrap 给出 95% 配对 CI；
3. **每对都断言两侧产物逐字节一致**（退出码、stdout、发射文件哈希）——不一致即整批失败；
4. 记录噪声指标 `controls[0].p95RelativePairDifference`（同批对照的空转差异）。

**噪声下限**：同二进制互测（`bench/AB8-identical-control`）= 0.984–1.011，即 ≤1.1%。任何小于该幅度的结论都必须有 CI 支撑。

## 3. 三类可比量（按可信度排序）

| 等级 | 指标 | 说明 |
| --- | --- | --- |
| ★★★ | **确定性分配字节数** | `GC.GetTotalAllocatedBytes()` 按阶段差分，逐字节可复现，不受机器负载影响 |
| ★★★ | **同批配对比值** | 两侧同一批次交替测量，自带归一化；A/B 同二进制开关时最严格 |
| ★★ | 峰值 RSS | 稳定，但受 GC 配置与批次影响 |
| ★ | 绝对耗时（跨批次） | **禁止跨批次直接比较**；本机漂移可达 10–60% |

## 4. 构建形态（易错点）

| 侧 | 正确形态 | 命令要点 |
| --- | --- | --- |
| C# 产品形态 | **不内嵌 lib** | `-p:EmbedTypeScriptLibraries=false`（与 `package.mjs`/`product.mjs` 一致） |
| Go 参考 | **`noembed`** | `go build -tags=noembed -trimpath`，`CGO_ENABLED=0`，`GOAMD64=v1` |

内嵌形态会使镜像 +5.17 MB，纯启动负载慢 3.5~4%（详见 `audits/audit_2026-10-08_r03_build-shape.md`）。

## 5. 参考侧（Go）配置

| 口径 | 配置 | 用途 |
| --- | --- | --- |
| 出厂默认 | `GOGC=100`（默认） | 用户实际拿到的性能 |
| 审计调优 | `GOGC=400` | 公平对照（medium/declarations 快 8.5%/7.6%，代价是巨文件 RSS +21%） |

两者都必须报告（见 `audits/audit_2026-10-08_r03_go-reference-baseline.md`）。

## 6. C# 侧配置

| 配置 | 值 | 依据 |
| --- | --- | --- |
| GC 模式 | 工作站（`DOTNET_gcServer=0`） | 多文件负载快 5–11%、RSS 低 44–66% |
| gen0 预算 | 4 MiB（`DOTNET_GCgen0size=0x400000`） | 巨文件 −8.8%、medium −4.6%；但轻负载 +4~9%（见 `plans/…r03…` P0-2） |
| LOH 阈值 | 1 MiB（`DOTNET_GCLOHThreshold=1000000`） | 巨文件 RSS −13.1% |

## 7. 夹具与等价性

- 每个负载在 `bench/<批次>/<负载>/{go,csharp}/` 各有一份夹具；**tsconfig 与源码必须逐字节相同**（已核验 medium/huge-file/declarations）；
- 批次 `summary.json` 的 `inputsSha256` 记录夹具内容校验值，可用于事后确认两侧输入一致。

### 7.1 增量状态文件陷阱（r34 实测，2026-10-13）

`composite: true` 的夹具（真实工程）会把增量状态写到 **`<outDir>/../<配置名>.tsbuildinfo`**（源码 `Incremental/BuildInfo.Options.cs`：`GetBuildInfoFileName` 用 outDir 重算配置路径）。后果：

- `--outDir /tmp/xxx` 的多次运行共享同一个 `/tmp/tsconfig.tsbuildinfo`；**删夹具根的 `tsconfig.tsbuildinfo` 不挡它**。第一次运行全量 check 并写状态，之后运行恢复状态、跳过 check（实测 check 时间 1.9s → 0.000s，分配 1,005 MB → 371 MB），产出仍是全量 emit。历史真实工程分配数字（371.0 / 521.5 / 465.8 MB 与 r33 的 374 MB）全部是这一恢复态。
- `--outDir` 用项目内相对路径时状态文件落在夹具根，删它即可回到全量态。
- **每次测量前必须删掉当次 outDir 的兄弟状态文件**（或直接用项目内 outDir + 删夹具根状态文件）；用 `--incremental false` 也可完全避开。
- 另注意 `--extendedDiagnostics` 统计里的 `GC.GetTotalMemory(forceFullCollection: true)` 会强制一次全量 GC，使"GC pause time"读数从自然值（全量态实测 81.5 ms）抬到 0.22~0.24 s；比较停顿必须不带该旗标。


## 8. 一次标准测量的命令模板

```powershell
# C# 最新 vs 基线（产品形态，同批配对）
node tools/perf-cli.mjs --manifest manifests/final7-noembed.json `
  --go-executable pkgs/naot-svr/lib/tsc.exe `
  --csharp-env "DOTNET_gcServer=0,DOTNET_GCgen0size=0x400000,DOTNET_GCLOHThreshold=1000000" `
  --samples 15 --directory bench/AB37-final7-noembed-vs-baseline

# 同二进制开关 A/B（最严格）
node tools/perf-cli.mjs --manifest manifests/final7-noembed.json `
  --go-executable pkgs/final7-noembed/lib/tsc.exe `
  --csharp-env "<实验配置>" --go-env "<对照配置>" `
  --samples 11 --filter "^(medium|huge-file|small-first-diagnostic)$" --directory bench/AB38-...

# 分阶段分配（确定性，不受负载影响）
tsc --project <夹具> --extendedDiagnostics --pretty false | Select-String "Alloc |time"
```
