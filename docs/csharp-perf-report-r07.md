# r07 实施报告：检查阶段帧级时间归因与两处惰性化，含一次被实测否定的改造

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-08 ｜ 轮次: r07 ｜ 主题: check-frame-timing-and-lazy-structures
> 涉及 git 节点: `dbdb0215fb`（r06 出货节点，`pkgs/r06` sha256 `28d92657…`）/ `9c2715f91b`、`c4144ce6fd`（本轮）
> 数据来源: `bench/AB63`、`bench/AB64`（r07 vs r06，23 负载 × 15 组交替配对）；CoreCLR 诊断构建自报 + 采样剖析
> 关联: `docs/csharp-perf-report-r06.md`、`docs/csharp-perf-report-r06-comparison.md`

---

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 新增能力 | `--extendedDiagnostics` 的探针帧同时报告**包含式墙钟时间**与分配（静态开关门控，普通编译零成本） |
| 分配削减 | 产品 AOT，巨文件夹具 **479.8 → 465.5 MB（−3.0%）**，逐次可复现 |
| 墙钟 | 与 r06 同批配对为**中性**（噪声 18.9%；巨文件 cpu −6% / wall −1.8%，轻负载 CI 含 1.0） |
| 被否定并回退的改造 | 用自有身份哈希替换运行时身份哈希路径（详见 §4） |
| 验证 | 5 个负载 1,223 个产物 + 16 个语句形态夹具逐字节一致；8 个 safety 套件通过 |

---

## 2. 检查阶段帧级时间表（巨文件，CoreCLR 诊断构建，check = 1.29 s）

| 探针帧 | 时间 | 分配 | 读法 |
| --- | ---: | ---: | --- |
| objectLiteral | 0.42 s | 100.4 MB | 对象字面量检查整体（包含式） |
| ├ objectProperty（属性循环） | 0.28 s | 68.2 MB | 16,384 个字面量 → 每字面量 4.2 KB |
| ├ ├ **objectPropertyInit**（初始化器检查） | **0.24 s** | **54.8 MB** | 32K 个属性 → **每属性 1.7 KB** |
| ├ ├ objectPropertyBook（符号/链接/声明表） | 0.02 s | 8.4 MB | **仅占 check 的 2%** |
| └ objectType（fresh 类型 + 成员表） | 0.04 s | 9.4 MB | 0.6 KB/字面量 |
| relationRelated | 0.30 s | 20.5 MB | 顶层可赋值性判定 |
| ├ relationCompare | 0.26 s | 14.3 MB | 会话/键开销之外的比较本体 |
| └ **checkerRelated**（结构比较） | **0.25 s** | — | 16K 次 → **每次约 15 µs** |
| symbolTypesGet | 0.12 s | 25.4 MB | 符号→类型 |
| typeFromNode / typeLiteral | 0.07 / 0.06 s | 20.2 MB | 注解类型字面量 |
| variableType | 0.05 s | 13.7 MB | 变量类型解析 |
| membersTable | 0.05 s | 16.7 MB | 成员表解析入口 |
| resolveMembers / setMembers | 0.05 / 0.03 s | 8.3 / 7.3 MB | 成员表构建 |

**两条被数据推翻的 r06 假设**：①属性符号/链接/声明表的簿记（`objectPropertyBook`）只占 check 的 **2%**，不是分配表暗示的 38%；②结构关系 0.25 s 里几乎没有会话/键/缓存开销，全部是比较本体。检查阶段的成本是**大量小而分散的每次表达式/类型操作**（初始化器检查 1.7 KB/属性、关系比较 15 µs/次），不是某几处结构性浪费。

---

## 3. 落地的两处惰性化（`c4144ce6fd`）

| 改动 | 依据 | 效果 |
| --- | --- | --- |
| `NameGenerator` 作用域的两套集合改为首次使用时创建；唯一性遍历读列表时不再强制创建 | 每个名字作用域此前都会分配一个计数 `Dictionary<Utf8String,uint>` 与保留名 `HashSet<Utf8String>`，而绝大多数作用域从不生成名字 | 分配 trace 中这两行（5.7 MB + 3.5 MB）整体消失 |
| 对象字面量的 `all`（展开覆盖检测）与 `ordered`（源序，索引签名/展开路径用）改为按需分配；`all` 在首个展开处从 `ordered` 物化 | 无展开、无计算属性名的字面量从不读取这两者（占绝大多数） | 每字面量少 2 个容器；`objectLiteral` 分配 100.4 → 95.6 MB |

