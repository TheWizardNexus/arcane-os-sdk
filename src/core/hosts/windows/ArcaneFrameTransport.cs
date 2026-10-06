using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace Arcane.Core.Hosts.Windows
{
    /// <summary>The shared native transport framing; callers own stream lifetime and ordered writes.</summary>
    internal static class ArcaneFrameTransport
    {
        private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
        private static readonly Encoding Ascii = Encoding.GetEncoding(
            "us-ascii", EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);

        internal static async Task WriteAsync(Stream stream, string json)
        {
            byte[] body = Utf8.GetBytes(json);
            // Length belongs only to the Content-Length transport frame.
            byte[] header = Ascii.GetBytes("Content-Length: " + body.Length.ToString(CultureInfo.InvariantCulture) + "\r\n\r\n");
            await stream.WriteAsync(header, 0, header.Length).ConfigureAwait(false);
            await stream.WriteAsync(body, 0, body.Length).ConfigureAwait(false);
            await stream.FlushAsync().ConfigureAwait(false);
        }

        internal static async Task<string> ReadAsync(Stream stream)
        {
            using (MemoryStream header = new MemoryStream())
            using (MemoryStream body = new MemoryStream())
            {
                try
                {
                    byte[] next = new byte[1];
                    byte[] separator = new byte[] { 13, 10, 13, 10 };
                    int matched = 0;
                    while (matched != separator.Length)
                    {
                        int read = await stream.ReadAsync(next, 0, 1).ConfigureAwait(false);
                        if (read == 0)
                        {
                            if (header.Length == 0) return null;
                            throw new EndOfStreamException("Core transport ended during a frame header.");
                        }
                        header.WriteByte(next[0]);
                        matched = next[0] == separator[matched] ? matched + 1 : next[0] == 13 ? 1 : 0;
                    }
                    byte[] headerBytes = header.ToArray();
                    string headerText = Ascii.GetString(headerBytes, 0, headerBytes.Length - separator.Length);
                    long? contentLength = null;
                    foreach (string line in headerText.Split(new string[] { "\r\n" }, StringSplitOptions.None))
                    {
                        if (!line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) continue;
                        long length;
                        if (contentLength.HasValue || !Int64.TryParse(line.Substring(15).Trim(), NumberStyles.None,
                            CultureInfo.InvariantCulture, out length))
                            throw new InvalidDataException("Core frame Content-Length is invalid.");
                        contentLength = length;
                    }
                    if (!contentLength.HasValue) throw new InvalidDataException("Core frame Content-Length is missing.");
                    long remaining = contentLength.Value;
                    byte[] buffer = new byte[8192];
                    while (remaining != 0)
                    {
                        int read = await stream.ReadAsync(buffer, 0, (int)Math.Min(remaining, buffer.Length)).ConfigureAwait(false);
                        if (read == 0) throw new EndOfStreamException("Core transport ended during a frame body.");
                        body.Write(buffer, 0, read);
                        remaining -= read;
                    }
                    return Utf8.GetString(body.ToArray());
                }
                catch (Exception error)
                {
                    error.Data["frameHeader"] = header.ToArray();
                    error.Data["frameBody"] = body.ToArray();
                    throw;
                }
            }
        }
    }
}
