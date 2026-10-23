// 逐字节产物门禁（仓内夹具版）：对 8 个夹具各跑一次全量构建，记录退出码、stdout 哈希
// 与发射文件（.js/.d.ts/.map）哈希；可选与既有记录对比。tsbuildinfo 与源码树不参与比较。
// errdense 把 5000 行诊断文本纳入 stdout 哈希；errdense-clean 是其 clean 双胞胎；
// tiny512/small3 是 noEmit，改跑 --listFiles，让文件图进入 stdout 哈希（此前只看退出码）。
// 用法：
//   node csharp/tools/perf-verify.mjs --label <标签> --binary <构建输出目录> [--compare <标签>] [--directory <dir>]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { root } from "./common.mjs";

const option = name => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
};
const directory = path.resolve(option("--directory") ?? path.join(root, "built/csharp/perf-fresh"));
const label = option("--label");
const binaryDirectory = option("--binary");
const compareLabel = option("--compare");
if (!label || !binaryDirectory) {
    console.error("usage: node csharp/tools/perf-verify.mjs --label <label> --binary <build-output-dir> [--compare <label>] [--directory <dir>]");
    process.exit(1);
}

const specs = ["medium", "huge", "tiny512", "dtsheavy", "small3", "longline", "errdense", "errdense-clean"];
const noEmit = new Set(["tiny512", "small3"]);
const sha = data => createHash("sha256").update(data).digest("hex");
const exe = process.platform === "win32" ? "tsgo-cs.exe" : "tsgo-cs";
const binary = path.resolve(binaryDirectory, exe);
const fixtures = path.join(directory, "fixtures");

function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

function run(name) {
    const target = path.join(directory, "verify", label, name);
    if (existsSync(target)) throw new Error(`target exists, pick a new label: ${target}`);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(fixtures, name), target, { recursive: true });
    for (const file of readdirSync(target)) if (file.endsWith(".tsbuildinfo")) rmSync(path.join(target, file), { force: true });
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ["--project", ".", "--pretty", "false", ...(noEmit.has(name) ? ["--listFiles"] : [])], {
            cwd: target,
            env: { ...process.env, DOTNET_gcServer: "0", DOTNET_GCgen0size: "0x400000", DOTNET_GCLOHThreshold: "1000000" },
            windowsHide: true,
        });
        child.stdin.end();
        const out = [], err = [];
        child.stdout.on("data", chunk => out.push(chunk));
        child.stderr.on("data", chunk => err.push(chunk));
        child.on("error", reject);
        child.on("close", code => {
            const stdout = Buffer.concat(out);
            writeFileSync(path.join(target, "run.log"), stdout);
            writeFileSync(path.join(target, "run.err"), Buffer.concat(err));
            // --listFiles prints absolute paths that contain the label; normalize before hashing
            // so a baseline recorded under one label stays comparable under another.
            const normalized = stdout.toString().split(target).join("<target>")
                .split(target.replaceAll("\\", "/")).join("<target>");
            const artifacts = {};
            for (const file of walk(target)) {
                const rel = path.relative(target, file).split(path.sep).join("/");
                if (rel.startsWith("src/") || rel === "tsconfig.json" || rel.includes("tsbuildinfo") || rel === "run.log" || rel === "run.err") continue;
                artifacts[rel] = sha(readFileSync(file));
            }
            resolve({ name, exit: code, stdout: sha(normalized), artifacts });
        });
    });
}

const results = [];
for (const name of specs) results.push(await run(name));
writeFileSync(path.join(directory, "verify", `${label}.json`), JSON.stringify({ label, binary, results }, null, 2));
console.log(`recorded ${path.join(directory, "verify", `${label}.json`)}`);
for (const r of results) console.log(`  ${r.name}: exit ${r.exit}, ${Object.keys(r.artifacts).length} artifacts`);

if (compareLabel) {
    const base = JSON.parse(readFileSync(path.join(directory, "verify", `${compareLabel}.json`), "utf8"));
    let failures = 0;
    for (const r of results) {
        const b = base.results.find(x => x.name === r.name);
        if (!b) { console.log(`DIFF ${r.name}: missing baseline`); failures++; continue; }
        if (b.exit !== r.exit) { console.log(`DIFF ${r.name}: exit ${b.exit} -> ${r.exit}`); failures++; }
        if (b.stdout !== r.stdout) { console.log(`DIFF ${r.name}: stdout differs`); failures++; }
        for (const name of new Set([...Object.keys(b.artifacts), ...Object.keys(r.artifacts)])) {
            if (b.artifacts[name] !== r.artifacts[name]) { console.log(`DIFF ${r.name}: ${name} differs`); failures++; }
        }
    }
    console.log(failures === 0 ? `BYTECHECK-OK (${compareLabel} == ${label})` : `BYTECHECK-FAIL: ${failures} differences`);
    process.exitCode = failures === 0 ? 0 : 1;
}
