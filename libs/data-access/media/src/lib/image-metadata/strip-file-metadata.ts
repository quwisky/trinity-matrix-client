import type { Bytes } from './byte-parts';
import {
  joinParts,
  strippableFormat,
  stripImageMetadata,
} from './image-metadata';
import { SVG_SNIFF_BYTES } from './svg-metadata';
import { isIsoMovie, stripVideoMetadata } from './video-metadata';

/**
 * Enough of a file to recognise every strippable format: a long `ftyp` box, or the prolog
 * (XML declaration, comments, doctype) an editor writes before an SVG root.
 */
const SNIFF_BYTES = SVG_SNIFF_BYTES;

/**
 * `file` with identifying image metadata removed (see `stripImageMetadata`), or `file`
 * itself when it is not a JPEG, PNG, WebP, HEIF, GIF, TIFF or SVG image, carries nothing
 * to remove, cannot be parsed with certainty, or cannot be read. Its name and type are
 * passed on, so a camera raw keeps its camera data (see `stripImageMetadata`). Never
 * rejects: stripping is a privacy default, not a gate, so a failure here must still let
 * the user's file go out.
 *
 * Only the first bytes of anything else are read, so a large video is never loaded here.
 */
export async function withoutImageMetadata(file: File): Promise<File> {
  try {
    const head = await sniff(file);
    return strippableFormat(head) ? await strippedImage(file) : file;
  } catch {
    return file;
  }
}

/**
 * `file` without identifying image or video metadata: images as {@link withoutImageMetadata},
 * and MP4/MOV/3GP movies with their location and device blanked in place (see
 * `stripVideoMetadata`), same length, nothing re-encoded. A movie is never loaded whole:
 * only its top-level box headers and its `moov` box are read, and the result is composed
 * of slices of `file` around the patched `moov`, so the samples are never copied. Never
 * rejects; anything it cannot handle with certainty is returned as `file` itself.
 */
export async function withoutMediaMetadata(file: File): Promise<File> {
  try {
    const head = await sniff(file);
    if (strippableFormat(head)) return await strippedImage(file);
    if (!isIsoMovie(head, file.type)) return file;
    const read = async (start: number, end: number): Promise<Bytes> =>
      new Uint8Array(await file.slice(start, end).arrayBuffer());
    const result = await stripVideoMetadata(read, file.size);
    if (result.kind !== 'stripped') return file;
    return new File(
      [file.slice(0, result.start), result.movie, file.slice(result.end)],
      file.name,
      { type: file.type, lastModified: file.lastModified },
    );
  } catch {
    return file;
  }
}

/**
 * The plaintext to encrypt for `file`: its bytes with identifying image or video metadata
 * removed, or exactly its bytes when there is nothing that can safely be removed. Reads
 * the file once, as the encrypted upload already did. A stripped image is copied once
 * more; a movie is blanked in that same buffer, since its length never changes.
 */
export async function bytesWithoutMediaMetadata(
  file: Blob,
): Promise<ArrayBuffer> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (strippableFormat(head)) {
    const name = file instanceof File ? file.name : undefined;
    const result = stripImageMetadata(bytes, {
      ...(name === undefined ? {} : { name }),
      type: file.type,
    });
    if (result.kind !== 'stripped') return buffer;
    // A single part that fills its own buffer (a TIFF's modified copy, an SVG's new text)
    // is handed over as it is, so a large TIFF is not copied a second time.
    const [only] = result.parts;
    if (
      result.parts.length === 1 &&
      only &&
      only.byteOffset === 0 &&
      only.byteLength === only.buffer.byteLength &&
      only.buffer !== buffer
    ) {
      return only.buffer;
    }
    return joinParts(result.parts).buffer;
  }
  if (isIsoMovie(head, file.type)) {
    // Edits land in `bytes` only once the whole moov has been checked.
    await stripVideoMetadata(
      (start, end) => Promise.resolve(bytes.subarray(start, end)),
      bytes.length,
    );
  }
  return buffer;
}

async function sniff(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
}

/**
 * `file` without its image metadata, or `file` when nothing was removed. Its name and type
 * go along, so a camera raw keeps its camera data.
 */
async function strippedImage(file: File): Promise<File> {
  const result = stripImageMetadata(new Uint8Array(await file.arrayBuffer()), {
    name: file.name,
    type: file.type,
  });
  if (result.kind !== 'stripped') return file;
  return new File([...result.parts], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
}
