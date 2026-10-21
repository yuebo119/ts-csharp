# r40 报告：tsrs 缓存族探针与 union front cache 定价

> **元数据** ｜ 类型: report ｜ 日期: 2026-10-21 ｜ 轮次: r40 ｜ 主题: tsrs-cache-probes
> 触发: 用户令「按你的方案，完整实现」
> 关联: `docs/csharp-perf-plan-r40.md` §13（方案论证）、`docs/csharp-perf-tsrs-analysis.md`、`.ai/perf-ledger.md`
> 状态: 已执行并裁决。产品代码零改动；两个新夹具保留，探针补丁与 union 原型已回退。

## 1. 结论摘要

三个候选里，infer memo 与 flow walk memo 在探针阶段关闭，union front cache 进入原型但未通过发布门禁，已全额回退。

infer 的关闭是结构性的：真实工程 382 次 `InferConditionalAsync` 里有 48 次重复，但可缓存子集（`mapper is null && !deferred`）只有 63 次调用、0 次重复。探针把"重复"与"可缓存子集"分开计数后，命中机会为零。flow 的跨 walk 重访只有 23.3%，低于 50% 门槛，且 189/190 个键的 `declared`/`initial` 不一致，memo 键要扩成四元组，收益进一步稀释。

union 的探针通过叠加档：真实工程残余调用 38,082 次，重复 27,239 次（71.5%），残余重复时间约 3.8% checkPool。原型实现了 2^10 直接映射前置缓存，shadow、逐字节、safety 全部通过。但 checkPool 交错 A/B 没有出现 ≥3% 的确定性收益，14 对中位比值 1.09（最紧的 8 对为 1.01），noEmit 墙钟两批 CI 均含 1.0。按方案的门槛，全额回退。

结论：tsrs 这条缓存经验线到此关闭。探针这一轮买到一个确定的答案，比继续在原型上调参更值。

## 2. 阶段 0：夹具

在 `csharp/tools/perf-fixtures.mjs` 新增两个夹具，随生成器提交。

| 夹具 | 形状 | 验收 |
| --- | --- | --- |
| `mapped1` | 单文件 400 成员接口 + 映射类型 + `infer` 条件类型 + 800 个强制求值导出 | 0 诊断；checkPool 0.494 s；determinism 由生成器保证 |
| `genericdeep` | 32 文件、每文件 20 组泛型函数与跨文件 `Unwrap0` 条件应用 | 0 诊断；checkPool 0.475 s |

`mapped1` 的成员类型按 10 种形状循环，`Flat` 对每个成员应用 `Unwrap`，是本轮最接近 proto.ts 单点巨类型形状的合成负载。`genericdeep` 让 32 个文件重复应用同一个 `Unwrap0`，用于跨文件条件推断的重复率。

## 3. 阶段 1：探针结果

探针闸门 `TSHARP_PROBE=caches` 只存在于临时补丁；计数精确，计时每 8 次采样一次。时间份额按 `phase:checkPool` 折算。

| 负载 | checkPool | infer 调用 / 可缓存 / 可缓存重复 | union 残余 / 残余重复 / 残余重复时间 | flow At / 跨 walk / 家族时间 |
| --- | ---: | ---: | ---: | ---: |
| `mapped1` | 0.494 s | 190 / 0 / 0 | 5,598 / 2,854 (51.0%) / 2.67 ms (0.54%) | 2,202 / 0 / 79.1 ms (16.0%) |
| `genericdeep` | 0.475 s | 1,004 / 0 / 0 | 5,863 / 2,904 (49.5%) / 2.66 ms (0.56%) | 4,454 / 640 (14.4%) / 3.1 ms (0.66%) |
| `dtsheavy` | 0.462 s | 8 / 0 / 0 | 5,993 / 3,052 (50.9%) / 2.74 ms (0.59%) | 600 / 0 / 0.6 ms |
| 真实工程 | 0.615 s | 382 / 63 / 0 | 38,082 / 27,239 (71.5%) / 23.1 ms (3.76%) | 109,879 / 25,650 (23.3%) / 149.1 ms (24.2%) |

真实工程的 infer 细分：`mapperNull=110`、`deferred=227`、`cacheable=63`、`cacheableRepeats=0`、`pureRepeats=0`。63 次可缓存调用里，59 次没有新建类型、63 次没有新诊断、59 次没有实例化、63 次没有触碰实例化预算；纯净判据本身工作正常，问题是这个子集没有重复。

真实工程的 union 标志分布：`alias=1,657`（4.4%）、`origin=917`（2.4%）、`subtype=2,561`（6.7%）、`literalMix=1,017`（2.7%）、`constrained=0`。保守谓词会排除约 15% 的残余调用。

真实工程的 flow 细分：`declaredMismatch=189`、`initialMismatch=190`、`same-walk=1,918`、`disabled=0`。跨 walk 重访 23.3%，远低于 tsrs 的 63~67%。

## 4. D1 裁决

| 候选 | 门槛 | 实测 | 裁决 |
| --- | --- | --- | --- |
| infer memo | 纯净重复 >10%，可缓存重复 >0 | 可缓存重复 0 | 关闭 |
| union front cache | 残余重复 >15%、alias 为空 >80%、残余重复时间 ≥2% | 71.5%、95.6%、3.76% | 进入 2B |
| flow walk memo | 跨 walk 重访 >50%、家族时间 ≥2% | 23.3%、24.2% | 关闭 |

