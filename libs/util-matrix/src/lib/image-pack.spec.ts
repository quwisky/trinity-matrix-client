import { describe, expect, it } from 'vitest';
import { parseStickerPack } from './image-pack';

describe('parseStickerPack', () => {
  it('parses images and resolves body, info, and display name', () => {
    const pack = parseStickerPack(
      {
        pack: { display_name: 'Blobs' },
        images: {
          party: {
            url: 'mxc://hs/party',
            body: 'Party Blob',
            info: { w: 128, h: 120, mimetype: 'image/png', size: 4096 },
          },
        },
      },
      'user',
      'Personal',
    );

    expect(pack).toEqual({
      id: 'user',
      displayName: 'Blobs',
      images: [
        {
          shortcode: 'party',
          url: 'mxc://hs/party',
          body: 'Party Blob',
          width: 128,
          height: 120,
          mimeType: 'image/png',
          size: 4096,
        },
      ],
    });
  });

  it('falls back to the shortcode for a missing body and to the given name', () => {
    const pack = parseStickerPack(
      { images: { wave: { url: 'mxc://hs/wave' } } },
      'user',
      'Personal',
    );
    expect(pack?.displayName).toBe('Personal');
    expect(pack?.images[0]).toMatchObject({ shortcode: 'wave', body: 'wave' });
  });

  it('treats an image with no usage (and no pack usage) as a sticker', () => {
    const pack = parseStickerPack(
      { images: { a: { url: 'mxc://hs/a' } } },
      'p',
      'P',
    );
    expect(pack?.images).toHaveLength(1);
  });

  it('keeps only images usable as stickers', () => {
    const pack = parseStickerPack(
      {
        images: {
          onlyEmoji: { url: 'mxc://hs/e', usage: ['emoticon'] },
          onlySticker: { url: 'mxc://hs/s', usage: ['sticker'] },
          both: { url: 'mxc://hs/b', usage: ['emoticon', 'sticker'] },
        },
      },
      'p',
      'P',
    );
    expect(pack?.images.map((i) => i.shortcode)).toEqual([
      'onlySticker',
      'both',
    ]);
  });

  it("lets an image's usage override the pack usage in both directions", () => {
    const stickerPack = parseStickerPack(
      {
        pack: { usage: ['emoticon'] },
        images: {
          inherit: { url: 'mxc://hs/i' }, // inherits emoticon-only → excluded
          override: { url: 'mxc://hs/o', usage: ['sticker'] }, // included
        },
      },
      'p',
      'P',
    );
    expect(stickerPack?.images.map((i) => i.shortcode)).toEqual(['override']);
  });

  it('includes every image when the pack is declared sticker-usable', () => {
    const pack = parseStickerPack(
      {
        pack: { usage: ['sticker'] },
        images: { a: { url: 'mxc://hs/a' }, b: { url: 'mxc://hs/b' } },
      },
      'p',
      'P',
    );
    expect(pack?.images).toHaveLength(2);
  });

  it('drops images without an mxc url', () => {
    const pack = parseStickerPack(
      {
        images: {
          ok: { url: 'mxc://hs/ok' },
          http: { url: 'https://evil/x.png' },
          none: { body: 'no url' },
        },
      },
      'p',
      'P',
    );
    expect(pack?.images.map((i) => i.shortcode)).toEqual(['ok']);
  });

  it('returns null for malformed content or a pack with no sticker images', () => {
    expect(parseStickerPack(null, 'p', 'P')).toBeNull();
    expect(parseStickerPack({}, 'p', 'P')).toBeNull();
    expect(parseStickerPack({ images: {} }, 'p', 'P')).toBeNull();
    expect(
      parseStickerPack(
        { images: { e: { url: 'mxc://hs/e', usage: ['emoticon'] } } },
        'p',
        'P',
      ),
    ).toBeNull();
  });
});
