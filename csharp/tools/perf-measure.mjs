// 确定性测量：对指定夹具在全新副本中跑一次全量构建（或增量空转的第二轮），
// 采集分阶段时间/分配（--extendedDiagnostics）与进程总量；多二进制多次采样输出 JSON 行。
// 用法：
//   node csharp/tools/perf-measure.mjs --fixture <name> --binary <dir> [--binary <dir2> ...] [--runs 3] [--mode full|noop] [--directory <dir>] [-- <额外 CLI 参数>]
import { cpSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "./common.mjs";

const argv = process.argv.slice(2);
const option = name => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
};
const values = name => argv.reduce((acc, arg, i) => (arg === name ? [...acc, argv[i + 1]] : acc), []);
const directory = path.resolve(option("--directory") ?? path.join(root, "built/csharp/perf-fresh"));
const fixture = option("--fixture");
const binaries = values("--binary");
const runs = Number(option("--runs") ?? 3);
const mode = option("--mode") ?? "full";
const separator = argv.indexOf("--");
const extra = separator < 0 ? [] : argv.slice(separator + 1);
if (!fixture || binaries.length === 0) {
    console.error("usage: node csharp/tools/perf-measure.mjs --fixture <name> --binary <dir> [--binary <dir2>] [--runs N] [--mode full|noop] [--directory <dir>] [-- <extra args>]");
    process.exit(1);
}

const exe = process.platform === "win32" ? "tsgo-cs.exe" : "tsgo-cs";
const env = { ...process.env, DOTNET_gcServer: "0", DOTNET_GCgen0size: "0x400000", DOTNET_GCLOHThreshold: "1000000" };
const runId = `${process.pid}-${Date.now()}`;
let counter = 0;

function measure(binaryDirectory) {
    const target = path.join(directory, "timing", `${runId}-${counter++}`);
    mkdirSync(target, { recursive: true });
    cpSync(path.join(directory, "fixtures", fixture), target, { recursive: true, force: true });
    const binary = path.resolve(binaryDirectory, exe);
    if (mode === "noop") {
        const warm = spawnSync(binary, ["--project", ".", "--pretty", "false", ...extra], { cwd: target, env, windowsHide: true });
        if (warm.status !== 0) throw new Error(`warmup failed: ${warm.status}`);
    }
    const r = spawnSync(binary, ["--project", ".", "--pretty", "false", "--extendedDiagnostics", ...extra], { cwd: target, env, windowsHide: true });
    if (r.status === null) throw new Error("spawn failed");
    const text = r.stdout.toString();
    const pick = key => {
        const line = text.split(/\r?\n/).find(l => l.startsWith(key + ":"));
        return line ? line.slice(line.indexOf(":") + 1).trim() : "(missing)";
    };
    return {
        exit: r.status,
        checkAlloc: pick("Alloc check (summed)"),
        emitAlloc: pick("Alloc emit (summed)"),
        totalAlloc: pick("CLR allocated bytes"),
        checkTime: pick("Check time (summed)"),
        emitTime: pick("Emit time (summed)"),
        totalTime: pick("Total time"),
        types: pick("Types"),
    };
}

for (const binary of binaries) {
    const results = [];
    for (let i = 0; i < runs; i++) results.push(measure(binary));
    console.log(binary, JSON.stringify(results));
}
