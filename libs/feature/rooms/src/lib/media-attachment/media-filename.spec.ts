import { describe, expect, it } from 'vitest';
import { hasExtension, sniffImage } from './media-filename';

const bytes = (...parts: (string | number)[]): Uint8Array =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === 'number'
        ? [part]
        : [...part].map((char) => char.charCodeAt(0)),
    ),
  );

describe('sniffImage', () => {
  it.each([
    ['png', bytes(0x89, 'PNG\r\n\x1a\n', 0, 0, 0, 13), 'image/png'],
    ['jpg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['gif', bytes('GIF89a'), 'image/gif'],
    ['gif', bytes('GIF87a'), 'image/gif'],
    ['webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '), 'image/webp'],
    ['avif', bytes(0, 0, 0, 28, 'ftypavif'), 'image/avif'],
    ['bmp', bytes('BM', 0, 0), 'image/bmp'],
  ])('recognises %s from its first bytes', (extension, head, type) => {
    expect(sniffImage(head)).toEqual({ type, extension });
  });

  it('recognises nothing in bytes that are not an image it knows', () => {
    expect(sniffImage(bytes('<svg xmlns'))).toBeNull();
    expect(sniffImage(bytes())).toBeNull();
  });
});

describe('hasExtension', () => {
  it.each([
    ['photo.jpg', true],
    ['archive.tar.gz', true],
    ['Image', false],
    ['A hidden test image', false],
    ['v1.', false],
    ['', false],
  ])('%s → %s', (name, expected) => {
    expect(hasExtension(name)).toBe(expected);
  });
});
