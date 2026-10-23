// Architecture gate (deterministic, source-level): freezes the current cross-directory
// dependency edges and hand-written public type surface, and rejects new debt.
//   node csharp/tools/architecture-check.mjs            # check
//   node csharp/tools/architecture-check.mjs --record   # refresh the baseline
// Scope: csharp/src/TypeScript.Compiler. Edges are `using TypeScript.Compiler.<Dir>` directives;
// fully-qualified references without a using are not seen (documented limitation).
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { root } from "./common.mjs";

const compilerRoot = resolve(root, "csharp/src/TypeScript.Compiler");
const baselinePath = resolve(root, "csharp/tools/architecture-baseline.json");
const record = process.argv.includes("--record");
const otherSourceRoots = readdirSync(resolve(root, "csharp/src"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "TypeScript.Compiler" && entry.name !== "TypeScript.CommandLine")
    .map(entry => resolve(root, "csharp/src", entry.name));
const commandLineRoot = resolve(root, "csharp/src/TypeScript.CommandLine");

const dirs = readdirSync(compilerRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "bin" && entry.name !== "obj")
    .map(entry => entry.name);
const topLevel = new Set(dirs);

function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "bin" && entry.name !== "obj") walk(full, out); }
        else if (entry.name.endsWith(".cs")) out.push(full);
    }
    return out;
}

// Directories that must never be referenced by the lower layers. Configuration is exempt for
// Text: Utf8StringJsonConverter is the single JSON writer that lives with the string type.
const forbidden = {
    Text: new Set(["Ast", "Syntax", "Binding", "Checking", "Semantics", "Emission", "Programs", "Projects",
        "Incremental", "Execution", "LanguageServices", "LanguageServer", "Api", "Diagnostics", "Resolution", "Hosts"]),
    Storage: new Set(["Checking", "Semantics", "Emission", "Programs", "Projects", "Incremental", "Execution",
        "LanguageServices", "LanguageServer", "Api"]),
    Semantics: new Set(["Binding", "Checking", "Emission", "Programs", "Projects", "Incremental", "Execution",
        "LanguageServices", "LanguageServer", "Api"]),
};

const edges = new Map(); // "From->To" -> Set(relative file)
const publicTypes = new Map(); // full name -> relative file
const namespaceOf = new Map();
for (const file of walk(compilerRoot)) {
    const rel = relative(compilerRoot, file).replaceAll("\\", "/");
    const top = rel.includes("/") ? rel.split("/")[0] : ".";
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/using\s+TypeScript\.Compiler\.([A-Za-z0-9_]+)/g)) {
        const target = match[1];
        if (!topLevel.has(target) || target === top) continue;
        const key = `${top}->${target}`;
        if (!edges.has(key)) edges.set(key, new Set());
        edges.get(key).add(rel);
    }
    if (rel.endsWith(".generated.cs")) continue;
    const namespaceMatch = /namespace\s+([A-Za-z0-9_.]+)\s*[;{]/.exec(text);
    const ns = namespaceMatch?.[1] ?? "";
    for (const match of text.matchAll(/^\s*public\s+(?:(?:sealed|abstract|static|partial|readonly|ref|unsafe)\s+)*(class|record|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
        const full = ns ? `${ns}.${match[2]}` : match[2];
        publicTypes.set(full, rel);
    }
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { edges: [], publicTypes: [], allowPublic: [] };
if (record) {
    writeFileSync(baselinePath, JSON.stringify({
        edges: [...edges.keys()].sort(),
        publicTypes: [...publicTypes.keys()].sort(),
        allowPublic: baseline.allowPublic ?? [],
    }, null, 2) + "\n");
    console.log(`recorded ${edges.size} edges and ${publicTypes.size} public types to ${baselinePath}`);
}

const problems = [];
const knownEdges = new Set(baseline.edges);
const knownPublic = new Set(baseline.publicTypes);
const allowedPublic = new Set(baseline.allowPublic ?? []);
for (const [key, files] of edges) {
    if (!knownEdges.has(key)) problems.push(`new dependency edge ${key} (${[...files].slice(0, 3).join(", ")})`);
}
for (const [from, targets] of Object.entries(forbidden)) {
    for (const target of targets) {
        const key = `${from}->${target}`;
        if (edges.has(key)) problems.push(`forbidden bottom-up edge ${key}`);
    }
}

const otherText = [...walk(commandLineRoot), ...otherSourceRoots.flatMap(dir => walk(dir))]
    .map(file => readFileSync(file, "utf8")).join("\n");
for (const [full, file] of publicTypes) {
    if (knownPublic.has(full) || allowedPublic.has(full)) continue;
    const name = full.split(".").pop();
    const usedOutside = new RegExp(`\\b${name}\\b`).test(otherText);
    if (usedOutside) {
        console.log(`new public type ${full} is referenced outside the compiler assembly; add it to allowPublic after review`);
        problems.push(`new public type ${full} (${file}) needs an explicit baseline entry`);
    } else
        problems.push(`new public type ${full} (${file}) has no cross-assembly use; make it internal`);
}
if (record) {
    console.log(`baseline refreshed; rerun without --record to check.`);
    process.exit(0);
}
if (problems.length !== 0) {
    console.error(`ARCHITECTURE-FAIL: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
}
console.log(`ARCHITECTURE-OK (${edges.size} edges, ${publicTypes.size} hand-written public types)`);