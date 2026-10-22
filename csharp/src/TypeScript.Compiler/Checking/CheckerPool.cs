using TypeScript.Compiler.Ast;
using TypeScript.Compiler.Diagnostics;
using TypeScript.Compiler.Programs;
using TypeScript.Compiler.Text;

namespace TypeScript.Compiler.Checking;

internal sealed class CheckerPool
{
    // Checker-local caches make extra checkers pay off only up to a point: measured on a 16-core
    // host, throughput bottoms out at eight checkers (medium 310/191/176/192 ms at 1/4/8/16) while
    // resident memory keeps growing, so scale with the machine but stay inside that band.
    internal static int DefaultCheckerCount => Math.Clamp(Environment.ProcessorCount / 4, 4, 8);
    private const int MaximumCheckerCount = 256;
    private readonly CompilerProgram program;
    private readonly Checker[] checkers;
    private readonly SemaphoreSlim[] gates;
    private readonly Dictionary<SourceFileNode, int> associations;
    private readonly List<int>[] filesByChecker;

    private CheckerPool(CompilerProgram program, Checker[] checkers, int[] assignments)
    {
        this.program = program;
        this.checkers = checkers;
        gates = checkers.Select(_ => new SemaphoreSlim(1, 1)).ToArray();
        associations = new(program.SourceFiles.Count);
        filesByChecker = checkers.Select(_ => new List<int>()).ToArray();
        for (int i = 0; i < program.SourceFiles.Count; i++)
        {
            associations.Add(program.SourceFiles[i].Syntax, assignments[i]);
            filesByChecker[assignments[i]].Add(i);
        }
    }

    internal int Count => checkers.Length;

    internal static async ValueTask<CheckerPool> CreateAsync(CompilerProgram program, bool singleThreaded,
        CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        using var capture = CompilationCapture.Measure("phase:checkConstruct"u8, traced: false);
        int count = singleThreaded ? 1 : program.Configuration.Options.Checkers ?? DefaultCheckerCount;
        count = Math.Clamp(count, 1, Math.Max(1, Math.Min(program.SourceFiles.Count, MaximumCheckerCount)));
        var assignments = CheckerPartitions.ForProgram(program, count, cancellation);
        var checkers = new Checker[count];
        if (count == 1)
            checkers[0] = await program.CreateCheckerAsync(cancellation);
        else
            await Task.WhenAll(Enumerable.Range(0, count).Select(index => Task.Run(async () =>
                checkers[index] = await program.CreateCheckerAsync(cancellation), cancellation)));
        cancellation.ThrowIfCancellationRequested();
        return new(program, checkers, assignments);
    }

    internal int OwnerOf(SourceFileNode file) => associations.TryGetValue(file, out int owner)
        ? owner
        : throw new ArgumentException("Source file does not belong to this checker pool", nameof(file));

    internal async ValueTask<Lease> AcquireAsync(SourceFileNode? file = null, CancellationToken cancellation = default)
    {
        int index = file is null ? 0 : OwnerOf(file);
        await gates[index].WaitAsync(cancellation);
        return new(checkers[index], gates[index]);
    }

    internal async ValueTask<(IReadOnlyList<Diagnostic> Semantic, IReadOnlyList<Diagnostic> Global)> GetDiagnosticsAsync(
        CancellationToken cancellation = default, IReadOnlySet<SourceFileNode>? selected = null)
    {
        var semantic = new IReadOnlyList<Diagnostic>[program.SourceFiles.Count];
        var globals = new IReadOnlyList<Diagnostic>[Count];
        using var capture = CompilationCapture.Measure("phase:checkPool"u8, traced: false);
        async Task CheckGroupAsync(int index)
        {
            await gates[index].WaitAsync(cancellation);
            using var lease = new Lease(checkers[index], gates[index]);
            // A partition may be empty. Its checker still contributes global diagnostics.
            var checker = checkers[index];
            using (CompilationCapture.Measure("phase:partition"u8, traced: false))
            using (CompilationCapture.Measure(Utf8String.FromString("phase:partition#" + index), traced: false))
            {
                foreach (int i in filesByChecker[index])
                {
                    var file = program.SourceFiles[i].Syntax;
                    if ((selected is null || selected.Contains(file)) && !checker.SkipProgramFile(file))
                        await checker.CheckSourceFileAsync(file, cancellation);
                }
            }
            // Later files can add diagnostics to earlier files in the same partition.
            using (CompilationCapture.Measure("phase:partitionDiag"u8, traced: false))
            {
                var diagnostics = checker.GroupDiagnosticsByFile();
                foreach (int i in filesByChecker[index])
                {
                    var file = program.SourceFiles[i].Syntax;
                    semantic[i] = checker.DetailedDiagnosticsForProgramFile(file, diagnostics[file], includeEmitOnly: selected is not null);
                }
                globals[index] = diagnostics[null].ToArray();
            }
        }
        if (Count == 1)
            await CheckGroupAsync(0);
        else
            await Task.WhenAll(Enumerable.Range(0, Count).Select(index => Task.Run(() => CheckGroupAsync(index), cancellation)));
        cancellation.ThrowIfCancellationRequested();
        return (semantic.SelectMany(d => d).ToArray(), DiagnosticCollection.SortAndDeduplicate(globals.SelectMany(d => d)));
    }

    internal sealed class Lease(Checker checker, SemaphoreSlim gate) : IDisposable
    {
        private SemaphoreSlim? gate = gate;
        internal Checker Checker => gate is null ? throw new ObjectDisposedException(nameof(Lease)) : checker;

        public void Dispose() => Interlocked.Exchange(ref gate, null)?.Release();
    }
}
