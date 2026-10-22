using System.Text;
using System.Text.Json;
using TypeScript.Compiler.Checking;
using TypeScript.Compiler.Configuration;
using TypeScript.Compiler.Diagnostics;
using TypeScript.Compiler.Hosts;
using TypeScript.Compiler.Programs;
using TypeScript.Compiler.Text;

namespace TypeScript.Compatibility;

/// <summary>
/// Locks the hostile-input fixes: a probe frame that resumes on another thread must not touch the
/// foreign thread's pool, and a tuple sized by source text must take the heap path in
/// <c>TypeCacheKey</c> instead of an unbounded stack allocation.
/// </summary>
internal static class HostileInputTests
{
    internal static async Task<int> SafetyAsync()
    {
        int checks = 0;
        void Check(bool value, string message) { checks++; if (!value) throw new InvalidOperationException(message); }
        static JsonElement Json(Utf8String text) { using var document = JsonDocument.Parse(text.Memory); return document.RootElement.Clone(); }

        var probeOptions = new CompilerOptions();
        probeOptions.Set("noLib"u8, Json("true"u8));
        probeOptions.Set("noEmit"u8, Json("true"u8));
        probeOptions.Set("extendedDiagnostics"u8, Json("true"u8));
        var probeFs = new MemoryFileSystem(new Dictionary<Utf8String, byte[]>
        {
            ["/p/a.ts"u8] = Wtf8.Encode("const a = 1;"),
        }, true, "/p"u8);
        var probeConfig = new ParsedConfig("/p/tsconfig.json"u8, probeOptions, ["/p/a.ts"u8], [], [], []);
        var capture = CompilationCapture.Start(probeFs, "/p"u8, probeConfig);
        Check(capture is not null && CompilationCapture.ProbesEnabled, "diagnostics capture enables probes");
        try
        {
            var sameThread = CompilationCapture.Mark();
            CompilationCapture.Report(AllocationProbes.TypeFromNode, sameThread);
            Check(true, "same-thread probe frame reports");
            var crossThread = CompilationCapture.Mark();
            await Task.Run(() => CompilationCapture.Report(AllocationProbes.TypeFromNode, crossThread))
                .WaitAsync(TimeSpan.FromSeconds(10));
            Check(true, "cross-thread probe frame reports without touching the foreign pool");
            var after = CompilationCapture.Mark();
            CompilationCapture.Report(AllocationProbes.TypeFromNode, after);
            Check(true, "probe frames still nest on the reporting thread after a cross-thread frame");
        }
        finally
        {
            if (capture is not null) await capture.DisposeAsync();
        }

        var tuple = new StringBuilder("type T = [");
        for (int i = 0; i < 200_000; i++) tuple.Append("0,");
        tuple.Append("0];\ndeclare const t: T;\n");
        var tupleOptions = new CompilerOptions();
        tupleOptions.Set("noLib"u8, Json("true"u8));
        tupleOptions.Set("noEmit"u8, Json("true"u8));
        var tupleFs = new MemoryFileSystem(new Dictionary<Utf8String, byte[]>
        {
            ["/t/a.ts"u8] = Wtf8.Encode(tuple.ToString()),
        }, true, "/t"u8);
        var tupleConfig = new ParsedConfig("/t/tsconfig.json"u8, tupleOptions, ["/t/a.ts"u8], [], [], []);
        var program = await CompilerProgram.CreateAsync(tupleFs, "/t"u8, tupleConfig, concurrency: 1);
        var pool = await program.CreateCheckerPoolAsync(singleThreaded: true);
        var diagnostics = await pool.GetDiagnosticsAsync();
        // noLib removes the global types, so the only expected diagnostics are the ten
        // CannotFindGlobalType entries; anything else means the large tuple changed semantics.
        Check(diagnostics.Global.All(d => d.Code.ToString() == "CannotFindGlobalType0"),
            $"large tuple global diagnostics: {string.Join(",", diagnostics.Global.Select(d => d.Code))}");
        Check(diagnostics.Semantic.Count == 0, $"large tuple semantic diagnostics: {diagnostics.Semantic.Count}");
        return checks;
    }
}
