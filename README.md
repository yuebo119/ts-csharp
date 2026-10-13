# typescript-csharp

TypeScript 编译器的 C#/.NET 11 移植与性能战役仓库，完全独立。

本仓库自 hez2010/TypeScript（fork 自 microsoft/TypeScript）的 `f29aeb9f825d` 处独立，
git 历史仅保留 C# 工作的 260 个提交（作者、日期与提交信息逐字保留）；
上游 TypeScript/JavaScript 源码与 Go 实现的历史不在本仓库，需要时查原仓库归档。

## 构建

```bash
cd csharp
dotnet build TypeScript.slnx -c Release   # 门禁：0 警告 0 错误
```

产品发布（NativeAOT）：

```bash
dotnet publish csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj -c Release -r win-x64 \
  -p:PublishAot=true -p:TypeScriptExecutableName=tsc -p:EmbedTypeScriptLibraries=false -p:UseSharedCompilation=false
```

## 性能工程（EPSL）

- `perf-budgets.md`：性能门禁阈值单一事实源
- `.ai/perf-ledger.md`：勿重开清单与明确不做表，提性能建议前必查
- `docs/csharp-perf-method.md`：测量协议（配对 A/B、三类可比量分级）
- 轮次文档：`docs/csharp-perf-{plan|report}-rXX.md`
- 测量基建设在仓外 `C:\ai\projects\tsbench`，不含在本仓库

## 已知边界

- `csharp/external/tsc/` 的内嵌数据（108 个 lib.d.ts、13 个本地化诊断 json.gz）
  复制自原仓库 `tsc/` 树（Apache-2.0，出处见 `LICENSE.txt` / `NOTICE.txt`）。
- `csharp/oracle/` 与 `csharp/tools/` 中的 Node 再生成脚本引用原 monorepo 的
  `tsc/`、根 Node 工作区与本地 git 历史，在本仓库不可用；
  产品构建（dotnet）不经过它们。
- `.github/workflows/csharp.yml` 保留原样；其 `npm ci` / hereby 步骤面向原
  monorepo 设计，在本仓库运行前需改造。
