// 独立仓库的 safety 套件驱动：镜像 product.mjs testCompiler 的旗标枚举，
// 逐个运行 Compatibility 旗标与 --content-mappers，失败集合必须落在文档基线内
// （docs/csharp-perf-report-r15/r17 与 docs/csharp-perf-audit-epsl-1.md 的口径）。
// 基线外的失败 = 门禁红。用法：node csharp/tools/run-safety-suite.mjs [--harness <dll>]
import { access, mkdtemp, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { root } from "./common.mjs";

const option = name => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
};

// 文档记载的已知失败基线：npm-process-safety 属环境不稳定类（重试可过）。
// program-emit 与 checker-relation-context 在 2026-10-22 修复后转绿，不再基线化。
const baseline = new Set(["--npm-process-safety"]);

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
    ...[...source.matchAll(/args is \[var \w+, var \w+\] && \w+ == "(--[^"]+-safety)"u8/g)].map(match => match[1]),
])];
// Two-argument safety flags take a writable directory (watch directory / profile directory);
// the enumerator supplies a fresh temp one so they run instead of falling through to the
// generic usage branch (round-3 audit F-003-01).
const twoArgument = new Set(
    [...source.matchAll(/args is \[var \w+, var \w+\] && \w+ == "(--[^"]+-safety)"u8/g)].map(match => match[1]));
const scratch = await mkdtemp(path.join(os.tmpdir(), "safety-suite-"));
const only = option("--only");
const recordFloors = process.argv.includes("--record-floors");
const floorsPath = path.join(root, "csharp/tools/safety-floors.json");
let floors = {};
try { floors = JSON.parse(await readFile(floorsPath, "utf8")); } catch { /* first run / recording */ }
const selected = only ? tests.filter(test => test === only) : tests;
if (only && selected.length === 0) { console.error(`unknown safety flag: ${only}`); process.exit(1); }
console.log(`safety flags enumerated: ${tests.length} (${twoArgument.size} take a directory argument)${only ? `; running ${only}` : ""}`);

const run = args => new Promise(resolve => {
    const child = spawn("dotnet", [harness, ...args], { cwd: root, windowsHide: true });
    child.stdin.end();
    const out = [], err = [];
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.on("close", code => resolve({ code, out: Buffer.concat(out).toString(), err: err.join("") }));
});

const observed = {};
let pass = 0;
const failed = [];
for (const test of selected) {
    const args = twoArgument.has(test) ? [test, scratch] : [test];
    const { code, out } = await run(args);
    let assertions = null;
    for (const match of out.matchAll(/(\d+) assertions/g)) assertions = Number(match[1]);
    if (assertions !== null) observed[test] = assertions;
    let ok = code === 0;
    if (ok && assertions !== null && floors[test] !== undefined && assertions < floors[test]) {
        console.error(`ASSERTION FLOOR: ${test} produced ${assertions}, expected at least ${floors[test]}`);
        ok = false;
    }
    if (ok) pass++;
    else failed.push(test);
}
if (recordFloors) {
    writeFileSync(floorsPath, JSON.stringify(observed, null, 2) + "\n");
    console.log(`recorded ${Object.keys(observed).length} assertion floors to ${floorsPath}`);
}

const contentMappers = await run(["--content-mappers", root]);
console.log(`safety: ${pass}/${selected.length} pass; failures: ${failed.join(" ") || "(none)"}`);
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
