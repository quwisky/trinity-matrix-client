import type { Bytes, FormatStrip } from './byte-parts';
import { isHeif, stripHeif } from './heif-metadata';
import { isJpeg, stripJpeg } from './jpeg-metadata';
import { isPng, stripPng } from './png-metadata';
import { isWebp, stripWebp } from './webp-metadata';

export { joinParts } from './byte-parts';

/** Image containers whose metadata can be removed without re-encoding. */
export type StrippableImageFormat = 'jpeg' | 'png' | 'webp' | 'heif';

/**
 * The outcome of {@link stripImageMetadata}.
 *
 * - `stripped`: `parts`, concatenated, are the image without its identifying metadata.
 * - `unchanged`: the input should be sent as it is: `unsupported` (not an image this module
 *   understands, e.g. GIF, video or a document), `clean` (nothing to remove) or `malformed`
 *   (the structure could not be followed with certainty, so it is not touched).
 */
export type ImageMetadataStrip =
  | {
      readonly kind: 'stripped';
      readonly format: StrippableImageFormat;
      readonly parts: readonly Bytes[];
      readonly byteLength: number;
    }
  | {
      readonly kind: 'unchanged';
      readonly reason: 'unsupported' | 'clean' | 'malformed';
    };

const FORMATS: readonly {
  readonly format: StrippableImageFormat;
  readonly matches: (bytes: Uint8Array) => boolean;
  readonly strip: (bytes: Bytes) => FormatStrip;
}[] = [
  { format: 'jpeg', matches: isJpeg, strip: stripJpeg },
  { format: 'png', matches: isPng, strip: stripPng },
  { format: 'webp', matches: isWebp, strip: stripWebp },
  { format: 'heif', matches: isHeif, strip: stripHeif },
];

/** The strippable format `bytes` start with, judged by content alone, or null. */
export function strippableFormat(
  bytes: Uint8Array,
): StrippableImageFormat | null {
  return FORMATS.find((entry) => entry.matches(bytes))?.format ?? null;
}

/**
 * Remove location, camera, time, author and other identifying metadata from an image,
 * losslessly: the coded image data is never re-encoded and the output is built from views
 * into `bytes` plus a few rewritten headers. A rotated or mirrored photo keeps its Exif
 * orientation so it still displays the right way up.
 *
 * Pure and synchronous; never throws. The format is detected from the bytes, not a MIME
 * type, and whenever the structure is in doubt the verdict is `unchanged`, so a caller can
 * always fall back to the original file.
 */
export function stripImageMetadata(bytes: Bytes): ImageMetadataStrip {
  const entry = FORMATS.find((candidate) => candidate.matches(bytes));
  if (!entry) return { kind: 'unchanged', reason: 'unsupported' };
  let result: FormatStrip;
  try {
    result = entry.strip(bytes);
  } catch {
    // Every parser bounds-checks; this is the last guard against a structure it misjudged.
    return { kind: 'unchanged', reason: 'malformed' };
  }
  if (result.kind !== 'stripped')
    return { kind: 'unchanged', reason: result.kind };
  return {
    kind: 'stripped',
    format: entry.format,
    parts: result.parts,
    byteLength: result.parts.reduce((sum, part) => sum + part.length, 0),
  };
}
