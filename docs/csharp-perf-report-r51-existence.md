# r51 报告：模块解析存在性缓存（Program 相位 −16.6%）

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-21 ｜ 轮次: r51 ｜ 主题: resolution-existence-cache
> 触发: 用户令「按最优方案，修复发现的问题和缺陷」
> 关联: `docs/csharp-perf-report-r50-resolution.md`（并行化，本轮起点）、`docs/csharp-perf-report-r49-bottleneck.md`（问题发现）
> 状态: 已发布。改动 3 文件 19 行，输出六项等价验证通过。

## 1. 结论

r50 报告末尾点名的下一个缺陷修好了：模块解析对同一批目录反复做存在性探测。加同代缓存后：

| 指标 | 修复前 | 修复后 | 变化 |
| --- | ---: | ---: | ---: |
| 实际文件系统调用（真实工程） | 3,080 次 | 623 次 | **−79.8%** |
| 目录探测 | 2,389 次 | 139 次 | −94.2% |
| 文件探测 | 691 次 | 484 次 | −30.0% |
| Program 相位（12 对交错） | 中位 0.3425 s | 中位 0.2855 s | **−16.6%**（9/12 占优） |
| CPU（4 批全量态中位） | 1,851 ms | 1,727 ms | −6.8% |

## 2. 问题

r50 的并行化把「模块解析排在发布循环里」这个结构问题解决了，但解析本身仍在做重复的文件系统探测。临时探针（`TSHARP_FS_PROBE`，量后回退）在真实工程 291 文件上测得：

```
fileCalls=705 fileDistinct=482  dirCalls=2460 dirDistinct=154  reads=25
```

- `DirectoryExists` 调用 2,460 次，只有 154 个不同路径，重复率 **93.7%**；
- `FileExists` 调用 705 次，482 个不同路径，重复率 31.6%。

node16 解析会在候选目录链上逐层探测 `node_modules`，同一个祖先目录被不同导入反复查询。每层探测都是一次系统调用。

## 3. 修复

`ModuleResolver` 增加两个同代缓存：

```csharp
private readonly ConcurrentDictionary<Utf8String, bool> directories;
private readonly ConcurrentDictionary<Utf8String, bool> files;
```

- 比较器跟随 `fs.CaseSensitive`（与解析缓存、`PackageJsonCache` 一致）；
- `Invalidate()` 里与解析缓存一起清空，保证 `--watch` / 语言服务每次程序变更后重新探测；
- 三处探测改走 `resolver.DirectoryExists` / `resolver.FileExists`：`Request.DirectoryExists`、`ResolveModuleName` 的扩展探测、`PackageFile` 的候选探测。

安全边界：一次解析代际内目录与文件的存在性不会变化（编译不创建输入文件），所以缓存值与实时探测等价。这是缓存成立的前提，也是 `Invalidate` 必须清空它的原因。

用 `ConcurrentDictionary` 而非加锁字典，因为 r50 之后解析是并发的；`GetOrAdd` 的工厂在竞争下可能重复执行，但探测是幂等的，最坏情况只是多探测一次。

## 4. 输出等价验证

| 验证 | 结果 |
| --- | --- |
| 6 夹具逐字节（201 artifacts，对 `pre`） | 全等 |
| `errdense` 5000 行诊断 | 逐字节相同 |
| `dtsheavy` 的 `--traceResolution`（1208 行） | 逐字节相同 |
| `--singleThreaded` | 逐字节相同 |
| safety 套件 | 90/93，失败 ⊆ 基线 |

`--traceResolution` 这条特别重要：trace 文本会写「file exists」/「file does not exist」，走的是缓存后的布尔值。缓存值等于实时值，所以措辞不变。如果有任何一处缓存错了，1208 行里的某一行就会翻转。

## 5. 端到端为什么测不出来

四批 25~40 对全量态：0.8957 [0.876, 1.014]、0.9381 [0.868, 1.062]、0.9948 [0.886, 1.067]、1.0142 [0.893, 1.081]。全部含 1.0。

原因清楚：Program 相位在 r50 后只占 Total 约 20%，Program 降 16.6% 折到端到端只有约 3%，正好是本机 ±5~10% 分辨率的边缘。这与 r45 的情形同构，只是这次更薄。

本轮据此不宣称端到端收益，只报确定性指标：文件系统调用数（精确整数）、Program 相位配对中位、CPU 中位。

## 6. 门禁

| 门禁 | 结果 |
| --- | --- |
| Release 构建（全解决方案） | 0 警告 0 错误 |
| 6 夹具逐字节 | 201 artifacts 对 `pre` 全等 |
| safety | 90/93 ⊆ 基线 |
| 分配 | 峰值 RSS 379 对 380 MiB，持平 |

## 7. 产物

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 实现 | `Resolution/ModuleResolver.cs`、`.Paths.cs`、`.Exports.cs` | 已提交 |
| 探针 | `TSHARP_FS_PROBE`，已回退 | 不入库 |
| 门禁记录 | `built/csharp/perf-fresh/verify/r51-final.json` | 临时 |

## 8. 剩余

解析路径现在只剩 623 次真实系统调用，其中目录 139 次已等于不同路径数（154 减去 `PackageJsonCache` 自己缓存的那些），文件 484 次接近不同路径数 482。**这一层已经压到信息下限，没有重复可削。**

`PackageJsonCache` 自己的探测没有走新缓存，但它是按目录缓存的，重复率已经很低。

Total 现在的结构大致是 checkPool 0.55 s、Program 0.28 s、其余 0.28 s。检查相位重新成为最大的一块，其内部由关系引擎族主导，受 r27 表3 勿重开约束，EventPipe 对 AOT 的挂接在本机仍不通。
