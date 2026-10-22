# r57 报告：解析争用假设证伪 + 表示层方向的定量上限

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-22 ｜ 轮次: r57 ｜ 主题: resolution-contention-falsified-and-representation-ceiling
> 触发: 用户令「结合 C# 新特性和 tsrs 经验，继续极致优化当前项目」；执行 r55 遗留的「共享资源争用站点未逐一定位」。
> 关联: `docs/csharp-perf-report-r55.md`（争用形态的提出）、`docs/csharp-perf-report-r56.md`（同批否决 checker 数）、`docs/csharp-perf-tsrs-analysis.md`（表示层方向的依据）
> 状态: 诊断轮，**产品代码零改动**。候选改动已实现并通过构建，经实测证伪后回退（补丁留档 `tsbench/r38/r57-pkgcache-rejected.patch`，155 行）。

## 1. 结论

三条，都指向同一件事：本仓在「调度 / 缓存 / 并发 / 相位排列 / 启动 / 解析」上已无可兑现空间，而唯一剩下的表示层方向的**可证收益上限很小**。

1. **解析争用假设证伪**：r55 记录的「resolve 槽位翻倍时求和涨 1.5~2 倍而墙钟不动」被定位到具体站点并实测——`PackageJsonCache` 的命中/未命中计数为 **1315 次查询、1171 次命中、144 次未命中、144 次真实载入、13 次竞争丢失**，锁的临界区总成本约 26µs，相对 resolve 的 310ms 可忽略。把锁内 I/O 移到锁外（已实现并通过构建）后，默认槽位下 Program 4 对中 3 对占优、8 槽无稳定收益，**不构成可发布收益**。
2. **表示层方向的定量上限**：类型对象约 137,673 个，基数类 56 字节加子类字段，估算约 16 MiB，占存活托管堆 216 MiB 的 **7.4%**。即使紧凑化一半也只省下约 3.7% 的堆；而 r34 已把 GC 通道定价为墙钟 −0.90%（不可分辨），RSS 不构成性能理由。**表示层重写唯一未被定价的收益是检查期的缓存局部性**，这一点必须靠原型才能回答。
3. **因此不建议开工月级重写**，除非先做一个 1~2 周的可证伪局部性原型（见 §4）。

## 2. 争用假设的定位与证伪

r55 §3.2 的观测：parse 固定 4、只把 resolve 槽位提到 8/16 时，`r55Resolve` 的**求和**从 0.31s 涨到 0.50/0.70s，而 Program 墙钟不动。当时的推断是「共享资源争用」，但没定位站点。

审查解析路径上的全部锁，只有一处会在**持锁状态下做 I/O**：

```csharp
// PackageJson.cs（改动前）
lock (gate)
{
    cached = entries.TryGetValue(directory, out var existing);
    if (cached) return ...;
    bool exists = fileSystem.DirectoryExists(directory);      // ← 锁内 I/O
    byte[]? bytes = exists ? fileSystem.ReadFile(...) : null; // ← 锁内 I/O
    var entry = new PackageJsonEntry(..., PackageJson.Parse(...)); // ← 锁内解析
    entries.Add(directory, entry);
    return entry;
}
```

`ModuleResolver` 的三处 `lock (gate)` 只包字典读写（微秒级），`Request.active` 是每请求私有，均不构成争用。因此实施了「I/O 移出锁 + 代际校验后写入」的改动，并加计数器量实际规模：

| 计数 | 实测（真实工程 291 文件） |
| --- | ---: |
| packageJson gets | 1315 |
| hits | 1171（89%） |
| misses | 144 |
| loads（真实 I/O + JSON 解析） | 144 |
| lost races（并发下重复探测） | 13 |

**锁内 I/O 总共只发生 144 次**，且都集中在启动初期；命中路径虽然仍要拿锁，但 1315 次无竞争的 `Monitor.Enter` 约 26µs。结论：**这条路径从来不是争用的来源**，r55 观察到的求和膨胀来自解析器多线程自身的固有开销（多线程下每线程的路径构造与探测缓存局部性变差），不是锁。

改动经实测同样不支持发布：

| 对照 | old（4 槽，锁定 I/O） | new（4 槽，锁外 I/O） |
| --- | --- | --- |
| Program（4 对交错） | 0.189 / 0.305 / 0.202 / 0.236 s | 0.162 / 0.230 / 0.212 / 0.183 s |
| new 8 槽 vs old 4 槽（6 对） | 3 对占优、3 对落后 | — |

