import { describe, expect, it } from 'vitest';
import { normalizeMediaPayload } from './message-view';

describe('normalizeMediaPayload — display types', () => {
  const media = (
    msgtype: string,
    info: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    normalizeMediaPayload(
      { msgtype, body: 'attachment', url: 'mxc://hs/a', info, ...extra },
      msgtype,
    );

  it.each([
    'image/svg+xml',
    'image/svg+xml; charset=utf-8',
    'image/svg+xml;',
    'image/svg+xml ',
    ' Image/SVG+XML ;charset=utf-8',
    'text/html; charset=utf-8',
    'application/xhtml+xml; charset=utf-8',
    'text/xml',
  ])('lists an m.image declaring %j as a download-only file', (mimetype) => {
    expect(media('m.image', { mimetype })?.kind).toBe('file');
  });

  it.each([
    ['a trailing comma', 'image/svg+xml,'],
    ['a NUL suffix', 'image/png\u0000'],
    ['a NUL suffix after a parameter', 'image/svg+xml\u0000; charset=utf-8'],
    ['a zero-width-space suffix', 'image/png\u200b'],
    ['a zero-width-space prefix', '\u200bimage/png'],
    ['a quoted type', '"image/png"'],
    ['an embedded newline', 'image/png\nimage/svg+xml'],
    ['a comma-separated list', 'image/png,text/html'],
    ['a quoted parameter on a document type', 'image/svg+xml; name="a;b"'],
    ['a missing subtype', 'image/'],
  ])('lists an m.image declaring %s as a download-only file', (_, mimetype) => {
    expect(media('m.image', { mimetype })?.kind).toBe('file');
  });

  it.each([
    ['m.video', 'video/mp4\u0000'],
    ['m.video', 'video/mp4,'],
    ['m.audio', 'audio/ogg\u200b; codecs=opus'],
    ['m.audio', 'audio/ogg,'],
  ])(
    'lists an %s declaring %j as a download-only file',
    (msgtype, mimetype) => {
      expect(media(msgtype, { mimetype })?.kind).toBe('file');
    },
  );

  it('keeps an m.image with a quoted parameter containing a semicolon inline', () => {
    expect(media('m.image', { mimetype: 'image/png; name="a;b"' })?.kind).toBe(
      'image',
    );
  });

  it.each(['image/png', 'image/jpeg; q=0.9', ' IMAGE/WEBP ', 'image/gif;'])(
    'keeps an m.image declaring %j inline',
    (mimetype) => {
      expect(media('m.image', { mimetype })?.kind).toBe('image');
    },
  );

  it('keeps a voice message declaring audio/ogg; codecs=opus as inline audio', () => {
    const voice = media(
      'm.audio',
      { mimetype: 'audio/ogg; codecs=opus', duration: 1200 },
      { 'org.matrix.msc3245.voice': {} },
    );

    expect(voice?.kind).toBe('audio');
    expect(voice?.isVoice).toBe(true);
  });

  it('does not carry a thumbnail type outside the display allowlist', () => {
    const payload = media('m.image', {
      mimetype: 'image/png',
      thumbnail_url: 'mxc://hs/thumb',
      thumbnail_info: { mimetype: 'image/svg+xml; charset=utf-8' },
    });

    expect(payload?.thumbnailMimeType).toBe('application/octet-stream');
  });

  it('keeps an allowlisted thumbnail type and leaves an undeclared one unset', () => {
    const declared = media('m.image', {
      thumbnail_url: 'mxc://hs/thumb',
      thumbnail_info: { mimetype: 'image/jpeg' },
    });
    const undeclared = media('m.image', { thumbnail_url: 'mxc://hs/thumb' });

    expect(declared?.thumbnailMimeType).toBe('image/jpeg');
    expect(undeclared?.thumbnailMimeType).toBeUndefined();
  });
});

describe('normalizeMediaPayload — encrypted sources', () => {
  const encrypted = (url: string) => ({
    url,
    key: { k: 'key' },
    iv: 'iv',
    hashes: { sha256: 'hash' },
    v: 'v2',
  });

  it('ignores url when file is present', () => {
    const payload = normalizeMediaPayload(
      {
        msgtype: 'm.image',
        body: 'pic',
        url: 'mxc://hs/other',
        file: encrypted('mxc://hs/cipher'),
      },
      'm.image',
    );

    expect(payload?.mxc).toBeNull();
    expect(payload?.file?.url).toBe('mxc://hs/cipher');
  });

  it('ignores thumbnail_url when thumbnail_file is present', () => {
    const payload = normalizeMediaPayload(
      {
        msgtype: 'm.image',
        body: 'pic',
        file: encrypted('mxc://hs/cipher'),
        info: {
          thumbnail_url: 'mxc://hs/other-thumb',
          thumbnail_file: encrypted('mxc://hs/thumb-cipher'),
        },
      },
      'm.image',
    );

    expect(payload?.thumbnailMxc).toBeNull();
    expect(payload?.thumbnailFile?.url).toBe('mxc://hs/thumb-cipher');
  });
});
