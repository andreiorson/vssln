/**
 * Text of a file by its byte order mark: UTF-16 (older Visual Studio versions wrote project files that way) or UTF-8.
 * A UTF-8 BOM is kept, as before, for the readers that strip it themselves.
 */
export function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8');
}
