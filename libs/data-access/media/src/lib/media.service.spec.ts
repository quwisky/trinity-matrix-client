import { effect } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, type Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EngineRequestError,
  engineFail,
  type EncryptedFileInfo,
  type MediaPayload,
} from '@trinity/util/matrix';
import type { MediaService } from './media.service';
import {
  PLAIN_BYTES,
  mediaServiceSetup,
  seedEncrypted,
  sessionWith,
} from './media.spec-harness';

/** Mirrors the (non-exported) CACHE_LIMIT in media.service.ts. */
const CACHE_LIMIT = 64;
/** Mirrors the (non-exported) CACHE_BYTE_LIMIT in media.service.ts. */
const CACHE_BYTE_LIMIT = 96 * 1024 * 1024;

const BOB = '@bob:example.org';

function plainMedia(mxc: string, mimeType = 'image/png'): MediaPayload {
  return {
    kind: 'image',
    mxc,
    file: null,
    filename: 'pic.png',
    mimeType,
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}

function encryptedMedia(file: EncryptedFileInfo): MediaPayload {
  return {
    kind: 'file',
    mxc: null,
    file,
    filename: 'secret.bin',
    mimeType: 'application/octet-stream',
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}

/** The same file with other key material: it names the same bytes but cannot decrypt them. */
function otherKey(file: EncryptedFileInfo, k = 'other'): EncryptedFileInfo {
  return { ...file, key: { ...file.key, k } };
}

/** The URL a resolve emits, or the failure code it errors with. */
async function settle(source: Observable<string>): Promise<string> {
  try {
    return await firstValueFrom(source);
  } catch (error: unknown) {
    return error instanceof EngineRequestError
      ? `failed:${error.failure.code}`
      : 'failed';
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve));

/** The screen's devicePixelRatio as the service reads it; tests set it before resolving. */
let devicePixelRatio = 1;
const setup = mediaServiceSetup(() => devicePixelRatio);

describe('MediaService', () => {
  beforeEach(() => {
    devicePixelRatio = 1;
  });

  afterEach(() => TestBed.resetTestingModule());

  it('resolves a full plaintext image through the active account and caches the result', async () => {
    const { svc, engine, content } = setup();
    const media = plainMedia('mxc://hs/abc');

    const url = await firstValueFrom(svc.resolveMedia(media, 'full'));

    expect(await engine.read(url)).toEqual(PLAIN_BYTES);
    expect(content).toHaveBeenCalledExactlyOnceWith(engine.alice, {
      source: { kind: 'plain', mxc: 'mxc://hs/abc' },
      format: { kind: 'file' },
      mimeType: 'image/png',
      downscaleTo: null,
    });

    // Re-resolving the same source+variant is served from cache (no 2nd request).
    const again = await firstValueFrom(svc.resolveMedia(media, 'full'));
    expect(again).toBe(url);
    expect(content).toHaveBeenCalledTimes(1);
  });

  it('uses an explicitly named account for both media reads and uploads', async () => {
    const { svc, engine, session, content, upload } = setup();
    session.set(sessionWith(BOB, [BOB, engine.alice]));

    await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/exact'), 'full', engine.alice),
    );
    await firstValueFrom(
      svc.uploadMedia(
        new File([new Uint8Array([1])], 'exact.txt', { type: 'text/plain' }),
        false,
        undefined,
        undefined,
        engine.alice,
      ),
    );

    expect(content.mock.calls[0]?.[0]).toBe(engine.alice);
    expect(upload.mock.calls[0]?.[0]).toBe(engine.alice);
  });

  it('keeps media resolved under one account apart from the same mxc under another', async () => {
    const { svc, engine, session, content } = setup();
    session.set(sessionWith(engine.alice, [engine.alice, BOB]));
    const media = plainMedia('mxc://hs/shared');

    const alice = await settle(svc.resolveMedia(media, 'full'));
    const bob = await settle(svc.resolveMedia(media, 'full', BOB));

    expect(bob).not.toBe(alice);
    expect(content.mock.calls.map(([account]) => account)).toEqual([
      engine.alice,
      BOB,
    ]);
  });

  it('never serves a URL resolved under an earlier session of the same account', async () => {
    const { svc, engine, session, content } = setup();
    const media = plainMedia('mxc://hs/relogin');
    const before = await firstValueFrom(svc.resolveMedia(media, 'full'));

    // A re-login keeps the account id but registers a new client.
    session.set(sessionWith(engine.alice, [engine.alice], 2));
    const after = await firstValueFrom(svc.resolveMedia(media, 'full'));

    expect(after).not.toBe(before);
    expect(content).toHaveBeenCalledTimes(2);
  });

  it('does not make an effect that resolves media track the account status', () => {
    const { svc, engine, session } = setup();
    let runs = 0;
    TestBed.runInInjectionContext(() =>
      effect(() => {
        runs++;
        svc.resolveMedia(plainMedia('mxc://hs/effect'), 'full').subscribe();
        svc.drop(null, {
          media: plainMedia('mxc://hs/other'),
          variant: 'full',
        });
      }),
    );
    TestBed.tick();

    const snapshot = sessionWith(engine.alice, [engine.alice]);
    session.set({
      ...snapshot,
      accounts: snapshot.accounts.map((a) => ({
        ...a,
        syncState: 'reconnecting',
        waitingCount: 3,
      })),
    });
    TestBed.tick();

    expect(runs).toBe(1);
  });

  it('asks the engine to forget its authenticated-media probes on releaseAll', () => {
    const { svc, engine } = setup();

    svc.releaseAll();

    expect(engine.probesForgotten).toBe(1);
  });

  it('decrypts an encrypted attachment and caches the plaintext URL', async () => {
    const { svc, engine, content, requests } = setup();
    const file = await seedEncrypted(engine, 'mxc://hs/ciphertext');
    const media = encryptedMedia(file);

    const url = await firstValueFrom(svc.resolveMedia(media, 'full'));

    expect(await engine.read(url)).toEqual(new Uint8Array([7, 7, 7]));
    expect(requests()[0]?.source).toEqual({ kind: 'encrypted', file });

    // Re-resolving the same source is served from cache — no second request.
    const again = await firstValueFrom(svc.resolveMedia(media, 'full'));
    expect(again).toBe(url);
    expect(content).toHaveBeenCalledTimes(1);
  });

  it('decrypts an encrypted thumbnail from info.thumbnail_file', async () => {
    const { svc, engine, requests } = setup();
    const thumbnailFile = await seedEncrypted(engine, 'mxc://hs/thumb-ct');
    const media: MediaPayload = {
      ...encryptedMedia(await seedEncrypted(engine, 'mxc://hs/ciphertext')),
      kind: 'image',
      thumbnailFile,
      thumbnailMimeType: 'image/jpeg',
    };

    await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));

    // The encrypted thumbnail — not the full original — is resolved.
    expect(requests()[0]).toMatchObject({
      source: { kind: 'encrypted', file: thumbnailFile },
      mimeType: 'image/jpeg',
    });
  });

  it('propagates a failed hash check instead of rendering ciphertext', async () => {
    const { svc, engine } = setup();
    const file = await seedEncrypted(engine, 'mxc://hs/ciphertext');

    const result = await settle(
      svc.resolveMedia(
        encryptedMedia({ ...file, hashes: { sha256: 'tampered' } }),
        'full',
      ),
    );

    expect(result).toBe('failed:media-unavailable');
  });

  it('decrypts an encrypted image once and shares it between the thumbnail and full views', async () => {
    const { svc, engine, content } = setup();
    // Encrypted image with no bundled thumbnail_file: both variants resolve the
    // same ciphertext, so they must share a single fetch + decrypt.
    const media: MediaPayload = {
      ...encryptedMedia(await seedEncrypted(engine, 'mxc://hs/ciphertext')),
      kind: 'image',
    };

    const thumb = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
    const full = await firstValueFrom(svc.resolveMedia(media, 'full'));

    expect(full).toBe(thumb);
    expect(content).toHaveBeenCalledTimes(1);
  });

  describe('cache keys follow the integrity data that produced the bytes', () => {
    it('decrypts a second event with the same file.url but other key material on its own', async () => {
      const { svc, engine, content, requests } = setup();
      const file = await seedEncrypted(engine, 'mxc://hs/shared');
      const second = encryptedMedia(otherKey(file));

      const a = await settle(svc.resolveMedia(encryptedMedia(file), 'full'));
      const b = await settle(svc.resolveMedia(second, 'full'));

      expect(b).not.toBe(a);
      expect(content).toHaveBeenCalledTimes(2);
      expect(requests()[1]?.source).toEqual({
        kind: 'encrypted',
        file: second.file,
      });
    });

    it('does not share an in-flight decrypt with an event carrying other key material', async () => {
      const { svc, engine, requests } = setup();
      const file = await seedEncrypted(engine, 'mxc://hs/shared');
      const first = encryptedMedia(file);
      const second = encryptedMedia(otherKey(file));

      const [a, b] = await Promise.all([
        settle(svc.resolveMedia(first, 'full')),
        settle(svc.resolveMedia(second, 'full')),
      ]);

      expect(b).not.toBe(a);
      expect(
        requests().map((r) => r.source.kind === 'encrypted' && r.source.file),
      ).toEqual([first.file, second.file]);
    });

    it('fetches an event with both url and file from file.url and never caches it under url', async () => {
      const { svc, engine, content, requests } = setup();
      const file = await seedEncrypted(engine, 'mxc://hs/y');
      const mixed: MediaPayload = {
        ...encryptedMedia(file),
        mxc: 'mxc://hs/x',
      };

      const mixedUrl = await firstValueFrom(svc.resolveMedia(mixed, 'full'));
      const plainX = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/x'), 'full'),
      );
      const encryptedY = await firstValueFrom(
        svc.resolveMedia(encryptedMedia(file), 'full'),
      );

      expect(requests()[0]?.source).toEqual({ kind: 'encrypted', file });
      expect(plainX).not.toBe(mixedUrl);
      expect(encryptedY).toBe(mixedUrl);
      expect(content).toHaveBeenCalledTimes(2);
    });

    it('keeps a plaintext url apart from an encrypted file.url naming the same media', async () => {
      const { svc, engine, content } = setup();
      const file = await seedEncrypted(engine, 'mxc://hs/x');

      const encrypted = await firstValueFrom(
        svc.resolveMedia(encryptedMedia(file), 'full'),
      );
      const plain = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/x'), 'full'),
      );

      expect(plain).not.toBe(encrypted);
      expect(content).toHaveBeenCalledTimes(2);
    });

    it('still serves the same event from the cache', async () => {
      const { svc, engine, content } = setup();
      const file = await seedEncrypted(engine, 'mxc://hs/same');

      const a = await firstValueFrom(
        svc.resolveMedia(encryptedMedia(file), 'full'),
      );
      const b = await firstValueFrom(
        svc.resolveMedia(encryptedMedia({ ...file }), 'full'),
      );

      expect(b).toBe(a);
      expect(content).toHaveBeenCalledTimes(1);
    });

    it('keys an encrypted thumbnail by its own key material', async () => {
      const { svc, engine, requests } = setup();
      const full = await seedEncrypted(engine, 'mxc://hs/full');
      const thumbnail = await seedEncrypted(engine, 'mxc://hs/thumb');
      const withThumb = (thumbnailFile: EncryptedFileInfo): MediaPayload => ({
        ...encryptedMedia(full),
        kind: 'image',
        thumbnailMxc: 'mxc://hs/thumb-plain',
        thumbnailFile,
      });
      const first = withThumb(thumbnail);
      const second = withThumb(otherKey(thumbnail));

      const a = await settle(svc.resolveMedia(first, 'thumbnail'));
      const again = await settle(svc.resolveMedia(first, 'thumbnail'));
      const b = await settle(svc.resolveMedia(second, 'thumbnail'));
      const plainThumb = await settle(
        svc.resolveMedia(plainMedia('mxc://hs/thumb'), 'full'),
      );

      expect(again).toBe(a);
      expect(b).not.toBe(a);
      expect(plainThumb).not.toBe(a);
      expect(
        requests()
          .slice(0, 2)
          .map((r) => r.source.kind === 'encrypted' && r.source.file),
      ).toEqual([first.thumbnailFile, second.thumbnailFile]);
    });

    it('caches nothing for a failed decrypt', async () => {
      const { svc, engine, content } = setup();
      const media = encryptedMedia(await seedEncrypted(engine, 'mxc://hs/bad'));
      content.mockReturnValueOnce(
        of(
          engineFail({
            kind: 'unexpected',
            code: 'media-unavailable',
            diagnostic: { kind: 'unexpected' },
          }),
        ),
      );

      expect(await settle(svc.resolveMedia(media, 'full'))).toBe(
        'failed:media-unavailable',
      );
      await firstValueFrom(svc.resolveMedia(media, 'full'));

      expect(content).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['key', (file: EncryptedFileInfo) => otherKey(file)],
      [
        'iv',
        (file: EncryptedFileInfo) => ({
          ...file,
          iv: 'AAAAAAAAAAAAAAAAAAAAAA',
        }),
      ],
      [
        'hash',
        (file: EncryptedFileInfo) => ({ ...file, hashes: { sha256: 'h2' } }),
      ],
      ['version', (file: EncryptedFileInfo) => ({ ...file, v: 'v1' })],
    ])(
      'decrypts an event differing only in its %s on its own',
      async (_, change) => {
        const { svc, engine, content, requests } = setup();
        const file = await seedEncrypted(engine, 'mxc://hs/shared');
        const second = change(file);

        const a = await settle(svc.resolveMedia(encryptedMedia(file), 'full'));
        const b = await settle(
          svc.resolveMedia(encryptedMedia(second), 'full'),
        );

        expect(b).not.toBe(a);
        expect(content).toHaveBeenCalledTimes(2);
        expect(requests()[1]?.source).toEqual({
          kind: 'encrypted',
          file: second,
        });
      },
    );

    it('fails an event with an unknown version instead of serving the cached bytes', async () => {
      const { svc, engine, content } = setup();
      const file = await seedEncrypted(engine, 'mxc://hs/shared');
      await firstValueFrom(svc.resolveMedia(encryptedMedia(file), 'full'));

      expect(
        await settle(
          svc.resolveMedia(encryptedMedia({ ...file, v: 'v9' }), 'full'),
        ),
      ).toBe('failed:media-unavailable');
      expect(content).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        'encrypted',
        async (svc: Setup) => {
          const file = await seedEncrypted(svc.engine, 'mxc://hs/typed');
          return (mimeType: string) => ({ ...encryptedMedia(file), mimeType });
        },
      ],
      [
        'plaintext',
        async () => (mimeType: string) =>
          plainMedia('mxc://hs/typed', mimeType),
      ],
    ])('keeps %s media declared with another type apart', async (_, make) => {
      const world = setup();
      const media = await make(world);
      const { svc, requests } = world;

      const png = await firstValueFrom(
        svc.resolveMedia(media('image/png'), 'full'),
      );
      const jpeg = await firstValueFrom(
        svc.resolveMedia(media('image/jpeg'), 'full'),
      );

      expect(jpeg).not.toBe(png);
      expect(requests().map((r) => r.mimeType)).toEqual([
        'image/png',
        'image/jpeg',
      ]);
    });
  });

  describe('encrypted image without a bundled thumbnail', () => {
    async function encryptedImage(
      world: Setup,
      mimeType: string,
    ): Promise<MediaPayload> {
      return {
        ...encryptedMedia(
          await seedEncrypted(world.engine, 'mxc://hs/ciphertext'),
        ),
        kind: 'image',
        mimeType,
      };
    }

    // A 2x screen: the display bucket is 640 px, which these expectations assume.
    beforeEach(() => {
      devicePixelRatio = 2;
    });

    it('asks for a downscaled thumbnail under its own key and the original for full', async () => {
      const world = setup();
      const { svc, content, requests } = world;
      const media = await encryptedImage(world, 'image/jpeg');

      const thumb = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      const full = await firstValueFrom(svc.resolveMedia(media, 'full'));

      expect(requests().map((r) => [r.mimeType, r.downscaleTo])).toEqual([
        ['image/jpeg', 640],
        ['image/jpeg', null],
      ]);
      expect(full).not.toBe(thumb);
      // And the thumbnail stays cached under its own key.
      expect(await firstValueFrom(svc.resolveMedia(media, 'thumbnail'))).toBe(
        thumb,
      );
      expect(content).toHaveBeenCalledTimes(2);
    });

    it.each([
      [' IMAGE/JPEG; q=1 ', 'image/jpeg'],
      ['image/jpg', 'image/jpeg'],
      ['image/png; name="a;b"', 'image/png'],
    ])(
      'downscales an encrypted image declared %j like its plain form',
      async (declared, safe) => {
        const world = setup();

        await firstValueFrom(
          world.svc.resolveMedia(
            await encryptedImage(world, declared),
            'thumbnail',
          ),
        );

        expect(world.requests()[0]).toMatchObject({
          mimeType: safe,
          downscaleTo: 640,
        });
      },
    );

    it('shares one request across concurrent thumbnail resolves', async () => {
      const world = setup();
      const media = await encryptedImage(world, 'image/jpeg');

      const [a, b] = await Promise.all([
        firstValueFrom(world.svc.resolveMedia(media, 'thumbnail')),
        firstValueFrom(world.svc.resolveMedia(media, 'thumbnail')),
      ]);

      expect(a).toBe(b);
      expect(world.content).toHaveBeenCalledTimes(1);
    });

    it.each([
      'image/avif',
      'image/bmp',
      'image/x-icon',
      'image/tiff',
      'image/heic',
      'image/gif',
      'image/webp',
      'image/apng',
      'image/svg+xml',
    ])(
      'skips downscaling %s and shares the original between thumbnail and full',
      async (mimeType) => {
        const world = setup();
        const media = await encryptedImage(world, mimeType);

        const thumb = await firstValueFrom(
          world.svc.resolveMedia(media, 'thumbnail'),
        );
        const full = await firstValueFrom(
          world.svc.resolveMedia(media, 'full'),
        );

        expect(world.requests()[0]?.downscaleTo).toBeNull();
        expect(full).toBe(thumb);
        expect(world.content).toHaveBeenCalledTimes(1);
      },
    );

    it('shares one cache entry for thumbnail and full when the event says the image is small', async () => {
      const world = setup();
      const media = {
        ...(await encryptedImage(world, 'image/jpeg')),
        width: 640,
        height: 400,
      };

      const thumb = await firstValueFrom(
        world.svc.resolveMedia(media, 'thumbnail'),
      );
      const full = await firstValueFrom(world.svc.resolveMedia(media, 'full'));

      expect(full).toBe(thumb);
      expect(world.requests()[0]?.downscaleTo).toBeNull();
      expect(world.content).toHaveBeenCalledTimes(1);
    });

    it('still downscales when the event only claims one dimension', async () => {
      const world = setup();

      await firstValueFrom(
        world.svc.resolveMedia(
          { ...(await encryptedImage(world, 'image/jpeg')), width: 300 },
          'thumbnail',
        ),
      );

      expect(world.requests()[0]?.downscaleTo).toBe(640);
    });

    it('stores nothing when releaseAll lands mid-request', async () => {
      const world = setup();
      const open = world.park();
      const emitted = vi.fn();

      world.svc
        .resolveMedia(await encryptedImage(world, 'image/jpeg'), 'thumbnail')
        .subscribe(emitted);
      world.svc.releaseAll();
      open();
      await tick();

      expect(emitted).not.toHaveBeenCalled();
      expect(world.engine.liveUrls()).toEqual([]);
    });

    it('does not downscale an encrypted thumbnail bundled in the event', async () => {
      const world = setup();
      const thumbnailFile = await seedEncrypted(
        world.engine,
        'mxc://hs/thumb-ct',
      );

      await firstValueFrom(
        world.svc.resolveMedia(
          {
            ...(await encryptedImage(world, 'image/jpeg')),
            thumbnailFile,
            thumbnailMimeType: 'image/jpeg',
          },
          'thumbnail',
        ),
      );

      expect(world.requests()[0]).toMatchObject({
        source: { kind: 'encrypted', file: thumbnailFile },
        downscaleTo: null,
      });
    });

    it('leaves the server-resized plaintext thumbnail path alone', async () => {
      const world = setup();

      await firstValueFrom(
        world.svc.resolveMedia(
          plainMedia('mxc://hs/plain', 'image/jpeg'),
          'thumbnail',
        ),
      );

      expect(world.requests()[0]).toMatchObject({
        format: { kind: 'thumbnail', width: 640, height: 640 },
        downscaleTo: null,
      });
    });

    it.each([
      [1, 320],
      [2, 640],
      [3, 960],
    ])(
      'downscales a decrypted original on a %sx screen to a %i px edge',
      async (dpr, edge) => {
        devicePixelRatio = dpr;
        const world = setup();

        await firstValueFrom(
          world.svc.resolveMedia(
            await encryptedImage(world, 'image/jpeg'),
            'thumbnail',
          ),
        );

        expect(world.requests()[0]?.downscaleTo).toBe(edge);
      },
    );

    it('keeps an image the event says fits a 3x screen as is', async () => {
      devicePixelRatio = 3;
      const world = setup();
      const media = {
        ...(await encryptedImage(world, 'image/jpeg')),
        width: 960,
        height: 640,
      };

      const thumb = await firstValueFrom(
        world.svc.resolveMedia(media, 'thumbnail'),
      );
      const full = await firstValueFrom(world.svc.resolveMedia(media, 'full'));

      expect(full).toBe(thumb);
      expect(world.requests()[0]?.downscaleTo).toBeNull();
    });

    it('keeps a downscaled thumbnail per bucket and reuses it within one', async () => {
      const world = setup();
      const media = await encryptedImage(world, 'image/jpeg');

      const at2x = await firstValueFrom(
        world.svc.resolveMedia(media, 'thumbnail'),
      );
      devicePixelRatio = 1.5; // still the 640 px bucket
      const again = await firstValueFrom(
        world.svc.resolveMedia(media, 'thumbnail'),
      );
      devicePixelRatio = 1;
      const at1x = await firstValueFrom(
        world.svc.resolveMedia(media, 'thumbnail'),
      );

      expect(again).toBe(at2x);
      expect(at1x).not.toBe(at2x);
      expect(world.requests().map((r) => r.downscaleTo)).toEqual([640, 320]);
    });

    it('decrypts and downscales a thumbnail with other key material on its own', async () => {
      const world = setup();
      const media = await encryptedImage(world, 'image/jpeg');
      const other: MediaPayload = {
        ...media,
        file: otherKey(media.file as EncryptedFileInfo),
      };

      const first = await settle(world.svc.resolveMedia(media, 'thumbnail'));
      const second = await settle(world.svc.resolveMedia(other, 'thumbnail'));

      expect(second).not.toBe(first);
      expect(
        world
          .requests()
          .map((r) => [
            r.source.kind === 'encrypted' && r.source.file,
            r.downscaleTo,
          ]),
      ).toEqual([
        [media.file, 640],
        [other.file, 640],
      ]);
    });
  });

  describe('display thumbnail size', () => {
    it.each([
      [1, 320],
      [1.25, 640],
      [2, 640],
      [2.5, 960],
      [3, 960],
      [4, 960],
    ])(
      'asks the server for a %sx screen thumbnail at %i px',
      async (dpr, edge) => {
        devicePixelRatio = dpr;
        const { svc, requests } = setup();

        await firstValueFrom(
          svc.resolveMedia(plainMedia('mxc://hs/plain'), 'thumbnail'),
        );

        expect(requests()[0]?.format).toEqual({
          kind: 'thumbnail',
          width: edge,
          height: edge,
          method: 'scale',
          animated: false,
        });
      },
    );

    it('keeps a server thumbnail per bucket and reuses it within one', async () => {
      const { svc, requests } = setup();
      const media = plainMedia('mxc://hs/plain');

      const at1x = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      devicePixelRatio = 2;
      const at2x = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      devicePixelRatio = 1.75; // the same 640 px bucket
      const again = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));

      expect(at2x).not.toBe(at1x);
      expect(again).toBe(at2x);
      expect(
        requests().map((r) => r.format.kind === 'thumbnail' && r.format.width),
      ).toEqual([320, 640]);
    });

    it('keys a bundled thumbnail and the full rendition without a bucket', async () => {
      const { svc, content } = setup();
      const media = {
        ...plainMedia('mxc://hs/plain'),
        thumbnailMxc: 'mxc://hs/thumb',
      };

      const thumb1x = await firstValueFrom(
        svc.resolveMedia(media, 'thumbnail'),
      );
      const full1x = await firstValueFrom(svc.resolveMedia(media, 'full'));
      devicePixelRatio = 3;
      const thumb3x = await firstValueFrom(
        svc.resolveMedia(media, 'thumbnail'),
      );
      const full3x = await firstValueFrom(svc.resolveMedia(media, 'full'));

      expect(thumb3x).toBe(thumb1x);
      expect(full3x).toBe(full1x);
      expect(content).toHaveBeenCalledTimes(2);
    });
  });

  it('shares one in-flight request across concurrent resolves of the same source', async () => {
    const { svc, content } = setup();
    const media = plainMedia('mxc://hs/concurrent');

    // Both subscribe before the first resolves — they must share one request.
    const [a, b] = await Promise.all([
      firstValueFrom(svc.resolveMedia(media, 'full')),
      firstValueFrom(svc.resolveMedia(media, 'full')),
    ]);

    expect(a).toBe(b);
    expect(content).toHaveBeenCalledTimes(1);
  });

  it('releaseAll cancels in-flight work so a late completion cannot repopulate the cache', async () => {
    const { svc, engine, park } = setup();
    const open = park();

    const seen: string[] = [];
    svc
      .resolveMedia(plainMedia('mxc://hs/pending'), 'full')
      .subscribe({ next: (u) => seen.push(u), error: () => undefined });

    // Tear down while the request is still pending, then let it complete late.
    svc.releaseAll();
    open();
    await tick();

    // The orphaned completion mints no URL and stores nothing.
    expect(seen).toEqual([]);
    expect(engine.liveUrls()).toEqual([]);
  });

  it('evicts least recently used unpinned entries once the byte budget is exceeded', async () => {
    const { svc, released, reportSize } = setup();
    reportSize(40);
    expect(3 * 40 * 1024 * 1024).toBeGreaterThan(CACHE_BYTE_LIMIT);

    const a = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
    );
    const b = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'),
    );
    expect(released()).toEqual([]); // 80 MB fits
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

    expect(released()).toEqual([a]); // 120 MB > 96 MB
    expect(released()).not.toContain(b);
  });

  it('keeps a pinned entry even when it alone exceeds the byte budget', async () => {
    const { svc, released, reportSize } = setup();
    reportSize(60);
    const a = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
    );
    svc.pin(a);
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'));
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

    expect(released()).not.toContain(a);
    // Eviction did run, and skipped only the pinned entry: b is the oldest unpinned.
    expect(released()).toHaveLength(1);
  });

  it('treats a cache hit as recent use when evicting for the byte budget', async () => {
    const { svc, released, reportSize } = setup();
    reportSize(40);
    const a = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
    );
    const b = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'),
    );
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/a'), 'full')); // touch a
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

    expect(released()).toEqual([b]);
    expect(released()).not.toContain(a);
  });

  it('does not release a lone blob that is over the byte budget before it can be pinned', async () => {
    const { svc, released, reportSize } = setup();
    reportSize(CACHE_BYTE_LIMIT / 1024 / 1024 + 4);

    const url = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/huge'), 'full'),
    );

    expect(released()).not.toContain(url);
  });

  it('never evicts pinned URLs past the cache limit, and releaseAll releases everything', async () => {
    const { svc, engine, content, released } = setup();

    // Resolve one source and pin its URL (an on-screen thumbnail).
    const pinned = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/0'), 'full'),
    );
    svc.pin(pinned);

    // Fill past the limit with distinct sources to force eviction.
    for (let i = 1; i <= CACHE_LIMIT; i++) {
      await firstValueFrom(
        svc.resolveMedia(plainMedia(`mxc://hs/${i}`), 'full'),
      );
    }

    const evicted = released();
    expect(evicted.length).toBeGreaterThan(0); // some unpinned URL was evicted
    expect(evicted).not.toContain(pinned); // ...but never the pinned one

    // releaseAll releases every remaining URL — including the pinned one — and clears.
    svc.releaseAll();
    expect(released()).toContain(pinned);
    expect(engine.liveUrls()).toEqual([]);

    // The cache is empty afterward: the same source is requested again.
    content.mockClear();
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/0'), 'full'));
    expect(content).toHaveBeenCalledTimes(1);
  });

  describe('pin counting', () => {
    /** Resolve `a` (pinned per the test), then fill the cache past its byte budget. */
    async function pressure(svc: MediaService): Promise<void> {
      await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'));
      await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));
    }

    it('keeps a URL pinned while any of two pins remains', async () => {
      const { svc, released, reportSize } = setup();
      reportSize(40);
      const a = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.pin(a); // the row
      svc.pin(a); // the lightbox, sharing the same blob URL
      svc.unpin(a); // one of them leaves

      await pressure(svc);
      svc.releaseUnpinned();

      expect(released()).not.toContain(a);
    });

    it('makes a URL evictable once its last pin is released', async () => {
      const { svc, released } = setup();
      const a = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.pin(a);
      svc.pin(a);
      svc.unpin(a);
      svc.unpin(a);

      svc.releaseUnpinned();

      expect(released()).toContain(a);
    });

    it('ignores an extra unpin instead of counting below zero', async () => {
      const { svc, released } = setup();
      const a = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.unpin(a); // never pinned
      svc.pin(a);

      svc.releaseUnpinned();

      // A count that went to -1 would now be 0 and evictable.
      expect(released()).not.toContain(a);
    });

    it('forgets every pin on releaseAll', async () => {
      const { svc, released } = setup();
      const before = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.pin(before);
      svc.pin(before);
      svc.releaseAll();

      // URLs are fresh after a release, but the pins are gone too: the next one is evictable.
      const after = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.releaseUnpinned();

      expect(released()).toContain(after);
    });
  });

  describe('drop', () => {
    const full = (mxc = 'mxc://hs/a') => ({
      media: plainMedia(mxc),
      variant: 'full' as const,
    });

    it('releases and removes the entry when the dropping caller held the last pin', async () => {
      const { svc, content, released } = setup();
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a);
      content.mockClear();

      svc.drop(a, full());

      expect(released()).toEqual([a]);
      // Gone from the cache: the next resolve requests it again, under a fresh URL.
      const again = await firstValueFrom(
        svc.resolveMedia(full().media, 'full'),
      );
      expect(content).toHaveBeenCalledTimes(1);
      expect(again).not.toBe(a);
    });

    it('drops the rendition of the account it names', async () => {
      const { svc, engine, session, released } = setup();
      session.set(sessionWith(BOB, [BOB, engine.alice]));
      const a = await firstValueFrom(
        svc.resolveMedia(full().media, 'full', engine.alice),
      );
      svc.pin(a);

      svc.drop(a, full()); // the active account's rendition: not this one
      expect(released()).toEqual([]);
      svc.pin(a);
      svc.drop(a, { ...full(), accountId: engine.alice });

      expect(released()).toEqual([a]);
    });

    it('only releases its own pin while another view still shows the URL', async () => {
      const { svc, content, released } = setup();
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a); // the row
      svc.pin(a); // the lightbox
      content.mockClear();

      svc.drop(a, full());

      expect(released()).toEqual([]);
      // Still cached for the row.
      await expect(
        firstValueFrom(svc.resolveMedia(full().media, 'full')),
      ).resolves.toBe(a);
      expect(content).not.toHaveBeenCalled();
      // The row's pin is the last one; dropping it frees the entry.
      svc.drop(a, full());
      expect(released()).toEqual([a]);
    });

    it('takes the dropped bytes off the budget', async () => {
      const { svc, released, reportSize } = setup();
      reportSize(40);
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a);
      const b = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'),
      );

      svc.drop(a, full());
      // b + c = 80 MB fits once a's 40 MB are no longer counted.
      await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

      expect(released()).not.toContain(b);
    });

    it('does not release a URL the cache no longer holds for that rendition', async () => {
      const { svc, released } = setup();
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a);
      svc.releaseAll(); // a is released and forgotten; a later resolve gets a new URL
      const fresh = await firstValueFrom(
        svc.resolveMedia(full().media, 'full'),
      );
      svc.pin(fresh);
      const before = released().length;

      svc.drop(a, full()); // a stale caller drops what it held before the release

      expect(released()).toHaveLength(before);
    });

    it('cancels an in-flight resolve nobody waits for, so a late completion is not cached', async () => {
      const { svc, engine, content, park } = setup();
      const open = park();
      const seen: string[] = [];
      const sub = svc
        .resolveMedia(full().media, 'full')
        .subscribe((u) => seen.push(u));

      sub.unsubscribe();
      svc.drop(null, full());
      open();
      await tick();

      expect(seen).toEqual([]);
      // No URL survives the late completion.
      expect(engine.liveUrls()).toEqual([]);
      // And the next resolve is a fresh request, not the abandoned one.
      content.mockClear();
      await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      expect(content).toHaveBeenCalledTimes(1);
    });

    it('completes a resolve obtained before the drop but subscribed after it empty', async () => {
      const { svc, park } = setup();
      const open = park();
      const early = svc.resolveMedia(full().media, 'full');
      const first = early.subscribe();
      first.unsubscribe();

      svc.drop(null, full());
      open();
      const seen: string[] = [];
      let completed = false;
      early.subscribe({
        next: (u) => seen.push(u),
        complete: () => (completed = true),
      });
      await tick();

      expect(seen).toEqual([]);
      expect(completed).toBe(true);
    });

    it('leaves an in-flight resolve running while another view still waits for it', async () => {
      const { svc, park } = setup();
      const open = park();
      const dropped = svc.resolveMedia(full().media, 'full').subscribe();
      const waiting = firstValueFrom(svc.resolveMedia(full().media, 'full'));

      dropped.unsubscribe();
      svc.drop(null, full());
      open();

      await expect(waiting).resolves.toMatch(/^blob:/);
    });
  });

  it('releaseUnpinned drops unpinned entries and keeps pinned ones resolvable from cache', async () => {
    const { svc, content, released } = setup();
    const pinned = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/on-screen'), 'full'),
    );
    svc.pin(pinned);
    const offScreen = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/off-screen'), 'full'),
    );
    content.mockClear();

    svc.releaseUnpinned();

    expect(released()).toEqual([offScreen]);
    // The pinned entry is still cached: resolving it again neither refetches nor changes URL.
    await expect(
      firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/on-screen'), 'full'),
      ),
    ).resolves.toBe(pinned);
    expect(content).not.toHaveBeenCalled();
    // The released one is requested again on its next use.
    await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/off-screen'), 'full'),
    );
    expect(content).toHaveBeenCalledTimes(1);
  });

  it('releaseUnpinned lets in-flight resolutions finish', async () => {
    const { svc } = setup();
    const pending = firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/loading'), 'full'),
    );

    svc.releaseUnpinned();

    await expect(pending).resolves.toMatch(/^blob:/);
  });

  describe('downloadMedia', () => {
    /** Read a fake URL as fetch would read a blob: URL. */
    function stubFetch(world: Setup): void {
      vi.stubGlobal('fetch', async (url: string) => ({
        ok: true,
        status: 200,
        blob: async () => new Blob([(await world.engine.read(url)).slice()]),
      }));
    }

    afterEach(() => vi.unstubAllGlobals());

    it('returns the full bytes paired with the filename and releases its URL', async () => {
      const world = setup();
      stubFetch(world);

      const { blob, filename } = await firstValueFrom(
        world.svc.downloadMedia(plainMedia('mxc://hs/doc')),
      );

      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PLAIN_BYTES);
      expect(filename).toBe('pic.png');
      expect(world.requests()[0]?.format).toEqual({ kind: 'file' });
      expect(world.engine.liveUrls()).toEqual([]);
    });

    it('fails when the media cannot be read', async () => {
      const world = setup();
      stubFetch(world);
      const file = await seedEncrypted(world.engine, 'mxc://hs/doc');

      await expect(
        firstValueFrom(world.svc.downloadMedia(encryptedMedia(otherKey(file)))),
      ).rejects.toBeInstanceOf(EngineRequestError);
    });
  });

  describe('display types of resolved media', () => {
    const NOT_DISPLAYABLE = [
      'image/svg+xml',
      'image/svg+xml; charset=utf-8',
      'image/svg+xml ',
      'text/html',
      'text/html; charset=utf-8',
      'application/xhtml+xml',
      'text/xml',
      '',
    ];
    const OPAQUE = 'application/octet-stream';
    const ENCRYPTED: EncryptedFileInfo = {
      url: 'mxc://hs/ciphertext',
      key: {} as JsonWebKey,
      iv: 'iv',
      hashes: { sha256: 'abc' },
      v: 'v2',
    };

    /** The display type the service asked the engine to give the bytes. */
    async function requestedType(
      media: MediaPayload,
      variant: 'thumbnail' | 'full',
    ): Promise<string | undefined> {
      const { svc, requests } = setup();
      await settle(svc.resolveMedia(media, variant));
      return requests()[0]?.mimeType;
    }

    it.each(NOT_DISPLAYABLE)(
      'gives a plaintext image declared %j an opaque type',
      async (declared) => {
        expect(
          await requestedType(plainMedia('mxc://hs/a', declared), 'full'),
        ).toBe(OPAQUE);
      },
    );

    it.each(NOT_DISPLAYABLE)(
      'gives an encrypted image declared %j an opaque type',
      async (declared) => {
        expect(
          await requestedType(
            { ...encryptedMedia(ENCRYPTED), kind: 'image', mimeType: declared },
            'full',
          ),
        ).toBe(OPAQUE);
      },
    );

    it.each(NOT_DISPLAYABLE)(
      'gives a plaintext thumbnail declared %j an opaque type',
      async (declared) => {
        expect(
          await requestedType(
            {
              ...plainMedia('mxc://hs/original'),
              thumbnailMxc: 'mxc://hs/thumb',
              thumbnailMimeType: declared,
            },
            'thumbnail',
          ),
        ).toBe(OPAQUE);
      },
    );

    it.each(NOT_DISPLAYABLE)(
      'gives an encrypted thumbnail declared %j an opaque type',
      async (declared) => {
        expect(
          await requestedType(
            {
              ...plainMedia('mxc://hs/original'),
              thumbnailFile: ENCRYPTED,
              thumbnailMimeType: declared,
            },
            'thumbnail',
          ),
        ).toBe(OPAQUE);
      },
    );

    it('gives a sticker or pack image, resolved without a bundled thumbnail, an opaque type', async () => {
      expect(
        await requestedType(
          plainMedia('mxc://hs/inherit', 'image/svg+xml; charset=utf-8'),
          'thumbnail',
        ),
      ).toBe(OPAQUE);
    });

    it('gives a saved attachment an opaque type as well', async () => {
      const world = setup();
      vi.stubGlobal('fetch', async () => ({
        ok: true,
        status: 200,
        blob: async () => new Blob([]),
      }));

      const { filename } = await firstValueFrom(
        world.svc.downloadMedia(plainMedia('mxc://hs/save', 'image/svg+xml')),
      );

      expect(world.requests()[0]?.mimeType).toBe(OPAQUE);
      expect(filename).toBe('pic.png');
      vi.unstubAllGlobals();
    });

    it.each([
      ['image/png', 'image/png'],
      ['IMAGE/JPEG; q=1', 'image/jpeg'],
      [' image/webp ', 'image/webp'],
      ['audio/ogg; codecs=opus', 'audio/ogg'],
      ['video/mp4', 'video/mp4'],
      ['image/jpg', 'image/jpeg'],
      ['audio/3gpp', 'audio/3gpp'],
      ['video/x-m4v', 'video/x-m4v'],
    ])(
      'types a plaintext attachment declared %j as %s',
      async (declared, expected) => {
        expect(
          await requestedType(plainMedia('mxc://hs/ok', declared), 'full'),
        ).toBe(expected);
      },
    );
  });
});

type Setup = ReturnType<typeof setup>;
