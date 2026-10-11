# r31 计划：GC 堆数轮（2026-10-11）

> **元数据** ｜ 类型: plan ｜ 日期: 2026-10-11 ｜ 轮次: r31 ｜ 主题: gc-heap-count
> 触发: EPSL 审计 1 B 批移交（用户指令"根据报告全面修复"）；r30 定性为唯一剩余可测配置杠杆
> 关联: `docs/csharp-perf-audit-epsl-1.md`、`docs/csharp-perf-report-r30.md` §3、ledger 待勘区首项

## 1. 假设与依据

- r26：GC 停顿占真实工程墙钟 10~20%（0.20~0.25 s 级），STW 冻结全部 8 个 checker 线程。
- 当前形态：Server GC 编译期启用 + DATAS 关闭（r18），16 核主机默认堆数 = 核数（16），负载只有 8 个 checker。
- 机制假设：更少堆 → 每次标记集更小、代预算更小、STW 并行度更低——**方向需实测**（收益与代价同源，可能双向）。
- 旋钮存在性已按 P0 #4 查证（learn.microsoft.com/dotnet/core/runtime-config/garbage-collector）：`System.GC.HeapCount` 仅 Server GC 生效，无专用 MSBuild 属性，需 `RuntimeHostConfigurationOption` item bake（本机 env 变量对 NativeAOT 产品无效，r18 实测）。

## 2. 方法

1. **管线**：`TypeScript.CommandLine.csproj` 加条件 item——`RuntimeHostConfigurationOption Include="System.GC.HeapCount" Value="$(GCHeapCount)"` 仅当 `-p:GCHeapCount=<n>` 传入时生效（默认零行为变化）。
2. **产品**：从当前 HEAD（= epsl-a1，e86fbc8d6a）发 `pkgs/epsl-heap4`（-p:GCHeapCount=4）与 `pkgs/epsl-heap8`（=8）。
3. **判别仪器**：`GC pause time (process)` 行直读（r30 指定）；辅助判别——总墙钟与巨文件隔离批（r27 模板，防批间漂移误读）。
4. **批次**（每臂递进，按 r27 纪律隔离巨文件先行）：
   - AB126：epsl-heap4 vs epsl-a1，巨文件隔离批（15 对）
   - AB127：epsl-heap8 vs epsl-a1，巨文件隔离批（15 对）
   - 真实工程停顿行：每臂 3 组（方向性，样本小不立结论，r27 先例）
   - 任一臂停顿同向下降且墙钟不劣 → 加跑 7 负载确认批（AB128）
5. **裁决标准**：停顿显著下降（≥3 组同向且幅度 > 批内带宽）且重负载墙钟不劣化（隔离批 ratio CI 上缘 ≤ 1.015）→ bake 进产品默认；否则入 ledger 表2（带数据）。
6. **语义门禁**：GC 形态不改产物字节，但 bake 落产品时仍跑逐字节 25/25 + safety 90/95 + 分配锚点（应严格不变）。

## 3. 出口

- 采纳：产品默认 HeapCount 生效 → 全表批（AB129 起）用采纳节点跑，三方表"最新"节点更新。
- 否决：ledger 表2 新增一行（停顿/墙钟数据 + bake 管线保留但默认关闭），GC 配置面就此关闭，配置杠杆清零。
