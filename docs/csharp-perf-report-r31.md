# r31 报告：GC 堆数双臂实测否决，配置杠杆清零（2026-10-11）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-11 ｜ 轮次: r31 ｜ 主题: gc-heap-count-rejected
> 涉及 git 节点: `e86fbc8d6a`（EPSL 审计 1 报告提交，工作树基线）；产品源码唯一改动 = CommandLine csproj 的条件化 bake 管线（默认零行为变化）
> 产品: `pkgs/epsl-heap4` / `pkgs/epsl-heap8`（AOT，`RuntimeHostConfigurationOption System.GC.HeapCount=4/8` bake，发布 15:37）
> 数据来源: 真实工程三臂交错 3 轮（停顿行直读）；AB127 隔离巨文件批（heap8 vs epsl-a1，15 对）
> 关联: `docs/csharp-perf-plan-r31.md`、`docs/csharp-perf-audit-epsl-1.md` §8

---

## 0. 结论

**HeapCount 4 与 8 双臂否决，r30 定义的最后一个配置杠杆关闭。** 假设方向被反证：本负载（16 核主机 / 8 checker）下减少堆数不省停顿，反而在 4 堆时直接放大停顿、8 堆时放大巨文件墙钟与 CPU。GC 配置面（模式/gen0/LOH/DATAS/堆数）至此全部实测定案。

| 臂 | 停顿（真实工程，3 组交错） | 巨文件墙钟（隔离批） | 裁决 |
| --- | --- | --- | --- |
| heap4 | **三轮同向恶化**：0.235→0.355 / 0.271→0.325 / 0.204→0.304（+20~49%） | 未跑批（停顿通道已否决，单跑墙钟 1.172~1.755s 亦劣） | **否决** |
| heap8 | 持平（中位 0.240 vs 基线 0.235；逐轮 +2%/−10%/+16% 混合） | **+8.5%**，medianRatio 1.0845，CI [1.045, 1.108]，零弃对；cpuMs 比值 1.53 | **否决** |
| epsl-a1（基线，16 堆默认） | 0.204~0.271（中位 0.235） | 564.4 ms | 维持 |

heap8 的唯一改善项是巨文件峰值 RSS −20.7%（376→298 MiB，批内比值）；RSS 不在预算线内且墙钟代价 CI 显著，不构成采纳理由。

## 1. 方法与原始数字

- 旋钮存在性按 P0 #4 查证：`System.GC.HeapCount`（learn.microsoft.com/dotnet/core/runtime-config/garbage-collector），Server GC 专用、无专用 MSBuild 属性、经 `RuntimeHostConfigurationOption` bake；本机 env 变量对 NativeAOT 产品无效（r18 实测），故必须 bake。
- 管线：`TypeScript.CommandLine.csproj` 条件 item（`-p:GCHeapCount=<n>` 传入才生效），默认构建逐字节不受影响。
- 三臂交错（真实工程 291 文件，每组前删 tsbuildinfo）：

| 轮 | a1 停顿 | heap4 停顿 | heap8 停顿 |
| --- | ---: | ---: | ---: |
| 1 | 0.235 s | 0.355 s | 0.240 s |
| 2 | 0.271 s | 0.325 s | 0.245 s |
| 3 | 0.204 s | 0.304 s | 0.237 s |

分配三臂各自成带（a1 811.46~811.66 MB / heap4 811.82~811.89 / heap8 811.75~811.80），差异 ≤0.05%——GC 形态不改分配量级，band 内差异不解读。

- AB127（heap8 vs a1，巨文件 15 对）：控制组 medianRatio 0.961（CI [0.911, 1.034] 含 1.0，p95rel 32.9%——控制项高离散但行级 spread 1.08/1.07 紧、零弃对）；行效应 +8.5% 且 CI 远离 1.0、方向与槽位偏置相反（按控制组修正后更差 ~1.13），结论稳。cpuMs 中位 859→1312 ms（量化 15.625 ms 粒度下的大效应）。

## 2. 机制读法（最优假设，无法在本机进一步归因）

更少堆 = 更小总代预算 + 更少并行标记线程。4 堆对 8 个并发分配 checker 构成分配等待放大（停顿通道直接恶化）；8 堆勉强覆盖分配并发但标记并行度降半，巨文件突发分配形态下墙钟与 CPU 上升。与 r18 结论（巨文件需要多堆吸收并行分配突发）同族——那次是 Workstation 单堆输 17~28%，这次是 8 堆输 8.5%，梯度自洽。

## 3. 处置

1. `RuntimeHostConfigurationOption` 管线保留（默认关闭，注释指向本报告）——未来负载形态变化（如 checker 数 ≠ 8）可复用。
2. ledger：待勘区"GC 堆数"移入表2 明确不做（带本报告数据）。
3. 产品形态维持 r18 定案：Server GC + DATAS 关闭 + 默认堆数。GC 配置面关闭后，剩余开放面只有 245 容器队列（顺手批）与 CA1849/CA2012 清理（B 批门槛）。

## 4. 工作树状态

- 产品改动 1 文件：`TypeScript.CommandLine.csproj`（条件 bake 管线）；`ParserLadderTests.cs` + `Program.cs` 分发为同日修复轮件（见审计报告 §8）。
- 测量工作区：`pkgs/epsl-heap4`、`pkgs/epsl-heap8`、`manifests/epsl-heap8.json`、`bench/AB127`（heap4 未建 manifest/未跑批，否决依据为停顿通道）。

### 进度追踪

| 维度 | 状态 |
| --- | --- |
| 实现进度 | r31 100%（查证 → 管线 → 双臂实测 → 裁决）；配置面关闭 |
| 验证完成度 | 三臂交错 3 轮 + AB127 隔离批（零弃对、CI 显著）；未验证：heap4 的批形态墙钟（停顿通道已否决，按计划递进门不再加批） |