产品 AOT 总分配 **479.8 → 465.5 MB（−3.0%）**，三次运行 465.55/465.52/465.49 MB。

---

## 4. 被实测否定并回退的改造：自有身份哈希

**动机**：采样剖析（CoreCLR）显示 `RuntimeHelpers.GetHashCode` 的运行时慢路径占主线程样本的约 10%，调用方集中在 `EmitContext.Data`(26)、`ObjectLiterals.GrammarAsync`(18)、`LinkStore.Get`(16)、`EmitContext.SetOriginal`(14)、`Deprecations.Declaration`(10) 等节点/符号键字典。

**做法**：给 `Symbol` 与 `SyntaxNode` 各加一个构造期分配的身份哈希字段，配 `IEqualityComparer` 替换这些字典的 `ReferenceEqualityComparer`，覆盖 14 处字典。

**结果（AB63，r07 首次发布）**：AOT 产品上 CPU 比值几乎全为 1.000（巨文件 cpu x0.986 [0.934,1.042]），**没有可测收益**；同时 `SyntaxNode` 每节点 +4~8 B 使分配回升约 1.7 MB。

**判定与处置**：CoreCLR 的慢路径在 NativeAOT 上并不存在（或代价小得多），因此把 CoreCLR 剖析结论当作 AOT 依据不成立。按"无实测支持的改动不入库"回退全部身份哈希改动，保留两处惰性化。**教训入库**：剖析结论必须与出货运行时（NativeAOT）同构，否则只能作为线索。

---

## 5. 与 r06 的配对对照（AB64，噪声 18.9%）

| 负载 | cpu 中位（r06 → r07） | cpu 比值 | wall 比值 | 95% CI |
| --- | --- | ---: | ---: | --- |
| huge-file | 1109 → 1047 ms | x0.94 | x0.982 | [0.958, 1.002] |
| medium | 328 → 313 | x0.95 | x1.018 | [0.954, 1.045] |
| medium-checkers-1 | 250 → 234 | x0.94 | x1.015 | [0.977, 1.059] |
| tiny-files-incremental-edit | 813 → 750 | x0.92 | x1.003 | [0.899, 1.105] |
| 其余 19 项 | — | x1.00 | x1.01~1.05 | 多为负载漂移（cpu 列 1.00，wall 列偏慢集中在启动型负载） |

本批次噪声 18.9%，且 `cpuMs` 有 15.6 ms 量化，轻负载（cpu 16~47 ms）的比值无判别力。结论只取两条：分配削减确定成立；时间与 r06 相比无可测变化，巨文件是唯一有方向性信号的负载。

---

## 6. 下一轮可动的三项（含本轮新增依据）

| 项 | 量级 | 依据 |
| --- | ---: | --- |
| 初始化器检查路径（`MutableAsync` 及其上下文类型/加宽/映射链） | 0.24 s / 54.8 MB（占 check 分配 30%） | §2；每属性 1.7 KB，含 `MapAsync` 委托分配与每次表达式的缓存插入 |
| 结构关系比较本体 | 0.25 s（15 µs/次） | §2；会话与键开销已排除，剩下的在 `PropertiesAsync` 逐属性查找与新鲜字面量的多余属性检查 |
| `Part[]`（打印机部件数组） | 61 MB | r06 报告 §0.4；`S(...)` 每次调用一个数组，需按调用点直推化（改动面大，需单独一轮） |

---

## 7. 验证门禁

| 门禁 | 结果 |
| --- | --- |
| 构建 | 0 警告 / 0 错误（AOT 产品形态，`pkgs/r07` sha256 `e0cb5c3dd1db…`） |
| 逐字节一致 | 5 个基准负载（1,223 个产物）+ 16 个语句形态夹具，与 r05c/r06 未改动产物一致 |
| safety 套件 | `emit-foundations`、`transpile`、`declaration`、`checker-objects`、`checker-members`、`checker-relations`、`checker-properties`、`incremental` 全部通过 |
| 确定性分配 | 巨文件 465.5 MB（r06 为 479.8 MB） |
| 否定改造的处置 | 身份哈希实验的代码已全部回退，工作树只留两个提交 |