flow 是本轮最接近的落选者：家族时间占 checkPool 的 24.2%，说明 flow 本身很贵；但 23.3% 的跨 walk 重访低于门槛，且 190 个键的 `initial` 不一致，说明同一 reference 在不同 walk 里的初始类型会变，键必须扩成 `(reference, flowNode, declared, initial)` 四元组，命中面进一步缩小。按方案的门槛关闭，不进入 3 天可行性实验。

## 5. 阶段 2B：union front cache 原型与门禁

实现形状：`TypeAlgebra` 内 2^10 直接映射表，每槽存 64 位输入序哈希、输入个数、归约模式与结果引用；只覆盖 `unionPairs` 之外、`alias/origin` 为空、非 `Subtype`、无受约束变量、无模式字面量混合的残余调用。命中路径直接返回；未命中路径在 `UnionWorker` 返回后检查 `ΔTypeCount`、`ΔDiagnostics`、`ΔInstantiationCount`、`ΔRecursionLimitCount`，全零才写入。`TSHARP_UNION_SHADOW=1` 时命中重算并做引用相等比对。

门禁结果：

| 门禁 | 结果 |
| --- | --- |
| Release 构建 | 全解决方案 0 警告 0 错误 |
| shadow | 真实工程 + `mapped1` + `genericdeep` 均为 0 不一致 |
| 逐字节 | 6 夹具 201 artifacts 对 `pre` 全等（仓内 `perf-verify` 口径） |
| safety | 90/93，失败集合 = `npm-process-safety`、`program-emit-safety`、`checker-relation-context-safety`，⊆ 基线 |
| RSS | 122 MiB，两侧一致 |
| checkPool 交错 A/B | 14 对中位比值 1.09；最紧的 8 对 1.01；无 ≥3% 收益 |
| noEmit 墙钟 A/B | 批 1 0.972 CI [0.913, 1.111]；批 2 0.892 CI [0.808, 1.135]；两批均含 1.0，且 p95/min 超 1.29 的批次有效性线 |
| 全量态 A/B | 未跑：checkPool 无收益，全量态不可能更好 |

判定：检查相位没有 ≥3% 的确定性收益，端到端 CI 两批都含 1.0。按方案 §6 全额回退，产品代码零改动。

## 6. 为什么原型没有兑现

探针的 3.76% 是"免费命中"的上限。真实工程的残余重复调用平均 0.85 µs/次（23.1 ms / 27,239），而命中路径仍要付 `UnionAsync` 入口的栈守卫、取消检查、`RequireOwned`、按输入个数计算哈希、数组探测与 async 包装。残余调用本身很便宜，省下的 `UnionWorker` 只占其中一部分，净收益被入口开销吃平。

这也解释了为什么全量态不需要再测：检查相位是 0 或负收益，端到端只会被其他相位进一步稀释。方案把 union 标为叠加档而不是独立档，判断是对的；叠加档的前提是 2A 同时存在，而 2A 已被探针关闭。

## 7. 未执行项与关闭理由

- 2A infer memo：D1 关闭。可缓存子集零重复，换任何缓存形状都无命中；缓存 `mapper != null` 的调用需要把 mapper 身份纳入键，mapper 又常是每次调用新建，命中率不会比 0 更好。
- 2C flow memo：D1 关闭。跨 walk 重访 23.3% < 50%，且键需扩成四元组。若未来 L3-b 需要 flow 归因，可以从"24.2% 家族时间"这个数字重新立项，但不在本轮门槛内。
- L3-b、L4：未触发。2A 没有实施，L3-b 的触发条件（proto.ts 仍 ≥200 ms）未成立；L4 是独立线。

## 8. 产物与复现

| 产物 | 位置 | 状态 |
| --- | --- | --- |
| 两个新夹具 | `csharp/tools/perf-fixtures.mjs` | 保留并提交 |
| 探针补丁 | `/tmp/r40-probe.patch`、`/tmp/CacheProbe.cs` | 临时文件，不入库 |
| union 原型二进制 | `built/r40-union/` | 临时产物 |
| 回退后基线二进制 | `built/r40-revert/` | 临时产物 |
| A/B 原始摘要 | `/c/ai/projects/tsbench/r38/r40-union-noemit*.json` | 临时产物 |
| 逐字节记录 | `built/csharp/perf-fresh/verify/r40-union.json`、`r40-revert.json` | 临时产物 |

复现探针：把 `/tmp/CacheProbe.cs` 放回 `Checking/`，应用 `/tmp/r40-probe.patch`，按 §3 的发布命令构建，设置 `TSHARP_PROBE=caches` 跑四个负载。复现 A/B：`node /c/ai/projects/tsbench/r38/r40-union-paired.mjs noemit 25 2`。

## 9. 下一步

tsrs 的缓存线关闭后，待勘区只剩 L3-b（proto.ts 每节点成本归因）与 L4（lib 预绑定，Program 0.267 s）。两者都不依赖本轮产物。r40 的净产出是一个可复核的否定结论，以及两个能复现单点巨类型与跨文件条件推断的夹具；后续任何缓存提案可以直接用这两只夹具先量重复率，不必重造。
