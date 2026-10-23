// Incremental byte gate: one full build followed by three deterministic edits. Each round keeps
// the previous output and tsbuildinfo so the compiler takes its incremental path; emitted files
// are hashed per round and compared against a recorded baseline. tsbuildinfo is checked for
// existence and size (it embeds absolute paths, so its bytes are not portable across labels).
//   node csharp/tools/perf-verify-incremental.mjs --label <label> --binary <build-output-dir> [--compare <label>]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
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
    console.error("usage: node csharp/tools/perf-verify-incremental.mjs --label <label> --binary <build-output-dir> [--compare <label>]");
    process.exit(1);
}

const fixture = path.join(directory, "fixtures", "editbig");
const target = path.join(directory, "verify", label, "editbig-incremental");
if (existsSync(target)) throw new Error(`target exists, pick a new label: ${target}`);
mkdirSync(path.dirname(target), { recursive: true });
cpSync(fixture, target, { recursive: true });
for (const file of readdirSync(target)) if (file.endsWith(".tsbuildinfo")) rmSync(path.join(target, file), { force: true });

const exe = process.platform === "win32" ? "tsgo-cs.exe" : "tsgo-cs";
const binary = path.resolve(binaryDirectory, exe);
const sha = data => createHash("sha256").update(data).digest("hex");
function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const editFile = path.join(target, "src", "f0.ts");
const original = readFileSync(editFile, "utf8");
function run(round) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ["--project", ".", "--pretty", "false"], { cwd: target, windowsHide: true });
        child.stdin.end();
        const out = [], err = [];
        child.stdout.on("data", chunk => out.push(chunk));
        child.stderr.on("data", chunk => err.push(chunk));
        child.on("error", reject);
        child.on("close", code => {
            const artifacts = {};
            for (const file of walk(target)) {
                const rel = path.relative(target, file).split(path.sep).join("/");
                if (rel === "tsconfig.json" || rel.startsWith("src/") || rel.includes("tsbuildinfo")) continue;
                artifacts[rel] = sha(readFileSync(file));
            }
            const buildInfo = readdirSync(target).find(file => file.endsWith(".tsbuildinfo"));
            resolve({
                round, exit: code, stdout: sha(Buffer.concat(out)),
                artifacts,
                buildInfo: buildInfo ? { name: buildInfo, size: statSync(path.join(target, buildInfo)).size } : null,
            });
        });
    });
}

const results = [];
results.push(await run(0));
for (let round = 1; round <= 3; round++) {
    writeFileSync(editFile, `${original}\nexport const __incrementalGateRound${round} = ${round};\n`);
    results.push(await run(round));
}
writeFileSync(path.join(directory, "verify", `${label}.json`), JSON.stringify({ label, binary, results }, null, 2));
for (const result of results) {
    console.log(`  round ${result.round}: exit ${result.exit}, ${Object.keys(result.artifacts).length} artifacts, buildinfo ${result.buildInfo?.size ?? "missing"}`);
}

if (compareLabel) {
    const base = JSON.parse(readFileSync(path.join(directory, "verify", `${compareLabel}.json`), "utf8"));
    let failures = 0;
    for (const result of results) {
        const baseline = base.results.find(item => item.round === result.round);
        if (!baseline) { console.log(`DIFF round ${result.round}: missing baseline`); failures++; continue; }
        if (baseline.exit !== result.exit) { console.log(`DIFF round ${result.round}: exit ${baseline.exit} -> ${result.exit}`); failures++; }
        if (baseline.stdout !== result.stdout) { console.log(`DIFF round ${result.round}: stdout differs`); failures++; }
        for (const file of new Set([...Object.keys(baseline.artifacts), ...Object.keys(result.artifacts)])) {
            if (baseline.artifacts[file] !== result.artifacts[file]) { console.log(`DIFF round ${result.round}: ${file}`); failures++; }
        }
        if (!result.buildInfo) { console.log(`DIFF round ${result.round}: no tsbuildinfo`); failures++; }
    }
    console.log(failures === 0 ? `INCREMENTAL-OK (${compareLabel} == ${label})` : `INCREMENTAL-FAIL: ${failures} differences`);
    process.exitCode = failures === 0 ? 0 : 1;
}