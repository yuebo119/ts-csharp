> **元数据** ｜ 类型: audit ｜ 日期: 2026-10-08 ｜ 轮次: r03 ｜ 主题: build-shape
> 涉及 git 节点: `6ed638d3a5` / `c929d92b44` ｜ 数据来源: `bench/AB36`、`bench/AB37`
> 状态: 有效 ｜ 结论: 产品形态为不内嵌 lib；误用内嵌形态制造 +3.5~4% 启动假象
# 审计：构建形态（产品形态 vs 内嵌形态）

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-08 |
| 轮次 | r03 |
| 主题 | 构建形态对性能与可测性的影响 |
| 涉及 git 节点 | `6ed638d3a5`（基线）、`c929d92b44`（最新代码） |
| 数据来源 | `bench/AB36-noembed-vs-embed`、`bench/AB37-final7-noembed-vs-baseline`；`bench/*/summary.json` 的 `binaries.sha256` |
| 结论 | **此前"最新"构建形态错误（误开 lib 内嵌），凭空制造 +3.5~4% 启动回退；产品形态必须用 `package.mjs` 的参数** |

---

## 1. 事实：仓库内三处口径不一致

| 位置 | 设置 | 含义 |
| --- | --- | --- |
| `csharp/src/TypeScript.Compiler/TypeScript.Compiler.csproj:5` | `<EmbedTypeScriptLibraries Condition="'$(EmbedTypeScriptLibraries)' == ''">true</EmbedTypeScriptLibraries>` | **默认内嵌** |
| `csharp/tools/package.mjs:75` | `-p:EmbedTypeScriptLibraries=false` | **产品打包不内嵌** |
| `csharp/tools/product.mjs:28` | `-p:EmbedTypeScriptLibraries=false` | 同上 |
| `docs/csharp-extreme-optimization-results.md:305` | 建议"重新开启内嵌" | 与打包脚本矛盾 |

`EmbedTypeScriptLibraries=true` 时，108 个 `lib.*.d.ts` 作为 `EmbeddedResource` 编进程序集（`TypeScript.Compiler.csproj:16`）；`false` 时作为 `Content` 复制到输出目录（第 17 行）。

## 2. 影响：镜像体积

| 构建 | 参数 | 镜像体积 |
| --- | --- | ---: |
| 基线 `naot-svr` | 不内嵌 | 28.20 MB |
| `final7`（我方测量所用） | **内嵌（默认）** | **33.15 MB** |
| `final7-noembed`（产品形态） | `-p:EmbedTypeScriptLibraries=false` | **27.98 MB** |

内嵌 = **+5.17 MB**；而我的代码改动本身使镜像**减少约 0.22 MB**（27.98 vs 28.20 MB）。

## 3. 实测：AB36（同代码、同 GC，仅切换内嵌；噪声 17.6%，11 组）

| 负载 | 内嵌 (ms) | 不内嵌 (ms) | 比值（不内嵌÷内嵌） | 95% CI |
| --- | ---: | ---: | ---: | --- |
| version | 52.7 | 50.8 | **0.965×** | 0.948–0.975 |
| empty-project | 56.2 | 54.4 | **0.968×** | 0.956–0.984 |
| help | 52.9 | 52.4 | 0.990× | 0.958–1.012 |
| medium | 159.1 | 152.4 | 0.958× | 0.940–1.023 |
| huge-file | 1,151.4 | 1,123.5 | 0.976× | 0.958–1.004 |
| tiny-files-noemit | 131.1 | 130.3 | 0.994× | 0.976–1.006 |
| small-first-diagnostic | 64.8 | 66.9 | **1.031×** | 1.009–1.047 |
| project-references-implementation | 69.2 | 71.9 | **1.038×** | 1.018–1.048 |
| project-references-config | 68.9 | 70.6 | **1.025×** | 1.007–1.039 |

**结论**：内嵌使**纯启动类负载慢 3.5%（version）/3.2%（empty）**，但在需要定位 lib 的编译负载上反而快 2.5~3.8%（内嵌免去文件系统定位/读取）。

## 4. 连带影响：修正后的基线对比

| 批次 | 形态 | help 改善 | version 改善 | 全部 23 项 |
| --- | --- | ---: | ---: | --- |
| AB34（错误形态） | 最新=内嵌、基线=不内嵌 | −4.6% | −3.1% | 11/23 改善、平均 +11.6% |
| **AB37（正确形态）** | 两侧均不内嵌 | **−0.1%** | **−0.3%** | **11/23 改善、平均 +13.4%** |

即：**"启动回退"是构建形态造成的测量假象**，并非代码回退。

## 5. 处置建议

1. **固化产品形态**：所有对比产物一律用 `package.mjs` 的参数构建，并把 `embedTypeScriptLibraries` 写入 harness manifest 以便审计。
2. **若要内嵌（自包含分发）**：必须改为**懒加载**——仅在请求某个 `lib.X.d.ts` 时才解包，且 `--version`/`--help` 路径不得触碰任何 lib 资源；否则每次进程启动固定付出 3.5~4%。
3. **修正文档矛盾**：`docs/csharp-extreme-optimization-results.md:305` 的"重新开启内嵌"建议需注明"须配懒加载"，或与打包脚本对齐为不内嵌。

## 6. 复现

```powershell
# 内嵌形态（默认）
dotnet publish csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj -c Release -r win-x64 `
  -p:PublishAot=true -p:TypeScriptExecutableName=tsc -o <out-embed>

# 产品形态
dotnet publish csharp/src/TypeScript.CommandLine/TypeScript.CommandLine.csproj -c Release -r win-x64 `
  -p:PublishAot=true -p:EmbedTypeScriptLibraries=false -p:TypeScriptExecutableName=tsc -o <out-product>

# 配对 A/B（两侧同为 C#，隔离内嵌效果）
node tools/perf-cli.mjs --manifest manifests/final7-noembed.json `
  --go-executable pkgs/final7/lib/tsc.exe --samples 11 `
  --filter "^(help|version|empty-project|medium|huge-file)$" --directory bench/AB36-noembed-vs-embed
```

