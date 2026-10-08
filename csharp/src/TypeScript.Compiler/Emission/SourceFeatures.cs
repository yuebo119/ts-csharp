using TypeScript.Compiler.Ast;
using TypeScript.Compiler.Binding;
using TypeScript.Compiler.Syntax;

namespace TypeScript.Compiler.Emission;

/// <summary>
/// One-pass feature scan of a source file, used to skip transform passes that provably cannot
/// change it. Each flag corresponds to the only syntax its pass rewrites, so a missing flag means
/// the pass would visit the whole tree and return it unchanged.
/// </summary>
internal static class SourceFeatures
{
    [Flags]
    internal enum Flags
    {
        None = 0,
        /// <summary>Class declarations/expressions: the class-fields pass only rewrites classes.</summary>
        Class = 1,
        /// <summary>Decorators: the ES decorators pass only rewrites decorated declarations.</summary>
        Decorator = 2,
        /// <summary>`using`/`await using` declarations: the using pass only rewrites those.</summary>
        Using = 4,
        /// <summary>Property/element accesses: the const-enum inliner only replaces those.</summary>
        Access = 8,
        All = Class | Decorator | Using | Access
    }

    internal static Flags Scan(SyntaxNode file)
    {
        var features = Flags.None;
        var pending = new Stack<SyntaxNode>();
        for (int i = file.ChildCount - 1; i >= 0; i--)
            pending.Push(file.GetChild(i));
        while (pending.TryPop(out var node))
        {
            features |= node switch
            {
                ClassDeclarationNode or ClassExpressionNode => Flags.Class,
                DecoratorNode => Flags.Decorator,
                VariableDeclarationListNode list when (list.Flags & NodeFlags.BlockScoped) is NodeFlags.Using or NodeFlags.AwaitUsing
                    => Flags.Using,
                PropertyAccessExpressionNode or ElementAccessExpressionNode => Flags.Access,
                _ => Flags.None
            };
            if (features == Flags.All)
                return features;
            for (int i = node.ChildCount - 1; i >= 0; i--)
                pending.Push(node.GetChild(i));
        }
        return features;
    }
}
