using System.Diagnostics;
using System.Text;
using TypeScript.Compiler.Execution;
using TypeScript.Compiler.Hosts;
using TypeScript.Compiler.Text;

// Startup accounting for the fixed per-process cost: with TSHARP_STARTUP_TRACE set, report how
// much of the process lifetime is spent inside Main. The harness measures the whole process, so
// the difference isolates runtime/AOT image initialisation from our own startup work.
var trace = Environment.GetEnvironmentVariable("TSHARP_STARTUP_TRACE") is { Length: > 0 };
var mainStart = Stopwatch.GetTimestamp();
var processStart = Environment.TickCount64;

Console.OutputEncoding = new UTF8Encoding(false);
using var cancellation = new CancellationTokenSource();
ConsoleCancelEventHandler cancel = (_, signal) => { signal.Cancel = true; cancellation.Cancel(); };
Console.CancelKeyPress += cancel;
try
{
    if (args.Length > 0 && args[0] == "--api") return await ApiCommand.RunAsync(args[1..], cancellation.Token);
    if (args.Length > 0 && args[0] == "--lsp") return await LspCommand.RunAsync(args[1..], cancellation.Token);
    // A one-shot compile's whole allocation fits a no-GC region on any 64-bit host, and starting
    // one removes every GC pause from the run (measured at ~15% of wall on the heavy workloads).
    // If the region cannot be reserved, or a workload outgrows it, the runtime ends the region and
    // falls back to ordinary collection, so a wrong guess costs only the status quo. Long-running
    // commands keep the ordinary collector: their region would end mid-session behind one
    // blocking collection. TSHARP_NO_GC_REGION_MB=0 disables; unset means the 1 GiB default.
    bool longRunning = args.Any(argument => argument is "--watch" or "-w" or "--preserveWatchOutput");
    if (!longRunning)
    {
        string? regionSetting = Environment.GetEnvironmentVariable("TSHARP_NO_GC_REGION_MB");
        long regionMb = regionSetting is null ? 1024 : long.Parse(regionSetting);
        if (regionMb > 0 && GC.TryStartNoGCRegion(regionMb * 1024 * 1024) && regionSetting is not null)
            Console.Error.WriteLine($"[nogc] no-GC region of {regionMb} MB active; pause so far {GC.GetTotalPauseDuration().TotalMilliseconds:F1} ms");
    }
    await using var command = new CompilerCommand(new LibraryFileSystem(new PhysicalFileSystem()),
        Utf8String.FromString(Environment.CurrentDirectory), Console.Out, outputIsTerminal: !Console.IsOutputRedirected)
    { TerminalWidth = Console.IsOutputRedirected ? 0 : Console.WindowWidth };
    var status = await command.ExecuteAsync(args.Select(Utf8String.FromString).ToArray(), cancellation.Token);
    if (command.Watches is not null) await command.RunWatchAsync(cancellation.Token);
    return (int)status;
}
catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return 0; }
finally
{
    Console.CancelKeyPress -= cancel;
    if (Environment.GetEnvironmentVariable("TSHARP_NO_GC_REGION_MB") is { Length: > 0 } nogcSetting)
    {
        // Diagnostic: a second TryStart throws while the region is still active and succeeds once
        // the region has ended, which distinguishes "GCs inside the region" from "region ended early".
        string regionState;
        try
        {
            regionState = GC.TryStartNoGCRegion(1024 * 1024) ? "ENDED before exit" : "ended-and-could-not-restart";
        }
        catch (InvalidOperationException)
        {
            regionState = "STILL ACTIVE at exit";
        }
        Console.Error.WriteLine($"[nogc] {regionState}; final pause={GC.GetTotalPauseDuration().TotalMilliseconds:F1}ms gen0={GC.CollectionCount(0)} gen1={GC.CollectionCount(1)} gen2={GC.CollectionCount(2)}");
    }
    if (trace)
        Console.Error.WriteLine($"startup: in-main {Stopwatch.GetElapsedTime(mainStart).TotalMilliseconds:F1} ms, in-process {Environment.TickCount64 - processStart} ms");
}
