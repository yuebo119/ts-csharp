# C# compiler extreme-optimization guide

This branch is a self-contained optimisation pass over the C# compiler port. It is meant to be
read commit by commit: each commit states the problem, the change, and the measurement that
justifies it. Nothing here is speculative — every change was either measured or reverted.

- Base branch: `typescript-cs`
- Head: `csharp-perf-extreme-optimization`
- Companion documents: [`csharp-extreme-optimization-results.md`](csharp-extreme-optimization-results.md)
  (full plan, measurement method and per-round numbers) and
  [`csharp-go-baseline-comparison.md`](csharp-go-baseline-comparison.md) (the C# vs Go baseline
  comparison that motivated the work).

## Results at a glance

Against the Go implementation on the same host, alternating pairs in one batch:

| Workload | Before this branch | After |
| --- | ---: | ---: |
| large single file | 3.61× | **3.23×** |
| medium project | 3.14× | **1.83×** |
| declarations only | 2.54× | **1.85×** |
| 512 small files | 1.81× | **1.26×** |
| medium `--checkers 1` | 2.93× | **2.62×** |
| medium `--checkers 8` | 2.08× | **1.90×** |
| `--version` (startup floor) | 1.30× | **1.17×** |

Peak resident memory is now **below Go on 12 of 23 workloads** (incremental edit 0.58×,
noEmit-on-error 0.68×, 512 files 0.73×, `--checkers 2` 0.74×, medium 0.80×), versus 8 before.

Deterministic allocation counters (byte-exact and reproducible, unlike wall time on a loaded
host) for the large-file fixture:

| Counter | Before | After |
| --- | ---: | ---: |
| total allocated | 960.1 MB | **519.7 MB** (−45.9%) |
| emit phase | 711.7 MB | **268.9 MB** (−62.2%) |
| printing | 587.4 MB | **146.6 MB** (−75.0%) |
| AOT emit phase time | 1.064 s | **0.668 s** (−37.2%) |
| AOT total time | 1.621 s | **1.263 s** (−22.1%) |

## How to review

Read in this order; each step is one commit.

| # | Commit | What to look at | Why it matters |
| --- | --- | --- | --- |
| 1 | `Emit files in parallel with per-file checker leases` | `IncrementalProgram.Emit.cs`: the `work` list, `Parallel.ForAsync`, and the serial merge of `errors`/`emitted`/`maps`/`PendingEmit` | Largest single win on multi-file projects. Reviewers should satisfy themselves that the merge preserves file order and that `writeGate` covers the snapshot mutation inside `Write`. |
| 2 | `Scale the checker pool with the machine instead of pinning it to four` | `CheckerPool.DefaultCheckerCount`, and the compatibility assertion | Small, independent, and the test documents the measured optimal band. |
| 3 | `Tune the shipping GC configuration for the compiler process` | `TypeScript.CommandLine.csproj`, generated shim in `tools/package.mjs` | Configuration only; the interesting part is that the values must be exported by the launcher to survive the JS shim. |
| 4 | `Attribute allocated bytes to compilation phases under --extendedDiagnostics` | `CompilationCapture`, `CompilationStatistics`, `Measure(...)` call sites | This is the instrumentation that made the rest reviewable. It is inactive unless diagnostics are requested. |
| 5 | `Cut printer allocation and per-write scanning` | `SyntaxPrinter.cs` (the bulk), `SyntaxPrinter.Nodes.cs`, `Scanner.Reset`, `SourceText.Reset` | The largest diff and the one that deserves the closest reading. Six independent fixes, each listed in the commit body. |

### What changed in the printer (commit 5), in order of size

1. **Recipe writes no longer rebuild a scanner.** `Code()` used to allocate a `SourceText`
   (which copies the text) and a `Scanner` (with two `List<>`s) for *every* punctuation or
   keyword written. One scratch pair is now reused through new `SourceText.Reset` and
   `Scanner.Reset` members.
2. **`NodeState` is pooled.** `BeginNode` allocated one state object per visited node
   (409,602 on the large fixture). States are strictly stack-disciplined, so a free list is safe.
3. **Comment scanning is skipped for comment-free files.** `CommentRanges` can only produce a
   range after seeing `//` or `/*`, so a single scan over the file decides whether the per-node
   comment work is needed. Synthetic comments added by transforms are still emitted.
4. **`Part` packed from ~120 to 64 bytes.** A large file pushes about a million of them.
   Booleans collapse into one flags byte, nullable ints become `-1` sentinels, and the five
   rarely used references move into a payload that is only allocated when one is set. The
   constructor parameter names and property names are unchanged, so all 104 construction sites
   were untouched.
