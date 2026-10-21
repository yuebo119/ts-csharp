// 性能验证夹具生成器：在 <directory>/fixtures 下生成 10 个负载夹具。
// 形状与官方 harness 同构（medium 64x24、huge 单文件、tiny-files 512、增量空转、
// 声明密集、错误密集 + clean 双胞胎、单行巨行、单点巨类型、跨文件泛型链）。
// 仅生成源码树，不含构建产物。
// 用法：node csharp/tools/perf-fixtures.mjs [--directory <dir>]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root } from "./common.mjs";

const option = name => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
};
const directory = path.resolve(option("--directory") ?? path.join(root, "built/csharp/perf-fresh"));
const fixtures = path.join(directory, "fixtures");
rmSync(fixtures, { recursive: true, force: true });

function write(rel, content) {
    const file = path.join(fixtures, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
}
const tsconfig = (options, include) => JSON.stringify({ compilerOptions: options, include }, null, 2) + "\n";

// ---- medium: 64 files x 24 interfaces, cross-file imports; emit + declaration + sourceMap + incremental
{
    const N = 64, IFACES = 24;
    for (let i = 0; i < N; i++) {
        const next = (i + 1) % N, other = (i * 7 + 3) % N;
        const lines = [];
        const hasBase = i + 1 < N;
        if (other === next) lines.push(`import type { I${next}_0, I${next}_1, I${next}_2 } from "./f${next}";`);
        else {
            lines.push(`import type { I${next}_0, I${next}_1 } from "./f${next}";`);
            lines.push(`import type { I${other}_2 } from "./f${other}";`);
        }
        lines.push("");
        for (let k = 0; k < IFACES; k++) {
            const ext = hasBase && k === 0 ? ` extends I${next}_0` : hasBase && k === 1 ? ` extends I${next}_1` : "";
            lines.push(`export interface I${i}_${k}${ext} {`);
            lines.push(`  kind: string;`);
            lines.push(`  value: number;`);
            lines.push(`  label?: string;`);
            lines.push(`  ref: I${other}_2 | null;`);
            lines.push(`  map: Record<string, I${i}_${(k + 1) % IFACES}>;`);
            if (k !== 0) lines.push(`  parent: I${i}_0;`);
            lines.push(`}`);
        }
        lines.push("");
        lines.push(`export function make${i}(seed: number): I${i}_0 {`);
        lines.push(`  const out = { kind: "k", value: seed, label: "x", ref: null, map: {}, parent: null as never } as I${i}_0;`);
        lines.push(`  return out;`);
        lines.push(`}`);
        lines.push(`export function use${i}(input: I${i}_0, other: I${other}_2): number {`);
        lines.push(`  if (input.kind === "k") return input.value + other.value;`);
        lines.push(`  return input.value;`);
        lines.push(`}`);
        write(`medium/src/f${i}.ts`, lines.join("\n") + "\n");
    }
    write("medium/src/main.ts", `import { make0, use0 } from "./f0";
import { I3_2 } from "./f3";
const v: number = use0(make0(1), { kind: "k", value: 2, label: "l", ref: null, map: {}, parent: make0(3) });
console.log(v);
`);
    write("medium/tsconfig.json", tsconfig({
        strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", types: [], rootDir: "src",
        outDir: "out", declaration: true, sourceMap: true, incremental: true,
    }, ["src/**/*.ts"]));
}

// ---- huge: one file, 16384 object literals in a single array
{
    const parts = ["export interface Item { id: number; name: string; ok: boolean; tags: string[]; }", "export const items: Item[] = ["];
    for (let i = 0; i < 16384; i++) {
        parts.push(`  {`);
        parts.push(`    id: ${i},`);
        parts.push(`    name: "item-${i}",`);
        parts.push(`    ok: ${i % 2 === 0 ? "true" : "false"},`);
        parts.push(`    tags: ["a", "b"],`);
        parts.push(`  },`);
    }
    parts.push("];");
    write("huge/src/big.ts", parts.join("\n") + "\n");
    write("huge/tsconfig.json", tsconfig({
        strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", types: [], rootDir: "src",
        outDir: "out", sourceMap: true,
    }, ["src/**/*.ts"]));
}

// ---- tiny512: 512 small files chained by imports
for (let i = 0; i < 512; i++) {
    const next = (i + 1) % 512;
    write(`tiny512/src/t${i}.ts`, `import { v${next} } from "./t${next}";\nexport const v${i}: number = ${i} + (${i === 511 ? "0" : "v" + next});\nexport function f${i}(x: number): number { return x + v${i}; }\n`);
}
write("tiny512/tsconfig.json", tsconfig({
    strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", noEmit: true, types: [], rootDir: "src",
}, ["src/**/*.ts"]));

// ---- inc512: 512 tiny files with incremental state (no-op round shape)
for (let i = 0; i < 512; i++) {
    const next = (i + 1) % 512;
    write(`inc512/src/t${i}.ts`, `import { v${next} } from "./t${next}";\nexport const v${i}: number = ${i} + (${i === 511 ? "0" : "v" + next});\nexport function f${i}(x: number): number { return x + v${i}; }\n`);
}
write("inc512/tsconfig.json", tsconfig({
    strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", types: [], rootDir: "src",
    outDir: "out", incremental: true,
}, ["src/**/*.ts"]));

// ---- dtsheavy: 150 declaration files with generics + one consumer
for (let i = 0; i < 150; i++) {
    const d = i * 3 + 1;
    const lines = [];
    if (i > 0) lines.push(`import type { Mapped${d % 150} } from "./d${d % 150}";`);
    lines.push(`export interface Shape${i}<T extends string = "x"> {`);
    lines.push(`  key: T;`);
    lines.push(`  value: number;`);
    lines.push(`  nested: Shape${i}<"y"> | null;`);
    if (i > 0) lines.push(`  dep: Mapped${d % 150} | undefined;`);
    lines.push(`}`);
    lines.push(`export type Mapped${i} = { [K in keyof Shape${i}]: Shape${i}[K] };`);
    lines.push(`export declare function pick${i}<K extends keyof Shape${i}>(item: Shape${i}, key: K): Shape${i}[K];`);
    write(`dtsheavy/src/d${i}.d.ts`, lines.join("\n") + "\n");
}
write("dtsheavy/src/consumer.ts", `import type { Shape0 } from "./d0";
import type { Mapped1 } from "./d1";
export const use: Mapped1 | null = null;
export function read(item: Shape0): string { return item.key; }
`);
write("dtsheavy/tsconfig.json", tsconfig({
    strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", types: [], rootDir: "src",
    outDir: "out", declaration: true,
}, ["src/**/*.ts", "src/**/*.d.ts"]));

// ---- mapped1: one file, 400-member interface + mapped/conditional types (single-hot-type shape)
{
    const N = 400;
    const shapes = [
        "string", "number", "Promise<string>", "string[]", "{ a: string; b: number }",
        "() => number", "readonly number[]", "Record<string, number>", "Model | null", "boolean",
    ];
    const lines = ["export interface Model {"];
    for (let i = 0; i < N; i++) lines.push(`  p${i}: ${shapes[i % shapes.length]};`);
    lines.push("}");
    lines.push("export type Box<K, T> = { value: T; meta: { key: K } };");
    lines.push("export type Mapped = { [K in keyof Model]: Box<K, Model[K]> };");
    lines.push("export type Unwrapped<T> = T extends Promise<infer U> ? U : T extends readonly (infer U)[] ? U : T;");
    lines.push("export type Flat = { [K in keyof Model]: Unwrapped<Model[K]> };");
    lines.push("declare const mapped: Mapped;");
    lines.push("declare const flat: Flat;");
    for (let i = 0; i < N; i++) {
        lines.push(`export const m${i} = mapped.p${i};`);
        lines.push(`export const f${i} = flat.p${i};`);
    }
    write("mapped1/src/model.ts", lines.join("\n") + "\n");
    write("mapped1/tsconfig.json", tsconfig({
        strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", noEmit: true, types: [], rootDir: "src",
    }, ["src/**/*.ts"]));
}

// ---- genericdeep: 32 files, cross-file conditional inference with infer clauses
{
    const N = 32, F = 20;
    const keys = ["id", "value", "next"];
    for (let i = 0; i < N; i++) {
        const lines = [];
        if (i > 0) lines.push(`import type { Item0, Unwrap0 } from "./g0";`);
        lines.push(`export interface Item${i} { id: number; value: string; next?: Item${i}; }`);
        lines.push(`export type Unwrap${i}<T> = T extends Promise<infer U> ? U : T extends readonly (infer U)[] ? U : T;`);
        lines.push(`export type Mapped${i} = { [K in keyof Item${i}]: Unwrap${i}<Item${i}[K]> };`);
        if (i > 0) {
            lines.push(`export type Cross${i}A = Unwrap0<Item0["id"]>;`);
            lines.push(`export type Cross${i}B = Unwrap0<Item0["value"]>;`);
            lines.push(`export type Cross${i}C = Unwrap0<Item0["next"]>;`);
            lines.push(`export type Cross${i}D = Unwrap0<Promise<Item0>>;`);
        }
        for (let k = 0; k < F; k++) {
            lines.push(`export function f${i}_${k}<T, K extends keyof T>(x: T, key: K): T[K] { return x[key]; }`);
            lines.push(`export function u${i}_${k}<T>(x: T): Unwrap${i}<T> { return x as never; }`);
        }
        lines.push(`declare const item${i}: Item${i};`);
        for (let k = 0; k < F; k++) lines.push(`export const r${i}_${k} = f${i}_0(item${i}, "${keys[k % keys.length]}");`);
        write(`genericdeep/src/g${i}.ts`, lines.join("\n") + "\n");
    }
    write("genericdeep/tsconfig.json", tsconfig({
        strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", noEmit: true, types: [], rootDir: "src",
    }, ["src/**/*.ts"]));
}

// ---- small3: three files (checker-count experiment shape)
write("small3/src/a.ts", `export interface A { a: number }\nexport const a: A = { a: 1 };\n`);
write("small3/src/b.ts", `import { A } from "./a";\nexport interface B extends A { b: string }\nexport const b: B = { a: 1, b: "x" };\n`);
write("small3/src/c.ts", `import { b } from "./b";\nexport function c(): string { return b.b; }\n`);
write("small3/tsconfig.json", tsconfig({
    strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", noEmit: true, types: [], rootDir: "src",
}, ["src/**/*.ts"]));

// ---- errdense / errdense-clean: 200 files x 25 consts, wrong types vs correct (diagnostics trigger)
for (const [name, bad] of [["errdense", true], ["errdense-clean", false]]) {
    for (let i = 0; i < 200; i++) {
        const lines = [];
        for (let k = 0; k < 25; k++) {
            lines.push(bad
                ? `export const e${i}_${k}: number = "not-a-number-${i}_${k}";`
                : `export const e${i}_${k}: number = ${i} + ${k};`);
        }
        write(`${name}/src/f${i}.ts`, lines.join("\n") + "\n");
    }
    write(`${name}/tsconfig.json`, tsconfig({
        strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", noEmit: true, types: [], rootDir: "src",
    }, ["src/**/*.ts"]));
}

// ---- editbig: 64 files x 200 interfaces (~22 KB each), declaration + incremental (edit-round shape)
{
    const N = 64, IFACES = 200;
    for (let i = 0; i < N; i++) {
        const hasBase = i + 1 < N;
        const lines = [];
        if (hasBase) lines.push(`import type { Big${(i + 1) % N}_0 } from "./f${(i + 1) % N}";`);
        for (let k = 0; k < IFACES; k++) {
            const ext = hasBase && k === 0 ? ` extends Big${(i + 1) % N}_0` : "";
            lines.push(`export interface Big${i}_${k}${ext} {`);
            lines.push(`  kind: string;`);
            lines.push(`  value: number;`);
            lines.push(`  label?: string;`);
            lines.push(`  map: Record<string, Big${i}_${(k + 1) % IFACES}>;`);
            lines.push(`}`);
        }
        write(`editbig/src/f${i}.ts`, lines.join("\n") + "\n");
    }
    write("editbig/tsconfig.json", tsconfig({
        strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", types: [], rootDir: "src",
        outDir: "out", declaration: true, incremental: true,
    }, ["src/**/*.ts"]));
}

// ---- longline: one file on a single very long line (source-map column shape)
{
    const parts = [];
    for (let i = 0; i < 20000; i++) parts.push(`const v${i}: number = ${i} + 1`);
    write("longline/src/one.ts", "export " + parts.join("; ") + ";\n");
    write("longline/tsconfig.json", tsconfig({
        strict: true, target: "es2017", module: "esnext", moduleResolution: "bundler", types: [], rootDir: "src",
        outDir: "out", sourceMap: true,
    }, ["src/**/*.ts"]));
}

console.log(`fixtures generated at ${fixtures}`);
