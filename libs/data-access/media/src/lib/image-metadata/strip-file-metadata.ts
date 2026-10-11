import {
  joinParts,
  strippableFormat,
  stripImageMetadata,
} from './image-metadata';
import { SVG_SNIFF_BYTES } from './svg-metadata';

/**
 * Enough of a file to recognise every strippable format: a long `ftyp` box, or the prolog
 * (XML declaration, comments, doctype) an editor writes before an SVG root.
 */
const SNIFF_BYTES = SVG_SNIFF_BYTES;

/**
 * `file` with identifying image metadata removed (see `stripImageMetadata`), or `file`
 * itself when it is not a JPEG, PNG, WebP, HEIF, GIF, TIFF or SVG image, carries nothing
 * to remove, cannot be parsed with certainty, or cannot be read. Its name and type are
 * passed on, so a camera raw keeps its camera data (see `stripImageMetadata`). Never rejects: stripping is a privacy
 * default, not a gate, so a failure here must still let the user's file go out.
 *
 * Only the first bytes of anything else are read, so a large video is never loaded here.
 */
export async function withoutImageMetadata(file: File): Promise<File> {
  try {
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    if (!strippableFormat(head)) return file;
    const result = stripImageMetadata(
      new Uint8Array(await file.arrayBuffer()),
      { name: file.name, type: file.type },
    );
    if (result.kind !== 'stripped') return file;
    return new File([...result.parts], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

/**
 * The plaintext to encrypt for `file`: its bytes with identifying image metadata removed,
 * or exactly its bytes when there is nothing that can safely be removed. Reads the file
 * once, as the encrypted upload already did, and copies it again only when it stripped.
 */
export async function bytesWithoutImageMetadata(
  file: Blob,
): Promise<ArrayBuffer> {
  const buffer = await file.arrayBuffer();
  const name = file instanceof File ? file.name : undefined;
  const result = stripImageMetadata(new Uint8Array(buffer), {
    ...(name === undefined ? {} : { name }),
    type: file.type,
  });
  if (result.kind !== 'stripped') return buffer;
  // A single part that fills its own buffer (a TIFF's modified copy, an SVG's new text) is
  // handed over as it is, so a large TIFF is not copied a second time.
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
