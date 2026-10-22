# 专项：架构与契约审计（只读）

派生自 `master.md`。先读它的 §0 与 §1，本文件只写任务加料。

## 为什么做这个

编译器库 701 个文件、18 万行，20 多个子目录。分层只靠约定，没有架构测试，没有依赖方向门禁。safety 旗标钉死的是行为契约，不是结构契约。

## 目标

找出依赖方向违规、契约泄漏、重复实现、死代码、巨类、可测性障碍。

## 方法

### 1. 依赖方向

画模块依赖图（Mermaid），节点取 `src/TypeScript.Compiler` 下的一级目录。对每条边判定方向是否合法：底层不得引用高层，领域逻辑不得引用宿主。

具体核对：

- `Semantics` / `Checking` 是否引用了 `Hosts` / `LanguageServer` / `Api`
- `Text` / `Storage` 是否引用了语义层
- `Incremental` 与 `Projects` 的耦合是否形成了循环
- `Experiments` 目录里还剩什么，是否还在产品路径上

### 2. 公开面审计

列出所有 `public` 类型与成员，找出三类问题：

- `internal` 实现细节出现在 `public` 签名（返回内部类型、参数要内部类型）
- 本该 `internal` 却 `public`（只被同 assembly 使用）
- API 边界包装被当成冗余：已知 `Array.AsReadOnly` 是契约（`module-program-specifiers-safety` 钉死外部写入必须抛 `NotSupportedException`），这类不许改。反过来，内部存储的包装才是冗余。

### 3. 重复实现

找同一语义的多处实现。候选方向：

- 路径拼接与规范化（`CompilerPath`、`ModuleResolver`、`RealPath` 各自实现）
- 编码转换（UTF-8 / WTF-8 / UTF-16 的转换分支）
- 位置换算（字节偏移、行号、列号在 Text / Mapping / Diagnostics 各自实现）
- 诊断构造与排序
- 节点遍历骨架（多个 Visitor / Walker）

判定标准：同一输入是否可能得到不同结果。会分叉的是缺陷，只是复制的是维护成本。

### 4. 巨型类

按行数排序，列出 > 1000 行的类。对每个判断是否有天然的职责切分点，以及切分是否会触碰关系调用链（触则不做，见 master R1）。

### 5. 死代码

用 `roslyn_find_unused_code` 或等价手段找零引用的类型、方法、字段。注意两条陷阱：

- Compatibility 台架通过字符串旗标（`--xxx-safety`）间接引用，静态分析看不出
- 反射或 AOT 保留特性可能让代码实际可达

每条死代码标注「确认无引用」还是「疑似但需人工确认」。

### 6. 可测性障碍

找直接调用 `DateTime.Now` / `DateTimeOffset.UtcNow` / `File.*` / `Directory.*` / `Environment.*` / `Random` / `Guid.NewGuid` 的站点。这些让确定性测试不可写。按调用点数量与风险排序，不要求全改，只给清单。

### 7. 配置面

本仓只有 5 个 `TSHARP_*` 旋钮：`TSHARP_EMIT_CONCURRENCY`、`TSHARP_EMIT_ORDER`、`TSHARP_EMIT_SEGMENTS`、`TSHARP_PARSE_CONCURRENCY`、`TSHARP_STARTUP_TRACE`。逐个核对：是否有文档、是否有测试、默认值是否与 ledger 记录一致、是否有已废弃未删的。

## 输出

1. 依赖图（Mermaid）+ 违规边清单
2. 公开面问题表（三类分开）
3. 重复实现对照表（语义 × 实现处 × 是否会分叉）
4. 巨类清单（行数、职责、切分建议、风险）
5. 死代码清单（带确认等级）
6. 可测性障碍清单（按调用点聚合）
7. 配置面核对表

## 边界

只读。架构改动的提案必须带「改动面文件数 + 是否触碰关系调用链 + 门禁能否验证」三栏，缺一栏不许提。
