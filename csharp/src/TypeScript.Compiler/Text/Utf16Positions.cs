using System.Buffers;
using System.Text;

namespace TypeScript.Compiler.Text;

/// <summary>
/// UTF-16 column accounting over UTF-8 bytes, shared by LSP coordinates, declaration maps and
/// compiler traces. Each valid scalar contributes its UTF-16 sequence length; invalid UTF-8,
/// including a WTF-8 lone surrogate, consumes one byte and contributes one replacement unit.
/// The reference position converter uses the same invalid-byte rule.
/// </summary>
internal static class Utf16Positions
{
    public static int Units(ReadOnlySpan<byte> bytes)
    {
        int units = 0;
        while (!bytes.IsEmpty)
        {
            units += Next(bytes, out int width);
            bytes = bytes[width..];
        }
        return units;
    }

    /// <summary>Units for the scalar or replacement at the start; the return value is its width.</summary>
    public static int Next(ReadOnlySpan<byte> bytes, out int units)
    {
        if (Rune.DecodeFromUtf8(bytes, out Rune rune, out int width) == OperationStatus.Done)
        {
            units = rune.Utf16SequenceLength;
            return width;
        }
        units = 1;
        return 1;
    }
}