using System.Diagnostics;
using System.Text;
using TypeScript.Compiler.Ast;
using TypeScript.Compiler.Syntax;
using TypeScript.Compiler.Text;

namespace TypeScript.Compatibility;

// Complexity-contract ladder for the parser (perf-budgets.md §3, O(n) row).
// Three tiers of synthetic TypeScript (10x steps): wall-time ratio must stay in a
// CI-noise-safe band and the allocation ratio (deterministic metric) in a tight band.
// An O(n^2) regression costs ~100x per 10x step and falls far outside both bands.
internal static class ParserLadderTests
{
    private const int TierSmall = 1_000, TierMedium = 10_000, TierLarge = 100_000;
    private const double TimeLow = 4.0, TimeHigh = 26.0;
    private const double AllocLow = 8.0, AllocHigh = 12.0;

    public static void Run(bool probe)
    {
        if (probe)
        {
            // Mutation probe: the same band check must REJECT a synthetic quadratic
            // ratio. The check below failing (exit 1) is the probe's pass condition;
            // reaching the return means the gate is a no-op.
            Check(100.0 >= TimeLow && 100.0 <= TimeHigh, "parser ladder probe accepted a synthetic quadratic ratio"u8);
            return;
        }
        (double smallMs, long smallBytes) = Measure(TierSmall);
        (double mediumMs, long mediumBytes) = Measure(TierMedium);
        (double largeMs, long largeBytes) = Measure(TierLarge);
        Console.WriteLine(
            $"parser ladder: {TierSmall} {smallMs:F1} ms {smallBytes:N0} B; {TierMedium} {mediumMs:F1} ms {mediumBytes:N0} B; {TierLarge} {largeMs:F1} ms {largeBytes:N0} B");
        Band("time medium/small"u8, mediumMs / smallMs, TimeLow, TimeHigh);
        Band("time large/medium"u8, largeMs / mediumMs, TimeLow, TimeHigh);
        Band("alloc medium/small"u8, mediumBytes / (double)smallBytes, AllocLow, AllocHigh);
        Band("alloc large/medium"u8, largeBytes / (double)mediumBytes, AllocLow, AllocHigh);
    }

    private static void Band(Utf8String name, double ratio, double low, double high) => Check(
        ratio >= low && ratio <= high,
        Utf8String.ConcatMany("parser ladder "u8, name, ": ratio "u8, Utf8String.Format(ratio, "F2"),
            " outside ["u8, Utf8String.Format(low), ", "u8, Utf8String.Format(high), "] (10x input step)"u8));

    private static (double Milliseconds, long AllocatedBytes) Measure(int statements)
    {
        Utf8String source = Synthesize(statements);
        SourceFileNode warmup = Parser.ParseSourceFile(new("ladder-warmup.ts"u8, ScriptKind.TS), new(source));
        Check(warmup.ParseDiagnostics.Count == 0, "parser ladder: warmup source must parse clean"u8);

        double milliseconds = double.MaxValue;
        long allocatedBytes = 0;
        for (int repetition = 0; repetition < 3; repetition++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            long before = GC.GetTotalAllocatedBytes(true);
            var timer = Stopwatch.StartNew();
            SourceFileNode file = Parser.ParseSourceFile(new("ladder.ts"u8, ScriptKind.TS), new(source));
            timer.Stop();
            long allocated = GC.GetTotalAllocatedBytes(true) - before;
            if (file.ParseDiagnostics.Count != 0)
                throw new InvalidOperationException($"parser ladder: {statements} statements produced {file.ParseDiagnostics.Count} diagnostics");
            milliseconds = Math.Min(milliseconds, timer.Elapsed.TotalMilliseconds);
            allocatedBytes = allocated; // allocation is deterministic; every repetition agrees
        }
        return (milliseconds, allocatedBytes);
    }

    private static Utf8String Synthesize(int statements)
    {
        var builder = new StringBuilder(statements * 72);
        for (int statement = 0; statement < statements; statement++)
        {
            int shape = statement % 4;
            builder.Append("const v").Append(statement).Append(": ");
            if (shape == 0) builder.Append("number");
            else if (shape == 1) builder.Append("string");
            else if (shape == 2) builder.Append("{ a: number; b: Array<Map<string, number>> }");
            else builder.Append("((x: number) => string) | undefined");
            builder.Append(" = fn").Append(statement % 97)
                .Append("(v").Append(statement % 53).Append(", \"s").Append(statement).Append("\", ")
                .Append(statement).Append(");\n");
        }
        return Utf8String.FromString(builder.ToString());
    }

    private static void Check(bool condition, Utf8String message)
    {
        if (!condition) throw new InvalidOperationException(message.ToString());
    }
}
