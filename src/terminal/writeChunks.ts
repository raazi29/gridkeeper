// Split outgoing terminal input into IPC-sized pieces (pure).
// Large pastes are sent as sequential ≤64 KiB (UTF-8) invokes so one huge JSON payload never blocks
// the IPC bridge. Splits never cut a UTF-16 surrogate pair (a lone surrogate would fail to decode in Rust).

export const MAX_WRITE_BYTES = 64 * 1024;

function utf8Len(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3; // BMP (lone surrogates are encoded as U+FFFD, 3 bytes)
}

export function splitForWrite(data: string, maxBytes = MAX_WRITE_BYTES): string[] {
  if (data.length === 0) return [];
  // Fast path: even worst case (3 bytes / UTF-16 unit) fits.
  if (data.length * 3 <= maxBytes) return [data];
  const out: string[] = [];
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < data.length) {
    const c = data.charCodeAt(i);
    let units = 1;
    let len: number;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < data.length) {
      const d = data.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        units = 2;
        len = 4;
      } else len = 3;
    } else len = utf8Len(c);
    if (bytes + len > maxBytes && i > start) {
      out.push(data.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += len;
    i += units;
  }
  if (start < data.length) out.push(data.slice(start));
  return out;
}