5. **List-shaped nodes push onto the work stack instead of building a container.** A container
   is filled (copying every part) and then expanded (copying them all again); because the work
   stack is LIFO, pushing the same parts in reverse produces an identical order. `List` gained a
   pooled buffer that never escapes, and `PushList`/`PushBlockMembers`/`PushTypeMembers` are the
   container-free counterparts.
6. **Recipes are written verbatim when token boundaries cannot matter.** Those boundaries serve
   comment placement and source-map positions only, so the scan is skipped when there is no
   source map and no source comment.

## Verification

| Gate | Command | Result |
| --- | --- | --- |
| Build | `dotnet build csharp/TypeScript.slnx -c Release` | 0 warnings, 0 errors |
| Compatibility suite | `dotnet <TypeScript.Compatibility.dll> --<area>-safety` for 13 areas | 12/13 pass |
| Byte-for-byte output | `node csharp/tools/performance-cli.mjs` (asserts emitted files against the Go reference) | 5 batches × 23 workloads × 15 pairs |
| Targeted byte equality | same fixture compiled by both compilers and hashed | 1,227 emitted files identical after each container-removal step |
| Comment-heavy source | two-file project with line, block, JSDoc, inline, inter-parameter, in-type and trailing comments, with `declaration` + `declarationMap` + `sourceMap` | 8 emitted files byte-identical to Go |

`--program-emit-safety` fails at assertion 14 (content-mapper `mapped.SourceFiles.Count == 2`).
That failure is **pre-existing**: it reproduces on an unmodified checkout built separately, and
also with `TSHARP_PARSE_CONCURRENCY=4`.

## Reproducing the numbers

```bash
# deterministic allocation attribution
./tsc --project <fixture> --extendedDiagnostics --pretty false
#   look for: Alloc parse|bind|check|emit|transform|print (summed)

# paired C# vs Go comparison (asserts byte equality, bootstrap CIs, peak RSS)
node csharp/tools/performance-cli.mjs \
  --manifest <csharp-manifest.json> --go-executable <go-tsc> \
  --csharp-env "DOTNET_gcServer=0,DOTNET_GCgen0size=0x400000,DOTNET_GCLOHThreshold=1000000" \
  --samples 15

# A/B two C# builds against each other with the same harness
node csharp/tools/performance-cli.mjs --manifest <new>.json --go-executable <old>/tsc.exe --samples 15
```

Wall-clock absolute times on this host drift by tens of percent between batches, so only
same-batch paired ratios and the deterministic allocation counters should be compared.

## Deliberately rejected

These were implemented or evaluated and then dropped, because the measurement did not support
them. They are recorded so nobody repeats them:

- **Removing the 41 redundant `Array.AsReadOnly` wrappers** in checker hot paths (an array
  already implements `IReadOnlyList<T>`, and the wrapper is a view, not a copy). Compiles
  cleanly, but check-phase allocation moved 180.0 → 183.3 MB, inside noise. Reverted.
- **Server GC**, and Server GC with an explicit 8-heap configuration: 5–11% slower on three of
  four workloads, roughly 2× memory, and up to +217% RSS for the heap configuration.
- **`GCConserveMemory=9`**: +16.1% wall time on the large file.
- **`IlcInstructionSet=native` and `GOAMD64=v3`**: ≤2.8% and usually negative.
- **Raising parse/bind concurrency above 4**: no gain (parsing 512 files takes 8 ms).
- **Disabling tiered compilation + PGO**: +30–44% except on the large file.
- **A global typed-AST arena**: an earlier prototype was 18.5% slower.

## Where the remaining time is

Measured with phase attribution on the large-file fixture, after this branch:

```
parse 0.079 s   bind 0.069 s   check 0.344 s   emit 0.668 s   total 1.263 s   (Go: 0.379 s)
```

Printing allocation fell 75% yet the large-file ratio barely moved (3.20 → 3.23 across two
batches, i.e. inside the confidence interval). The remaining cost is therefore **not
allocation**: it is moving and dispatching roughly one million part work items plus the checker
phase. Those are design-level costs. Known opportunities, in order of measured size:

1. transform phase: 122 MB (`EmitContext` `NodeData` objects and its two dictionaries)
2. check phase: 183 MB (needs recursive self-allocation attribution to locate)
3. the remainder of printer containers (`S()` arrays, `Modifiers`, `BlockBody`) — long tail

CPU-level profiling is not available in this environment: `dotnet-trace` does not attach to the
Native AOT binary, and on the CoreCLR build the samples were dominated by thread waits.
