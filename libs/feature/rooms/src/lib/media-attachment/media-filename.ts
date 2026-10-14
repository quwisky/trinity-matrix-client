/** An image type recognised from a file's first bytes, with the extension it is saved under. */
export interface SniffedImage {
  readonly type: string;
  readonly extension: string;
}

/** How many leading bytes {@link sniffImage} needs. */
export const SNIFF_BYTES = 16;

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));

const SIGNATURES: readonly (SniffedImage & {
  readonly matches: (bytes: Uint8Array) => boolean;
})[] = [
  {
    type: 'image/png',
    extension: 'png',
    matches: (b) => b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n'),
  },
  {
    type: 'image/jpeg',
    extension: 'jpg',
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/gif',
    extension: 'gif',
    matches: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
  },
  {
    type: 'image/webp',
    extension: 'webp',
    matches: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  },
  {
    type: 'image/avif',
    extension: 'avif',
    matches: (b) =>
      ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')),
  },
  { type: 'image/bmp', extension: 'bmp', matches: (b) => ascii(b, 0, 'BM') },
];

/**
 * The image type a file's first {@link SNIFF_BYTES} bytes declare, or null. For media whose
 * event says nothing about its type: an inline image in a message's HTML carries only its
 * `mxc://` source and alt text.
 */
export function sniffImage(head: Uint8Array): SniffedImage | null {
  const found = SIGNATURES.find((signature) => signature.matches(head));
  return found ? { type: found.type, extension: found.extension } : null;
}

/** Whether a filename already ends in an extension (`photo.jpg`, not `Image` or `v1.`). */
export function hasExtension(filename: string): boolean {
  return /\.[a-z0-9]{1,5}$/i.test(filename);
}
