using TypeScript.Compiler.Ast;
using TypeScript.Compiler.Checking;
using TypeScript.Compiler.Configuration;
using TypeScript.Compiler.Diagnostics;
using TypeScript.Compiler.Programs;
using TypeScript.Compiler.Syntax;
using TypeScript.Compiler.Text;

namespace TypeScript.Compiler.Emission;

internal static class ScriptTransformer
{
    internal static async ValueTask<SourceFileNode> TransformAsync(SourceFileNode source, EmitContext context,
        CompilerProgram program, Checker checker, CancellationToken cancellation)
    {
        var options = program.Configuration.Options;
        int target = options.EmitTargetYear;
        // Every pass visits the whole file, so passes whose only trigger syntax is absent are skipped
        // outright instead of walking the tree to return it unchanged. The scan runs once, before any
        // pass, because no pass creates class, decorator, `using` or access syntax.
        var features = SourceFeatures.Scan(source);
        // Every pass visits the whole file, so the per-pass times are what tell whether a pass is
        // worth skipping when the file cannot contain its trigger syntax.
        async ValueTask Apply(Utf8String name, SyntaxRewriter transformer)
        {
            using var pass = CompilationCapture.Measure(name);
            source = (SourceFileNode)(await transformer.VisitAsync(source))!;
        }
        if (options.EmitDecoratorMetadata == true) await Apply("xform:Metadata"u8, new MetadataTransformer(context, options, checker, cancellation));
        await Apply("xform:TypeEraser"u8, new TypeEraser(context, options, cancellation));
        if (options.VerbatimModuleSyntax != true && source.ScriptKind is not (ScriptKind.JS or ScriptKind.JSX))
            await Apply("xform:ImportElision"u8, new ImportElision(context, options, checker, cancellation));
        await Apply("xform:RuntimeSyntax"u8, new RuntimeSyntaxTransformer(context, options, checker, cancellation));
        if (options.ExperimentalDecorators == true) await Apply("xform:LegacyDecorators"u8, new LegacyDecoratorsTransformer(context, options, checker, cancellation));
        if (options.Jsx is JsxEmit.React or JsxEmit.ReactJSX or JsxEmit.ReactJSXDev && source.ScriptKind is ScriptKind.TSX or ScriptKind.JSX)
            await Apply("xform:Jsx"u8, new JsxTransformer(context, options, checker, cancellation));
        if (target != int.MaxValue && (features & SourceFeatures.Flags.Using) != 0)
            await Apply("xform:Using"u8, new UsingTransformer(context, cancellation));
        if ((features & SourceFeatures.Flags.Decorator) != 0)
            await Apply("xform:EsDecorators"u8, new EsDecoratorsTransformer(context, options, cancellation));
        if ((features & SourceFeatures.Flags.Class) != 0)
            await Apply("xform:ClassFields"u8, new ClassFieldsTransformer(context, options, checker, cancellation));
        if (target < 2021) await Apply("xform:LogicalAssignment"u8, new ExpressionLowering(context, ExpressionTransform.LogicalAssignment, cancellation));
        if (target < 2020)
        {
            await Apply("xform:Nullish"u8, new ExpressionLowering(context, ExpressionTransform.NullishCoalescing, cancellation));
            await Apply("xform:OptionalChain"u8, new OptionalChainTransformer(context, cancellation));
        }
        if (target < 2019) await Apply("xform:OptionalCatch"u8, new ExpressionLowering(context, ExpressionTransform.OptionalCatch, cancellation));
        if (target < 2018)
        {
            await Apply("xform:ObjectRestSpread"u8, new ObjectRestSpreadTransformer(context, cancellation));
            await Apply("xform:ForAwait"u8, new ForAwaitTransformer(context, cancellation));
            await Apply("xform:TaggedTemplate"u8, new TaggedTemplateTransformer(context, cancellation));
        }
        if (target < 2017) await Apply("xform:Async"u8, new AsyncTransformer(context, cancellation));
        if (target < 2016) await Apply("xform:Exponentiation"u8, new ExpressionLowering(context, ExpressionTransform.Exponentiation, cancellation));
        await Apply("xform:UseStrict"u8, new UseStrictTransformer(context, options, program.EmitModuleFormat, cancellation));
        await Apply("xform:Module"u8, new ModuleTransformer(context, options, checker, program.EmitModuleFormat, cancellation));
        if (options.IsolatedModules != true && options.VerbatimModuleSyntax != true && (features & SourceFeatures.Flags.Access) != 0)
            await Apply("xform:ConstEnum"u8, new ConstEnumInliner(context, options, checker, cancellation));
        foreach (var helper in context.ReadHelpers()) context.AddHelper(source, helper);
        return source;
    }
}