4 对配对中位数看 owner 侧约 −10%，但 6 对 8 槽对照完全没有方向性。**按「低于噪声下限不发布」的纪律回退**，补丁留档以便未来在更高分辨率环境下复审。

## 3. 表示层方向的定量上限

tsrs 的 4~17× 优势来自表示层与内存层（`docs/csharp-perf-tsrs-analysis.md`），而本仓的招牌技术（零拷贝 `Utf8String` 标识符、indexed access memo、关系缓存简单形键）均已具备。要判断「紧凑化类型对象」还剩多少空间，先把可证通道算出来：

| 量 | 实测/估算 | 来源 |
| --- | ---: | --- |
| Types | 137,673 | `--extendedDiagnostics`（真实工程） |
| 存活托管堆 | 216 MiB | 同上（`GC.GetTotalMemory(forceFullCollection: true)`） |
| `Type` 基类 | 56 字节（对象头 16 + 3 引用 24 + `Id`/`Flags`/`ObjectFlags` 12，对齐后） | `Checking/Types.cs` 字段布局 |
| 子类附加字段 | 如 `IntrinsicType` 加 `Utf8String`；并集/交集加容器引用 | 同上 |
| 类型对象总量 | 约 16 MiB（按平均 120 字节） | 估算 |
| 占存活堆 | **7.4%** | 估算 |

也就是说，即便把类型对象紧凑化一半，也只省下约 8 MiB / 存活堆的 3.7%。两条可证通道的结论：

- **内存通道**：省 3.7% 的堆。而 `perf-budgets.md` 的分配预算按「进程总分配（≤1,050 MB）」计，紧凑化会同时**增加**分配（装箱/复制）或至少不降，收益面窄。
- **GC 通道**：已由 r34 的 no-GC region 实验定价——把停顿从 81.5 ms 压到 3.9 ms，墙钟只变 −0.90%（低于 1.1% 噪声下限）。**GC 不是关键路径**，所以减少堆不换来时间。

剩下的唯一未定价通道是**检查期的缓存局部性**：关系引擎族线程时间 1.2~1.5s（r52）而 `relationCompare` 单次约 2µs，这个数量级确实可能是缓存缺失主导的（r42 已指出「指针追逐」）。但 r34 的成本判定是「局部性通道不建原型测不出」，这条至今没有被推翻，也没有被证实。

## 4. 处置

**本轮不改产品代码。** 两条可选路径，都需要用户裁决：

1. **局部性定价原型（推荐，1~2 周）**：只对一个高频类型族（如 `UnionType`/`ObjectType` 的实例化形态）做紧凑化或结构拆分（热字段内联、冷字段外置），在真实工程 + 巨文件两个负载上做配对 A/B，判据是检查相位墙钟 ≥3% 且门禁全过。量不到就停，不进入全面重写。这是目前唯一可能突破两位数收益的方向，也是唯一能用小成本证伪的方向。
2. **收尾**：维持现状。当前战役累计战绩是 r45+r48+r50+r51+r54 五项已发布（r51 记的 40 对累计 −12.7%，r54 在其上再叠加 emit 相位 −12.3%），而 2026-10-21 以来的 r55/r56/r57 三轮已把「调度 / 缓存 / 并发 / 相位排列 / 启动 / 解析」六类手段逐一定界。

## 5. 复现口径

- 计数探针：`PackageJsonCache` 内的 `Interlocked` 计数（`r57Gets/Hits/Misses/Loads/Contended`）与 `CompilationStatistics.Report` 的输出行，随补丁回退，补丁见 `tsbench/r38/r57-pkgcache-rejected.patch`。
- 改动前后的交错对照用 `built/r54-final`（旧）与 `built/r57-probe-run`（新），无 `--extendedDiagnostics` 之外的额外旗标；夹具副本每轮新建并删 `tsconfig.tsbuildinfo`。
- 类型对象尺寸按 `Checking/Types.cs` 的字段布局推算，非实测 `sizeof`（AOT 下无该 API）；7.4% 是量级估算，用于判断方向而非精确预算。
- 本报告的 Total 读数同样含 `docs/csharp-perf-method.md` §7.1b 记录的约 350ms 统计开销。