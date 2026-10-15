using TypeScript.Compiler.Ast;
using TypeScript.Compiler.Diagnostics;
using TypeScript.Compiler.Text;

namespace TypeScript.Compiler.Emission;

public enum EmitOnly { All, JavaScript, Declarations, BuilderSignature }

/// <summary>
/// Declaration output a caller already produced for one file, together with the transform's raw
/// diagnostics. Written verbatim instead of transforming and printing the file a second time.
/// </summary>
internal sealed record CachedDeclaration(Utf8String Text, IReadOnlyList<Diagnostic> Diagnostics);

public sealed record EmitOptions
{
    public IReadOnlyList<SourceFileNode>? SourceFiles { get; init; }
    public EmitOnly Only { get; init; }
    public bool Force { get; init; }
    public Func<Utf8String, Utf8String, EmitWriteFileData, CancellationToken, ValueTask>? WriteFile { get; init; }
    /// <summary>
    /// Overlaps a file's JavaScript print with its declaration transform. Only worth setting when the
    /// caller is not already emitting several files in parallel: with file-level parallelism the cores
    /// are busy, and a second concurrent pass per file costs more in GC contention than it saves
    /// (measured +3.7% on declarations and +4.7% on tiny-files), while a single large file gains 9.2%.
    /// </summary>
    public bool PipelineDeclarationTransform { get; init; }
    /// <summary>
    /// Declaration text produced by the incremental signature pass for this file, reused when the
    /// same round later emits the file. Only set when no declaration map is requested: that output
    /// carries its own map and URL suffix, which the cached text does not.
    /// </summary>
    internal CachedDeclaration? CachedDeclaration { get; init; }
}

public sealed record EmitWriteFileData(SourceFileNode SourceFile, int SourceMapUrlPosition = -1,
    IReadOnlyList<Diagnostic>? Diagnostics = null)
{
    public bool SkippedDeclarationWrite { get; set; }
}

public sealed record SourceMapEmitResult(Utf8String GeneratedFile, IReadOnlyList<Utf8String> InputSourceFileNames, SourceMap Map);

public sealed record EmitResult(bool EmitSkipped, IReadOnlyList<Diagnostic> Diagnostics,
    IReadOnlyList<Utf8String> EmittedFiles, IReadOnlyList<SourceMapEmitResult> SourceMaps);
