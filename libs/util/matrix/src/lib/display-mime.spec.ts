import { describe, expect, it } from 'vitest';
import { displaySafeMime, mimeEssence } from './display-mime';

const FALLBACK = 'application/octet-stream';

const ALLOWED = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/opus',
  'audio/mp3',
  'audio/x-m4a',
  'audio/m4a',
  'audio/x-aac',
  'audio/3gpp',
  'video/x-m4v',
  'video/3gpp',
];

describe('mimeEssence', () => {
  it('drops parameters, trims and lowercases', () => {
    expect(mimeEssence('Image/SVG+XML ; charset=utf-8')).toBe('image/svg+xml');
    expect(mimeEssence('  audio/ogg;codecs=opus')).toBe('audio/ogg');
  });

  it('is empty for empty or non-string input', () => {
    expect(mimeEssence('')).toBe('');
    expect(mimeEssence(undefined)).toBe('');
    expect(mimeEssence(42)).toBe('');
  });
});

describe('displaySafeMime', () => {
  it.each(ALLOWED)('keeps the allowlisted type %s', (type) => {
    expect(displaySafeMime(type)).toBe(type);
  });

  it('reduces an allowlisted type to its essence', () => {
    expect(displaySafeMime('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(displaySafeMime('IMAGE/PNG')).toBe('image/png');
    expect(displaySafeMime('  image/jpeg  ')).toBe('image/jpeg');
    expect(displaySafeMime('video/mp4; codecs="avc1.42E01E"')).toBe(
      'video/mp4',
    );
  });

  it('maps the image/jpg alias to image/jpeg', () => {
    expect(displaySafeMime('image/jpg')).toBe('image/jpeg');
    expect(displaySafeMime(' IMAGE/JPG; q=1')).toBe('image/jpeg');
  });

  it('trims tabs and newlines around an allowlisted type', () => {
    expect(displaySafeMime('\timage/png\n')).toBe('image/png');
    expect(displaySafeMime('\r\nvideo/mp4 \t')).toBe('video/mp4');
  });

  it('reads only the part before the first semicolon, quoted parameters included', () => {
    expect(displaySafeMime('image/png; name="a;b"')).toBe('image/png');
    expect(displaySafeMime('audio/ogg; codecs="opus;x"')).toBe('audio/ogg');
  });

  it.each([
    'image/svg+xml',
    'image/svg+xml; charset=utf-8',
    'image/svg+xml;',
    'image/svg+xml ',
    ' IMAGE/SVG+XML',
    'text/html',
    'text/html; charset=utf-8',
    'TEXT/HTML',
    'application/xhtml+xml',
    'application/xhtml+xml; charset=utf-8',
    'application/xml',
    'text/xml',
    'text/plain',
    'application/pdf',
    'application/json',
    'image/svg',
    'image/png/extra',
    'image/png,text/html',
    'image/pngx',
    'image/png\u0000',
    'image/png\u0000; charset=utf-8',
    'image/png\u200b',
    '\u200bimage/png',
    'image/p\tng',
    'image/png\nimage/svg+xml',
    'image/\npng',
    'image/png,',
    'image/png,image/svg+xml',
    'image/svg+xml,',
    '"image/png"',
    'image/svg+xml; name="a;b"',
  ])('falls back for the non-allowlisted type %j', (type) => {
    expect(displaySafeMime(type)).toBe(FALLBACK);
  });

  it.each(['', '   ', ';', undefined, null, 0, {}, [], ['image/png']])(
    'falls back for empty or non-string input %j',
    (input) => {
      expect(displaySafeMime(input)).toBe(FALLBACK);
    },
  );
});
