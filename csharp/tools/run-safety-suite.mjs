// 独立仓库的 safety 套件驱动：镜像 product.mjs testCompiler 的旗标枚举，
// 逐个运行 Compatibility 旗标与 --content-mappers，失败集合必须落在文档基线内
// （docs/csharp-perf-report-r15/r17 与 docs/csharp-perf-audit-epsl-1.md 的口径）。
// 基线外的失败 = 门禁红。用法：node csharp/tools/run-safety-suite.mjs [--harness <dll>]
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { root } from "./common.mjs";

const option = name => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
};

// 文档记载的已知失败基线：npm-process-safety 属环境不稳定类（重试可过）。
const baseline = new Set(["--checker-relation-context-safety", "--program-emit-safety", "--npm-process-safety"]);

// 仓内构建产物路径（旧外仓布局 built/csharp/build/... 已不存在）。
const harness = option("--harness")
    ?? path.join(root, "csharp/tests/TypeScript.Compatibility/bin/Release/net11.0/TypeScript.Compatibility.dll");
try {
    await access(harness);
} catch {
    console.error(`harness not found: ${harness}\n先构建：dotnet build csharp/TypeScript.slnx -c Release（或显式传 --harness）`);
    process.exit(1);
}
const source = await readFile(path.join(root, "csharp/tests/TypeScript.Compatibility/Program.cs"), "utf8");
const tests = [...new Set([
    ...[...source.matchAll(/args\.Length == 1 && args\[0\] == "(--[^"]+-safety)"u8/g)].map(match => match[1]),
    ...[...source.matchAll(/args is \[var \w+\] && \w+ == "(--[^"]+-safety)"u8/g)].map(match => match[1]),
])];
console.log(`safety flags enumerated: ${tests.length}`);

const run = args => new Promise(resolve => {
    const child = spawn("dotnet", [harness, ...args], { cwd: root, windowsHide: true });
    child.stdin.end();
    const err = [];
    child.stderr.on("data", chunk => err.push(chunk));
    child.on("close", code => resolve({ code, err: err.join("") }));
});

let pass = 0;
const failed = [];
for (const test of tests) {
    const { code } = await run([test]);
    if (code === 0) pass++;
    else failed.push(test);
}

const contentMappers = await run(["--content-mappers", root]);
console.log(`safety: ${pass}/${tests.length} pass; failures: ${failed.join(" ") || "(none)"}`);
console.log(`content-mappers: exit ${contentMappers.code}`);

const outOfBaseline = failed.filter(test => !baseline.has(test));
if (outOfBaseline.length) {
    console.error(`OUT-OF-BASELINE FAILURES: ${outOfBaseline.join(" ")}`);
    process.exitCode = 1;
}
if (contentMappers.code !== 0) {
    console.error(`content-mappers failed: ${contentMappers.err.slice(0, 800)}`);
    process.exitCode = 1;
}
if (!process.exitCode) console.log(`SUITE-OK (failures within documented baseline)`);
