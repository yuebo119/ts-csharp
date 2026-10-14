using System.Buffers;
using System.Text;
using TypeScript.Compiler.Text;

namespace TypeScript.Compiler.Emission;

/// <summary>Writes UTF-8 text and tracks the UTF-16 columns required by source maps.</summary>
public sealed class EmitTextWriter(Utf8String newLine = default, int indentSize = 4, bool inlineDisplay = false, int capacity = 0)
{
    private readonly Utf8StringBuilder text = new(capacity);
    private readonly Utf8String newLine = newLine.Length == 0 ? "\n"u8 : newLine;
    private readonly int indentSize = indentSize >= 0 ? indentSize : 4;
    private int lineStart;
    private bool atLineStart = true;
    private bool carriageReturn;
    // UTF-16 units appended since lineStart. Maintained inside the tracking loop so Column is O(1)
    // instead of rescanning the line on every source-map position.
    private int column;

    /// <summary>
    /// True while the caller reads <see cref="Line"/> or <see cref="Column"/>, which only source
    /// maps do. When false the per-code-point line scan is skipped and just the O(1) line-start
    /// state is maintained; <see cref="AtLineStart"/> stays exact either way.
    /// </summary>
    internal bool TrackLineStarts { get; set; } = true;

    public int Position => text.Length;
    public int Line { get; private set; }
    public int Indentation { get; private set; }
    public bool AtLineStart => !inlineDisplay && atLineStart;
    public bool HasTrailingComment { get; private set; }
    public int Column => atLineStart ? Indentation * indentSize : column;
    public Utf8String Text => text.ToUtf8String();

    // The emit writer is never appended to after the file text is taken, so it can hand its
    // buffer over instead of copying the whole output.
    public Utf8String DetachText() => text.DetachText();
    public bool HasTrailingWhitespace => text.Length != 0 && WhiteSpace(Wtf8.DecodeLast(text.WrittenSpan, out _));

    private static bool WhiteSpace(int point) => Syntax.TokenFacts.IsWhiteSpace(point) || Syntax.TokenFacts.IsLineBreak(point);

    public void IncreaseIndent() => Indentation++;

    public void DecreaseIndent()
    {
        if (Indentation == 0)
            throw new InvalidOperationException("Unbalanced printer indentation");
        Indentation--;
    }

    public void Clear()
    {
        text.Clear();
        lineStart = Line = Indentation = column = 0;
        atLineStart = true;
        carriageReturn = HasTrailingComment = false;
    }

    public void Write(Utf8String value) => Write(value.Span);

    public void Write(ReadOnlySpan<byte> value)
    {
        if (value.IsEmpty)
            return;
        if (atLineStart)
        {
            if (!inlineDisplay)
            {
                int indentation = checked(Indentation * indentSize);
                text.Append((byte)' ', indentation);
                column += indentation;
            }
            atLineStart = false;
        }
        RawWrite(value);
    }

    public void WriteComment(Utf8String value)
    {
        Write(value);
        if (value.Length != 0)
            HasTrailingComment = true;
    }

    public void RawWrite(Utf8String value) => RawWrite(value.Span);

    public void RawWrite(ReadOnlySpan<byte> value)
    {
        if (value.IsEmpty)
            return;
        int start = text.Length;
        text.Append(value);
        HasTrailingComment = false;
        if (TrackLineStarts)
        {
            for (int position = 0; position < value.Length;)
            {
                // ASCII bytes decide line starts on their own; only non-ASCII needs a full
                // code-point decode, matching the reference's line-start computation.
                byte ascii = value[position];
                if (ascii < 0x80)
                {
                    position++;
                    if (ascii == (byte)'\n' && carriageReturn)
                    {
                        lineStart = start + position;
                        column = 0;
                    }
                    else if (ascii is (byte)'\r' or (byte)'\n')
                    {
                        Line++;
                        lineStart = start + position;
                        column = 0;
                    }
                    else
                        column++;
                    carriageReturn = ascii == (byte)'\r';
                    continue;
                }
                int point = Wtf8.Decode(value[position..], out int width);
                position += width;
                if (point == '\n' && carriageReturn)
                {
                    lineStart = start + position;
                    column = 0;
                }
                else if (point is '\r' or '\n' or 0x2028 or 0x2029)
                {
                    Line++;
                    lineStart = start + position;
                    column = 0;
                }
                else
                    column += point > 0xFFFF ? 2 : 1;
                carriageReturn = point == '\r';
            }
        }
        atLineStart = EndsWithLineTerminator(value);
    }

    // The last code point of a non-empty append decides the line-start state. U+2028/U+2029 encode
    // as E2 80 A8/A9 and UTF-8 is self-synchronizing, so the three-byte suffix check is exact.
    private static bool EndsWithLineTerminator(ReadOnlySpan<byte> value)
    {
        byte last = value[^1];
        if (last is (byte)'\n' or (byte)'\r')
            return true;
        return last is (byte)0xA8 or (byte)0xA9 && value.Length >= 3
            && value[^3] == 0xE2 && value[^2] == 0x80;
    }

    public void WriteLine(bool force = false)
    {
        if (inlineDisplay) { RawWrite(" "u8); return; }
        if (!atLineStart || force)
            RawWrite(newLine);
    }

    internal static int Utf16Length(ReadOnlySpan<byte> value)
    {
        int length = 0;
        while (!value.IsEmpty)
        {
            // ASCII bytes are one UTF-16 unit each, so the run up to the first non-ASCII byte is
            // counted with one vectorized scan instead of one decode per byte.
            int ascii = value.IndexOfAnyExceptInRange((byte)0, (byte)0x7F);
            if (ascii < 0)
                return length + value.Length;
            length += ascii;
            value = value[ascii..];
            // Source maps describe emitted UTF-8 bytes. Invalid bytes use the
            // reference's one-byte replacement decoding, including raw WTF-8.
            if (Rune.DecodeFromUtf8(value, out var rune, out int width) == OperationStatus.Done)
                length += rune.Utf16SequenceLength;
            else
            {
                width = 1;
                length++;
            }
            value = value[width..];
        }
        return length;
    }
}
