/** Bytes viewed over an `ArrayBuffer`, the only kind a `Blob` or WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * What a format stripper decided. `stripped` lists the output as views into the input plus
 * a few freshly written headers, so the caller makes the one copy it needs (a `Blob`, or a
 * contiguous buffer to encrypt) instead of the stripper making another.
 */
export type FormatStrip =
  | { readonly kind: 'stripped'; readonly parts: readonly Bytes[] }
  | { readonly kind: 'clean' }
  | { readonly kind: 'malformed' };

export const CLEAN: FormatStrip = { kind: 'clean' };
export const MALFORMED: FormatStrip = { kind: 'malformed' };

/**
 * Collects the output of a strip. Kept ranges that touch are merged into one view, so a
 * file with a single metadata block becomes two or three parts, not one per segment.
 */
export class PartsBuilder {
  private readonly parts: Bytes[] = [];
  private runStart = -1;
  private runEnd = -1;
  private edited = false;

  constructor(private readonly source: Bytes) {}

  /** Keep `source[start, end)` verbatim. */
  keep(start: number, end: number): void {
    if (end <= start) return;
    if (start === this.runEnd) {
      this.runEnd = end;
      return;
    }
    this.flush();
    this.runStart = start;
    this.runEnd = end;
  }

  /** Leave bytes out; only marks the output as different from the input. */
  drop(): void {
    this.edited = true;
  }

  /** Write new bytes at the current position. */
  insert(bytes: Bytes): void {
    this.flush();
    this.parts.push(bytes);
    this.edited = true;
  }

  get changed(): boolean {
    return this.edited;
  }

  result(): FormatStrip {
    if (!this.edited) return CLEAN;
    this.flush();
    return { kind: 'stripped', parts: this.parts };
  }

  private flush(): void {
    if (this.runStart >= 0 && this.runEnd > this.runStart) {
      this.parts.push(this.source.subarray(this.runStart, this.runEnd));
    }
    this.runStart = -1;
    this.runEnd = -1;
  }
}

/** Copy `parts` into one new contiguous buffer. */
export function joinParts(parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Whether `bytes` holds the ASCII `text` at `offset`. */
export function hasAscii(
  bytes: Uint8Array,
  offset: number,
  text: string,
): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The four ASCII characters at `offset` (a chunk or box type). */
export function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

export function asciiBytes(text: string): Bytes {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/** Big-endian unsigned reads; callers bounds-check first. */
export function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

export function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    (((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0))
  );
}

export function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16)) +
    (((bytes[offset + 3] ?? 0) << 24) >>> 0)
  );
}

export function writeU32be(value: number): Bytes {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

export function writeU32le(value: number): Bytes {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}
