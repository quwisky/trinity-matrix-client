import { firstValueFrom } from 'rxjs';
import type { MatrixClient } from 'matrix-js-sdk';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { MediaService } from './media.service';
import type { MediaPayload } from '@trinity/util/matrix';
import {
  createObjectURL,
  decryptMock,
  fakeClient,
  fetchMock,
  mediaServiceSetup,
  okResponse,
  revokeObjectURL,
  useMediaGlobals,
} from './media.spec-harness';

// Stub attachment-crypto (now in @trinity/util/matrix): exercise MediaService's
// fetch→decrypt→blob and encrypt→upload wiring without a real WebCrypto `subtle`
// backend (absent under jsdom). Partial-mock so the module's other exports stay
// real; the crypto itself is round-tripped for real in attachment-crypto.spec.ts.
vi.mock('@trinity/util/matrix', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
  decryptAttachment: vi.fn(() =>
    Promise.resolve(new Uint8Array([7, 7, 7]).buffer),
  ),
  encryptAttachment: vi.fn(() =>
    Promise.resolve({
      data: new Uint8Array([9, 9, 9, 9]).buffer,
      info: { url: '', v: 'v2', key: {}, iv: 'iv', hashes: { sha256: 'h' } },
    }),
  ),
}));

// Wrap the metadata stripper so the upload tests can see that, and when, it ran, while it
// keeps doing the real work on real bytes.
vi.mock('./image-metadata/strip-file-metadata', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('./image-metadata/strip-file-metadata')
    >();
  return {
    ...real,
    withoutMediaMetadata: vi.fn(real.withoutMediaMetadata),
    bytesWithoutMediaMetadata: vi.fn(real.bytesWithoutMediaMetadata),
  };
});

/** Mirrors the (non-exported) CACHE_LIMIT in media.service.ts. */
const CACHE_LIMIT = 64;
/** Mirrors the (non-exported) CACHE_BYTE_LIMIT in media.service.ts. */
const CACHE_BYTE_LIMIT = 96 * 1024 * 1024;

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

function encryptedMedia(): MediaPayload {
  return {
    kind: 'file',
    mxc: null,
    file: {
      url: 'mxc://hs/ciphertext',
      key: {} as JsonWebKey,
      iv: 'iv',
      hashes: { sha256: 'abc' },
      v: 'v2',
    },
    filename: 'secret.bin',
    mimeType: 'application/octet-stream',
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}

/** Make every Blob report `mb` megabytes, so budget tests need not allocate them. */
function stubBlobSize(mb: number): void {
  const Orig = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class extends Orig {
      override get size(): number {
        return mb * 1024 * 1024;
      }
    },
  );
}

function failResponse(status = 404): Response {
  return {
    ok: false,
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as Response;
}

/** The screen's devicePixelRatio as the service reads it; tests set it before resolving. */
let devicePixelRatio = 1;
const setup = mediaServiceSetup(() => devicePixelRatio);

describe('MediaService', () => {
  useMediaGlobals();

  beforeEach(() => {
    devicePixelRatio = 1;
  });

  it('resolves a full plaintext image with an authenticated fetch and caches the result', async () => {
    const { svc } = setup(); // isVersionSupported → true
    const media = plainMedia('mxc://hs/abc');

    const url = await firstValueFrom(svc.resolveMedia(media, 'full'));

    expect(url).toBe('blob:obj-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer tok');

    // Re-resolving the same source+variant is served from cache (no 2nd fetch).
    const again = await firstValueFrom(svc.resolveMedia(media, 'full'));
    expect(again).toBe(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses an explicitly bound client for both media fetches and uploads', async () => {
    const { svc, client: activeClient } = setup();
    const exactClient = fakeClient({
      getAccessToken: vi.fn(() => 'exact-token'),
      uploadContent: vi
        .fn()
        .mockResolvedValue({ content_uri: 'mxc://exact/upload' }),
    });

    await firstValueFrom(
      svc.resolveMedia(
        plainMedia('mxc://hs/exact'),
        'full',
        exactClient as unknown as MatrixClient,
      ),
    );
    await firstValueFrom(
      svc.uploadMedia(
        new File([new Uint8Array([1])], 'exact.txt', {
          type: 'text/plain',
        }),
        false,
        undefined,
        undefined,
        exactClient as unknown as MatrixClient,
      ),
    );

    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe(
      'Bearer exact-token',
    );
    expect(exactClient.isVersionSupported).toHaveBeenCalledOnce();
    expect(exactClient.uploadContent).toHaveBeenCalledOnce();
    expect(activeClient.isVersionSupported).not.toHaveBeenCalled();
    expect(activeClient.uploadContent).not.toHaveBeenCalled();
  });

  it('re-probes authed-media support after releaseAll (account/homeserver switch)', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'));
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'));
    // The v1.11 capability probe is cached across resolves — one call so far.
    expect(client.isVersionSupported).toHaveBeenCalledTimes(1);

    // A logout→login can switch homeservers; releaseAll must drop the cached
    // probe so the next resolve re-checks (a stale result would break all media).
    svc.releaseAll();
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));
    expect(client.isVersionSupported).toHaveBeenCalledTimes(2);
  });

  it('uses the legacy media endpoint without an Authorization header when v1.11 is unsupported', async () => {
    const { svc } = setup({
      isVersionSupported: vi.fn().mockResolvedValue(false),
    });

    await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/legacy'), 'full'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers).toBeUndefined();
  });

  it('falls back to a legacy fetch when the authenticated request fails', async () => {
    const { svc } = setup(); // authed media supported
    fetchMock
      .mockResolvedValueOnce(failResponse(404)) // authed attempt fails
      .mockResolvedValueOnce(okResponse()); // legacy retry succeeds

    const url = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/flaky'), 'full'),
    );

    expect(url).toBe('blob:obj-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    // The fallback request is unauthenticated.
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined();
  });

  it('decrypts an encrypted attachment: downloads the ciphertext, decrypts, and caches the blob', async () => {
    const { svc } = setup();
    const media = encryptedMedia();

    const url = await firstValueFrom(svc.resolveMedia(media, 'full'));

    expect(url).toBe('blob:obj-1');
    // The ciphertext is fetched (authenticated) from content.file.url ...
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('ciphertext');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    // ... then handed to decryptAttachment with the per-file key material.
    expect(decryptMock).toHaveBeenCalledTimes(1);
    const [cipherArg, infoArg] = decryptMock.mock.calls[0];
    expect(cipherArg).toBeInstanceOf(ArrayBuffer);
    expect(infoArg).toMatchObject({
      url: 'mxc://hs/ciphertext',
      iv: 'iv',
      v: 'v2',
    });

    // Re-resolving the same source is served from cache — no second fetch/decrypt.
    const again = await firstValueFrom(svc.resolveMedia(media, 'full'));
    expect(again).toBe(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decryptMock).toHaveBeenCalledTimes(1);
  });

  it('decrypts an encrypted thumbnail from info.thumbnail_file', async () => {
    const { svc } = setup();
    const media: MediaPayload = {
      ...encryptedMedia(),
      kind: 'image',
      thumbnailFile: {
        url: 'mxc://hs/thumb-ciphertext',
        key: {} as JsonWebKey,
        iv: 'tiv',
        hashes: { sha256: 'thash' },
        v: 'v2',
      },
      thumbnailMimeType: 'image/jpeg',
    };

    await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));

    // The encrypted thumbnail ciphertext — not the full original — is resolved.
    expect(fetchMock.mock.calls[0][0]).toContain('thumb-ciphertext');
    expect(decryptMock.mock.calls[0][1]).toMatchObject({
      url: 'mxc://hs/thumb-ciphertext',
      iv: 'tiv',
    });
  });

  it('propagates a decryption failure (hash mismatch) instead of rendering ciphertext', async () => {
    const { svc } = setup();
    decryptMock.mockRejectedValueOnce(new Error('Mismatched SHA-256 digest'));

    await expect(
      firstValueFrom(svc.resolveMedia(encryptedMedia(), 'full')),
    ).rejects.toThrow(/digest/i);
  });

  it('decrypts an encrypted image once and shares it between the thumbnail and full views', async () => {
    const { svc } = setup();
    // Encrypted image with no bundled thumbnail_file: both variants resolve the
    // same ciphertext, so they must share a single fetch + decrypt.
    const media: MediaPayload = { ...encryptedMedia(), kind: 'image' };

    const thumb = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
    const full = await firstValueFrom(svc.resolveMedia(media, 'full'));

    expect(full).toBe(thumb);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decryptMock).toHaveBeenCalledTimes(1);
  });

  describe('cache keys follow the integrity data that produced the bytes', () => {
    function encryptedAt(url: string, k: string, sha256: string): MediaPayload {
      return {
        ...encryptedMedia(),
        file: {
          url,
          key: { k } as JsonWebKey,
          iv: `iv-${k}`,
          hashes: { sha256 },
          v: 'v2',
        },
      };
    }

    it('decrypts a second event with the same file.url but other key material on its own', async () => {
      const { svc } = setup();
      const first = encryptedAt('mxc://hs/shared', 'k1', 'h1');
      const second = encryptedAt('mxc://hs/shared', 'k2', 'h2');

      const a = await firstValueFrom(svc.resolveMedia(first, 'full'));
      const b = await firstValueFrom(svc.resolveMedia(second, 'full'));

      expect(b).not.toBe(a);
      expect(decryptMock).toHaveBeenCalledTimes(2);
      expect(decryptMock.mock.calls[1][1]).toBe(second.file);
    });

    it('does not share an in-flight decrypt with an event carrying other key material', async () => {
      const { svc } = setup();
      const first = encryptedAt('mxc://hs/shared', 'k1', 'h1');
      const second = encryptedAt('mxc://hs/shared', 'k2', 'h2');

      const [a, b] = await Promise.all([
        firstValueFrom(svc.resolveMedia(first, 'full')),
        firstValueFrom(svc.resolveMedia(second, 'full')),
      ]);

      expect(b).not.toBe(a);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(decryptMock.mock.calls.map(([, info]) => info)).toEqual([
        first.file,
        second.file,
      ]);
    });

    it('fetches an event with both url and file from file.url and never caches it under url', async () => {
      const { svc } = setup();
      const mixed: MediaPayload = {
        ...encryptedAt('mxc://hs/y', 'k1', 'h1'),
        mxc: 'mxc://hs/x',
      };

      const mixedUrl = await firstValueFrom(svc.resolveMedia(mixed, 'full'));
      const plainX = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/x'), 'full'),
      );
      const encryptedY = await firstValueFrom(
        svc.resolveMedia(encryptedAt('mxc://hs/y', 'k1', 'h1'), 'full'),
      );

      expect(fetchMock.mock.calls[0][0]).toContain('hs/y');
      expect(plainX).not.toBe(mixedUrl);
      expect(encryptedY).toBe(mixedUrl);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps a plaintext url apart from an encrypted file.url naming the same media', async () => {
      const { svc } = setup();

      const encrypted = await firstValueFrom(
        svc.resolveMedia(encryptedAt('mxc://hs/x', 'k1', 'h1'), 'full'),
      );
      const plain = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/x'), 'full'),
      );

      expect(plain).not.toBe(encrypted);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(decryptMock).toHaveBeenCalledTimes(1);
    });

    it('still serves the same event from the cache', async () => {
      const { svc } = setup();
      const media = encryptedAt('mxc://hs/same', 'k1', 'h1');

      const a = await firstValueFrom(svc.resolveMedia(media, 'full'));
      const b = await firstValueFrom(
        svc.resolveMedia(encryptedAt('mxc://hs/same', 'k1', 'h1'), 'full'),
      );

      expect(b).toBe(a);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(decryptMock).toHaveBeenCalledTimes(1);
    });

    it('keys an encrypted thumbnail by its own key material', async () => {
      const { svc } = setup();
      const withThumb = (k: string, sha256: string): MediaPayload => ({
        ...encryptedAt('mxc://hs/full', 'k1', 'h1'),
        kind: 'image',
        thumbnailMxc: 'mxc://hs/thumb-plain',
        thumbnailFile: {
          url: 'mxc://hs/thumb',
          key: { k } as JsonWebKey,
          iv: `tiv-${k}`,
          hashes: { sha256 },
          v: 'v2',
        },
      });
      const first = withThumb('t1', 'th1');
      const second = withThumb('t2', 'th2');

      const a = await firstValueFrom(svc.resolveMedia(first, 'thumbnail'));
      const again = await firstValueFrom(svc.resolveMedia(first, 'thumbnail'));
      const b = await firstValueFrom(svc.resolveMedia(second, 'thumbnail'));
      const plainThumb = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/thumb'), 'full'),
      );

      expect(again).toBe(a);
      expect(b).not.toBe(a);
      expect(plainThumb).not.toBe(a);
      expect(fetchMock.mock.calls[0][0]).toContain('hs/thumb');
      expect(fetchMock.mock.calls[0][0]).not.toContain('thumb-plain');
      expect(decryptMock.mock.calls.map(([, info]) => info)).toEqual([
        first.thumbnailFile,
        second.thumbnailFile,
      ]);
    });

    it('caches nothing for a failed decrypt', async () => {
      const { svc } = setup();
      const media = encryptedAt('mxc://hs/bad', 'k1', 'h1');
      decryptMock.mockRejectedValueOnce(new Error('Mismatched SHA-256 digest'));

      await expect(
        firstValueFrom(svc.resolveMedia(media, 'full')),
      ).rejects.toThrow(/digest/i);
      await firstValueFrom(svc.resolveMedia(media, 'full'));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(decryptMock).toHaveBeenCalledTimes(2);
    });

    const baseFile = {
      url: 'mxc://hs/shared',
      key: { k: 'k1' } as JsonWebKey,
      iv: 'iv1',
      hashes: { sha256: 'h1' },
      v: 'v2',
    };
    const withFile = (
      overrides: Partial<typeof baseFile>,
      mimeType = 'application/octet-stream',
    ): MediaPayload => ({
      ...encryptedMedia(),
      mimeType,
      file: { ...baseFile, ...overrides },
    });

    it.each([
      ['key', { key: { k: 'k2' } as JsonWebKey }],
      ['iv', { iv: 'iv2' }],
      ['hash', { hashes: { sha256: 'h2' } }],
      ['version', { v: 'v1' }],
    ])(
      'decrypts an event differing only in its %s on its own',
      async (_, change) => {
        const { svc } = setup();
        const second = withFile(change);

        const a = await firstValueFrom(svc.resolveMedia(withFile({}), 'full'));
        const b = await firstValueFrom(svc.resolveMedia(second, 'full'));

        expect(b).not.toBe(a);
        expect(decryptMock).toHaveBeenCalledTimes(2);
        expect(decryptMock.mock.calls[1][1]).toBe(second.file);
      },
    );

    it('fails an event with an unknown version instead of serving the cached bytes', async () => {
      const { svc } = setup();
      await firstValueFrom(svc.resolveMedia(withFile({}), 'full'));
      decryptMock.mockRejectedValueOnce(
        new Error('Unsupported attachment encryption version: v9'),
      );

      await expect(
        firstValueFrom(svc.resolveMedia(withFile({ v: 'v9' }), 'full')),
      ).rejects.toThrow(/version/);
      expect(decryptMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['encrypted', (mime: string) => withFile({}, mime)],
      ['plaintext', (mime: string) => plainMedia('mxc://hs/typed', mime)],
    ])('keeps %s media declared with another type apart', async (_, media) => {
      const { svc } = setup();

      const png = await firstValueFrom(
        svc.resolveMedia(media('image/png'), 'full'),
      );
      const jpeg = await firstValueFrom(
        svc.resolveMedia(media('image/jpeg'), 'full'),
      );

      expect(jpeg).not.toBe(png);
      expect(
        createObjectURL.mock.calls.map(([blob]) => (blob as Blob).type),
      ).toEqual(['image/png', 'image/jpeg']);
    });
  });

  describe('encrypted image without a bundled thumbnail', () => {
    /** Decrypted bytes are 3 long; the stubbed downscaled output is smaller. */
    const DOWNSCALED_BYTES = 2;
    let bitmapMock: Mock;
    /** Every bitmap the stubbed `createImageBitmap` produced, in order (decoded, resized). */
    let bitmaps: { close: Mock }[];
    let convertToBlob: Mock;
    let canvasSizes: { width: number; height: number }[];

    function encryptedImage(mimeType: string): MediaPayload {
      return { ...encryptedMedia(), kind: 'image', mimeType };
    }

    /** Stub the browser decode/resize/encode boundary for an image of `w`×`h`. */
    function stubBrowserImage(w: number, h: number): void {
      bitmaps = [];
      bitmapMock = vi.fn(async (_src: unknown, opts?: ImageBitmapOptions) => {
        const bitmap = {
          width: opts?.resizeWidth ?? w,
          height: opts?.resizeHeight ?? h,
          close: vi.fn(),
        };
        bitmaps.push(bitmap);
        return bitmap;
      });
      vi.stubGlobal('createImageBitmap', bitmapMock);
      convertToBlob = vi.fn(
        async (opts: { type: string }) =>
          new Blob([new Uint8Array(DOWNSCALED_BYTES)], { type: opts.type }),
      );
      canvasSizes = [];
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          constructor(
            readonly width: number,
            readonly height: number,
          ) {
            canvasSizes.push({ width, height });
          }
          getContext() {
            return { drawImage: vi.fn() };
          }
          convertToBlob = convertToBlob;
        },
      );
    }

    // A 2x screen: the display bucket is 640 px, which these expectations assume.
    beforeEach(() => {
      devicePixelRatio = 2;
    });

    afterEach(() => vi.restoreAllMocks());

    /** The blob handed to the n-th `URL.createObjectURL` call. */
    const storedBlob = (n = 0) => createObjectURL.mock.calls[n][0] as Blob;

    it('stores a downscaled JPEG under its own key and does not cache the original', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();
      const media = encryptedImage('image/jpeg');

      const thumb = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));

      expect(bitmapMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          resizeWidth: 640,
          resizeHeight: 427,
          resizeQuality: 'high',
        }),
      );
      expect(canvasSizes).toEqual([{ width: 640, height: 427 }]);
      expect(convertToBlob).toHaveBeenCalledWith({
        type: 'image/jpeg',
        quality: 0.8,
      });
      // Only the downscaled blob became an object URL — the original is not kept.
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(storedBlob().size).toBe(DOWNSCALED_BYTES);
      expect(storedBlob().type).toBe('image/jpeg');

      // The lightbox resolves the original under its own key (a second fetch).
      const full = await firstValueFrom(svc.resolveMedia(media, 'full'));
      expect(full).not.toBe(thumb);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(storedBlob(1).size).toBe(3);
      // And the thumbnail stays cached under its own key.
      expect(await firstValueFrom(svc.resolveMedia(media, 'thumbnail'))).toBe(
        thumb,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([' IMAGE/JPEG; q=1 ', 'image/jpg', 'image/png; name="a;b"'])(
      'downscales an encrypted image declared %j like its plain form',
      async (declared) => {
        stubBrowserImage(3000, 2000);
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(encryptedImage(declared), 'thumbnail'),
        );

        expect(bitmapMock).toHaveBeenCalled();
        expect(storedBlob().size).toBe(DOWNSCALED_BYTES);
      },
    );

    it('re-encodes a PNG as WebP to keep transparency', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/png'), 'thumbnail'),
      );

      expect(convertToBlob).toHaveBeenCalledWith({
        type: 'image/webp',
        quality: 0.8,
      });
      expect(storedBlob().type).toBe('image/webp');
    });

    it('shares one fetch, decrypt and downscale across concurrent thumbnail resolves', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();
      const media = encryptedImage('image/jpeg');

      const [a, b] = await Promise.all([
        firstValueFrom(svc.resolveMedia(media, 'thumbnail')),
        firstValueFrom(svc.resolveMedia(media, 'thumbnail')),
      ]);

      expect(a).toBe(b);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(decryptMock).toHaveBeenCalledTimes(1);
      expect(convertToBlob).toHaveBeenCalledTimes(1);
    });

    it('draws on a regular canvas when OffscreenCanvas is unavailable', async () => {
      stubBrowserImage(3000, 2000);
      vi.stubGlobal('OffscreenCanvas', undefined);
      const toBlob = vi.fn((cb: BlobCallback, type: string) =>
        cb(new Blob([new Uint8Array(DOWNSCALED_BYTES)], { type })),
      );
      const realCreate = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
        tag === 'canvas'
          ? { getContext: () => ({ drawImage: vi.fn() }), toBlob }
          : realCreate(tag)) as typeof document.createElement);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(toBlob).toHaveBeenCalledWith(
        expect.any(Function),
        'image/jpeg',
        0.8,
      );
      expect(storedBlob().size).toBe(DOWNSCALED_BYTES);
    });

    it.each([
      'image/avif',
      'image/bmp',
      'image/x-icon',
      'image/tiff',
      'image/heic',
    ])(
      'shows %s as sent: it may be animated or have an alpha channel JPEG would drop',
      async (mimeType) => {
        stubBrowserImage(3000, 2000);
        const { svc } = setup();
        const media = encryptedImage(mimeType);

        const thumb = await firstValueFrom(
          svc.resolveMedia(media, 'thumbnail'),
        );
        const full = await firstValueFrom(svc.resolveMedia(media, 'full'));

        expect(bitmapMock).not.toHaveBeenCalled();
        expect(full).toBe(thumb);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it('treats image/jpg like JPEG', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpg'), 'thumbnail'),
      );

      expect(storedBlob().size).toBe(DOWNSCALED_BYTES);
    });

    describe('animated PNG labelled image/png', () => {
      /** Signature, IHDR, then `chunk` (when set) and IDAT: just the headers the scan reads. */
      function pngBytes(chunk?: string): ArrayBuffer {
        const bytes: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
        const add = (type: string, length: number) => {
          bytes.push(0, 0, 0, length, ...[...type].map((c) => c.charCodeAt(0)));
          bytes.push(...new Array<number>(length + 4).fill(0)); // data + CRC
        };
        add('IHDR', 13);
        if (chunk) add(chunk, 8);
        add('IDAT', 4);
        return new Uint8Array(bytes).buffer;
      }

      it('is shown as sent when an acTL chunk precedes the image data', async () => {
        stubBrowserImage(3000, 2000);
        decryptMock.mockResolvedValueOnce(pngBytes('acTL'));
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(encryptedImage('image/png'), 'thumbnail'),
        );

        expect(bitmapMock).not.toHaveBeenCalled();
        expect(storedBlob().size).toBe(pngBytes('acTL').byteLength);
      });

      it('is still downscaled when it has no acTL chunk', async () => {
        stubBrowserImage(3000, 2000);
        decryptMock.mockResolvedValueOnce(pngBytes('gAMA'));
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(encryptedImage('image/png'), 'thumbnail'),
        );

        expect(storedBlob().size).toBe(DOWNSCALED_BYTES);
      });
    });

    it('shares one cache entry for thumbnail and full when the event says the image is small', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();
      const media = {
        ...encryptedImage('image/jpeg'),
        width: 640,
        height: 400,
      };

      const thumb = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      const full = await firstValueFrom(svc.resolveMedia(media, 'full'));

      expect(full).toBe(thumb);
      expect(bitmapMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(decryptMock).toHaveBeenCalledTimes(1);
    });

    it('still downscales when the event only claims one dimension', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(
          { ...encryptedImage('image/jpeg'), width: 300 },
          'thumbnail',
        ),
      );

      expect(storedBlob().size).toBe(DOWNSCALED_BYTES);
    });

    it('closes the full-size bitmap as soon as the resized one exists, and the resized one after encoding', async () => {
      stubBrowserImage(3000, 2000);
      let decodedClosedWhenEncoding = false;
      const encode = convertToBlob.getMockImplementation()!;
      convertToBlob.mockImplementation(async (opts: { type: string }) => {
        decodedClosedWhenEncoding = bitmaps[0].close.mock.calls.length > 0;
        return encode(opts);
      });
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(decodedClosedWhenEncoding).toBe(true);
      expect(bitmaps).toHaveLength(2);
      expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
      expect(bitmaps[1].close).toHaveBeenCalledTimes(1);
    });

    it('closes both bitmaps when encoding fails', async () => {
      stubBrowserImage(3000, 2000);
      convertToBlob.mockRejectedValue(new Error('encode failed'));
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(bitmaps).toHaveLength(2);
      expect(bitmaps[0].close).toHaveBeenCalled();
      expect(bitmaps[1].close).toHaveBeenCalled();
    });

    it('closes the full-size bitmap when the resize fails', async () => {
      stubBrowserImage(3000, 2000);
      bitmapMock.mockImplementationOnce(bitmapMock.getMockImplementation()!);
      bitmapMock.mockImplementationOnce(async () => {
        throw new Error('resize failed');
      });
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(bitmaps).toHaveLength(1);
      expect(bitmaps[0].close).toHaveBeenCalled();
      expect(storedBlob().size).toBe(3);
    });

    it('keeps the original when the encoded thumbnail is bigger', async () => {
      stubBrowserImage(3000, 2000);
      convertToBlob.mockResolvedValue(
        new Blob([new Uint8Array(4)], { type: 'image/jpeg' }), // bigger than the 3-byte original
      );
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(storedBlob().size).toBe(3);
      expect(storedBlob().type).toBe('image/jpeg');
    });

    it('stores nothing and frees both bitmaps when releaseAll lands mid-downscale', async () => {
      stubBrowserImage(3000, 2000);
      const realBitmap = bitmapMock.getMockImplementation()!;
      let finishResize!: () => void;
      bitmapMock.mockImplementationOnce(realBitmap);
      bitmapMock.mockImplementationOnce(
        (...args: unknown[]) =>
          new Promise((resolve) => {
            finishResize = () => resolve(realBitmap(...args));
          }),
      );
      const { svc } = setup();
      const emitted = vi.fn();

      svc
        .resolveMedia(encryptedImage('image/jpeg'), 'thumbnail')
        .subscribe(emitted);
      await vi.waitFor(() => expect(finishResize).toBeDefined());
      svc.releaseAll();
      finishResize();
      await vi.waitFor(() => {
        expect(bitmaps).toHaveLength(2);
        expect(bitmaps[0].close).toHaveBeenCalled();
        expect(bitmaps[1].close).toHaveBeenCalled();
      });

      expect(emitted).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('leaves the full variant untouched', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'full'),
      );

      expect(bitmapMock).not.toHaveBeenCalled();
      expect(storedBlob().size).toBe(3);
      expect(storedBlob().type).toBe('image/jpeg');
    });

    it.each(['image/gif', 'image/webp', 'image/apng', 'image/svg+xml'])(
      'skips downscaling %s and shares the original between thumbnail and full',
      async (mimeType) => {
        stubBrowserImage(3000, 2000);
        const { svc } = setup();
        const media = encryptedImage(mimeType);

        const thumb = await firstValueFrom(
          svc.resolveMedia(media, 'thumbnail'),
        );
        const full = await firstValueFrom(svc.resolveMedia(media, 'full'));

        expect(bitmapMock).not.toHaveBeenCalled();
        expect(full).toBe(thumb);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(storedBlob().size).toBe(3);
      },
    );

    it('keeps an image already within 640 px as is', async () => {
      stubBrowserImage(600, 400);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(canvasSizes).toEqual([]);
      expect(storedBlob().size).toBe(3);
    });

    it('falls back to the original when decoding fails', async () => {
      stubBrowserImage(3000, 2000);
      bitmapMock.mockRejectedValue(new Error('undecodable'));
      const { svc } = setup();

      const url = await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(url).toBe('blob:obj-1');
      expect(storedBlob().size).toBe(3);
    });

    it('falls back to the original when encoding fails', async () => {
      stubBrowserImage(3000, 2000);
      convertToBlob.mockRejectedValue(new Error('encode failed'));
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
      );

      expect(storedBlob().size).toBe(3);
    });

    it('still propagates a decryption failure', async () => {
      stubBrowserImage(3000, 2000);
      decryptMock.mockRejectedValueOnce(new Error('Mismatched SHA-256 digest'));
      const { svc } = setup();

      await expect(
        firstValueFrom(
          svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
        ),
      ).rejects.toThrow(/digest/i);
    });

    it('does not decode an encrypted thumbnail bundled in the event', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(
          {
            ...encryptedImage('image/jpeg'),
            thumbnailFile: {
              url: 'mxc://hs/thumb-ciphertext',
              key: {} as JsonWebKey,
              iv: 'tiv',
              hashes: { sha256: 'thash' },
              v: 'v2',
            },
            thumbnailMimeType: 'image/jpeg',
          },
          'thumbnail',
        ),
      );

      expect(bitmapMock).not.toHaveBeenCalled();
      expect(storedBlob().size).toBe(3);
    });

    it('leaves the server-resized plaintext thumbnail path alone', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(
          plainMedia('mxc://hs/plain', 'image/jpeg'),
          'thumbnail',
        ),
      );

      expect(fetchMock.mock.calls[0][0]).toContain('w=640');
      expect(bitmapMock).not.toHaveBeenCalled();
      expect(storedBlob().size).toBe(8);
    });

    it.each([
      [1, 320, 213],
      [2, 640, 427],
      [3, 960, 640],
    ])(
      'downscales a decrypted original on a %sx screen to a %i px edge',
      async (dpr, w, h) => {
        devicePixelRatio = dpr;
        stubBrowserImage(3000, 2000);
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(encryptedImage('image/jpeg'), 'thumbnail'),
        );

        expect(canvasSizes).toEqual([{ width: w, height: h }]);
      },
    );

    it('keeps an image the event says fits a 3x screen as is', async () => {
      devicePixelRatio = 3;
      stubBrowserImage(3000, 2000);
      const { svc } = setup();
      const media = {
        ...encryptedImage('image/jpeg'),
        width: 960,
        height: 640,
      };

      const thumb = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      const full = await firstValueFrom(svc.resolveMedia(media, 'full'));

      expect(full).toBe(thumb);
      expect(bitmapMock).not.toHaveBeenCalled();
    });

    it('keeps a downscaled thumbnail per bucket and reuses it within one', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();
      const media = encryptedImage('image/jpeg');

      const at2x = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      devicePixelRatio = 1.5; // still the 640 px bucket
      const again = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      devicePixelRatio = 1;
      const at1x = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));

      expect(again).toBe(at2x);
      expect(at1x).not.toBe(at2x);
      expect(canvasSizes).toEqual([
        { width: 640, height: 427 },
        { width: 320, height: 213 },
      ]);
    });

    it('decrypts and downscales a thumbnail with other key material on its own', async () => {
      stubBrowserImage(3000, 2000);
      const { svc } = setup();
      const media = encryptedImage('image/jpeg');
      const other: MediaPayload = {
        ...media,
        file: {
          url: 'mxc://hs/ciphertext',
          key: { k: 'other' } as JsonWebKey,
          iv: 'iv',
          hashes: { sha256: 'abc' },
          v: 'v2',
        },
      };

      const first = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      const second = await firstValueFrom(svc.resolveMedia(other, 'thumbnail'));

      expect(second).not.toBe(first);
      expect(decryptMock.mock.calls[1][1]).toBe(other.file);
      expect(canvasSizes).toEqual([
        { width: 640, height: 427 },
        { width: 640, height: 427 },
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
        const { svc, client } = setup();

        await firstValueFrom(
          svc.resolveMedia(plainMedia('mxc://hs/plain'), 'thumbnail'),
        );

        expect(client.mxcUrlToHttp).toHaveBeenCalledWith(
          'mxc://hs/plain',
          edge,
          edge,
          'scale',
          false,
          true,
          true,
        );
      },
    );

    it('keeps a server thumbnail per bucket and reuses it within one', async () => {
      const { svc } = setup();
      const media = plainMedia('mxc://hs/plain');

      const at1x = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      devicePixelRatio = 2;
      const at2x = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));
      devicePixelRatio = 1.75; // the same 640 px bucket
      const again = await firstValueFrom(svc.resolveMedia(media, 'thumbnail'));

      expect(at2x).not.toBe(at1x);
      expect(again).toBe(at2x);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain('w=320');
      expect(fetchMock.mock.calls[1][0]).toContain('w=640');
    });

    it('keys a bundled thumbnail and the full rendition without a bucket', async () => {
      const { svc } = setup();
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
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('shares one in-flight fetch across concurrent resolves of the same source', async () => {
    const { svc } = setup();
    const media = plainMedia('mxc://hs/concurrent');

    // Both subscribe before the first resolves — they must share one fetch.
    const [a, b] = await Promise.all([
      firstValueFrom(svc.resolveMedia(media, 'full')),
      firstValueFrom(svc.resolveMedia(media, 'full')),
    ]);

    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('releaseAll cancels in-flight work so a late completion cannot repopulate the cache', async () => {
    const { svc } = setup();
    let releaseFetch!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      }),
    );

    const seen: string[] = [];
    svc
      .resolveMedia(plainMedia('mxc://hs/pending'), 'full')
      .subscribe({ next: (u) => seen.push(u), error: () => undefined });

    // Let supportsAuthedMedia settle so the chain reaches (and parks on) the fetch.
    await new Promise((r) => setTimeout(r));
    expect(releaseFetch).toBeDefined();

    // Tear down while the fetch is still pending, then let it resolve late.
    svc.releaseAll();
    createObjectURL.mockClear();
    releaseFetch(okResponse());
    await new Promise((r) => setTimeout(r));

    // The orphaned completion must not store a fresh object URL into the cache.
    expect(seen).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('evicts least recently used unpinned entries once the byte budget is exceeded', async () => {
    const { svc } = setup();
    stubBlobSize(40);
    expect(3 * 40 * 1024 * 1024).toBeGreaterThan(CACHE_BYTE_LIMIT);

    const a = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
    );
    const b = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'),
    );
    expect(revokeObjectURL).not.toHaveBeenCalled(); // 80 MB fits
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

    expect(revokeObjectURL).toHaveBeenCalledTimes(1); // 120 MB > 96 MB
    expect(revokeObjectURL).toHaveBeenCalledWith(a);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(b);
  });

  it('keeps a pinned entry even when it alone exceeds the byte budget', async () => {
    const { svc } = setup();
    stubBlobSize(60);
    const a = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
    );
    svc.pin(a);
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'));
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

    expect(revokeObjectURL).not.toHaveBeenCalledWith(a);
    // Eviction did run, and skipped only the pinned entry: b is the oldest unpinned.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('treats a cache hit as recent use when evicting for the byte budget', async () => {
    const { svc } = setup();
    stubBlobSize(40);
    const a = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
    );
    const b = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'),
    );
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/a'), 'full')); // touch a
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(b);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(a);
  });

  it('does not revoke a lone blob that is over the byte budget before it can be pinned', async () => {
    const { svc } = setup();
    stubBlobSize(CACHE_BYTE_LIMIT / 1024 / 1024 + 4);

    const url = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/huge'), 'full'),
    );

    expect(revokeObjectURL).not.toHaveBeenCalledWith(url);
  });

  it('never evicts pinned URLs past the cache limit, and releaseAll revokes everything', async () => {
    const { svc } = setup();

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

    const evicted = revokeObjectURL.mock.calls.map((c) => c[0]);
    expect(evicted.length).toBeGreaterThan(0); // some unpinned URL was evicted
    expect(evicted).not.toContain(pinned); // ...but never the pinned one

    // releaseAll revokes every remaining URL — including the pinned one — and clears.
    revokeObjectURL.mockClear();
    fetchMock.mockClear();
    svc.releaseAll();
    expect(revokeObjectURL).toHaveBeenCalledWith(pinned);

    // The cache is empty afterward: the same source fetches again.
    await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/0'), 'full'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('pin counting', () => {
    /** Resolve `a` (pinned per the test), then fill the cache past its byte budget. */
    async function pressure(svc: MediaService): Promise<void> {
      await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'));
      await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));
    }

    it('keeps a URL pinned while any of two pins remains', async () => {
      const { svc } = setup();
      stubBlobSize(40);
      const a = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.pin(a); // the row
      svc.pin(a); // the lightbox, sharing the same blob URL
      svc.unpin(a); // one of them leaves

      await pressure(svc);
      svc.releaseUnpinned();

      expect(revokeObjectURL).not.toHaveBeenCalledWith(a);
    });

    it('makes a URL evictable once its last pin is released', async () => {
      const { svc } = setup();
      const a = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.pin(a);
      svc.pin(a);
      svc.unpin(a);
      svc.unpin(a);

      svc.releaseUnpinned();

      expect(revokeObjectURL).toHaveBeenCalledWith(a);
    });

    it('ignores an extra unpin instead of counting below zero', async () => {
      const { svc } = setup();
      const a = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.unpin(a); // never pinned
      svc.pin(a);

      svc.releaseUnpinned();

      // A count that went to -1 would now be 0 and evictable.
      expect(revokeObjectURL).not.toHaveBeenCalledWith(a);
    });

    it('forgets every pin on releaseAll', async () => {
      const { svc } = setup();
      const before = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.pin(before);
      svc.pin(before);
      svc.releaseAll();
      revokeObjectURL.mockClear();

      // URLs are fresh after a release, but the pins are gone too: the next one is evictable.
      const after = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/a'), 'full'),
      );
      svc.releaseUnpinned();

      expect(revokeObjectURL).toHaveBeenCalledWith(after);
    });
  });

  describe('drop', () => {
    const full = (mxc = 'mxc://hs/a') => ({
      media: plainMedia(mxc),
      variant: 'full' as const,
    });

    it('revokes and removes the entry when the dropping caller held the last pin', async () => {
      const { svc } = setup();
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a);
      fetchMock.mockClear();

      svc.drop(a, full());

      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a);
      // Gone from the cache: the next resolve downloads it again, under a fresh URL.
      const again = await firstValueFrom(
        svc.resolveMedia(full().media, 'full'),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(again).not.toBe(a);
    });

    it('only releases its own pin while another view still shows the URL', async () => {
      const { svc } = setup();
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a); // the row
      svc.pin(a); // the lightbox
      fetchMock.mockClear();

      svc.drop(a, full());

      expect(revokeObjectURL).not.toHaveBeenCalledWith(a);
      // Still cached for the row.
      await expect(
        firstValueFrom(svc.resolveMedia(full().media, 'full')),
      ).resolves.toBe(a);
      expect(fetchMock).not.toHaveBeenCalled();
      // The row's pin is the last one; dropping it frees the entry.
      svc.drop(a, full());
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a);
    });

    it('takes the dropped bytes off the budget', async () => {
      const { svc } = setup();
      stubBlobSize(40);
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a);
      const b = await firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/b'), 'full'),
      );

      svc.drop(a, full());
      revokeObjectURL.mockClear();
      // b + c = 80 MB fits once a's 40 MB are no longer counted.
      await firstValueFrom(svc.resolveMedia(plainMedia('mxc://hs/c'), 'full'));

      expect(revokeObjectURL).not.toHaveBeenCalledWith(b);
    });

    it('does not revoke a URL the cache no longer holds for that rendition', async () => {
      const { svc } = setup();
      const a = await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      svc.pin(a);
      svc.releaseAll(); // a is revoked and forgotten; a later resolve gets a new URL
      const fresh = await firstValueFrom(
        svc.resolveMedia(full().media, 'full'),
      );
      svc.pin(fresh);
      revokeObjectURL.mockClear();

      svc.drop(a, full()); // a stale caller drops what it held before the release

      expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    /** Park the next fetch until the returned function lets it complete. */
    function parkFetch(): (res: Response) => void {
      let complete!: (res: Response) => void;
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
      );
      return (res) => complete(res);
    }

    it('cancels an in-flight resolve nobody waits for, so a late completion is not cached', async () => {
      const { svc } = setup();
      const complete = parkFetch();
      const seen: string[] = [];
      const sub = svc
        .resolveMedia(full().media, 'full')
        .subscribe((u) => seen.push(u));
      await new Promise((r) => setTimeout(r));

      sub.unsubscribe();
      svc.drop(null, full());
      complete(okResponse());
      await new Promise((r) => setTimeout(r));

      expect(seen).toEqual([]);
      // No object URL survives the late completion.
      expect(createObjectURL.mock.calls.length).toBe(
        revokeObjectURL.mock.calls.length,
      );
      // And the next resolve is a fresh download, not the abandoned one.
      fetchMock.mockClear();
      await firstValueFrom(svc.resolveMedia(full().media, 'full'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('completes a resolve obtained before the drop but subscribed after it empty', async () => {
      const { svc } = setup();
      const complete = parkFetch();
      const early = svc.resolveMedia(full().media, 'full');
      const first = early.subscribe();
      await new Promise((r) => setTimeout(r));
      first.unsubscribe();

      svc.drop(null, full());
      complete(okResponse());
      const seen: string[] = [];
      let completed = false;
      early.subscribe({
        next: (u) => seen.push(u),
        complete: () => (completed = true),
      });
      await new Promise((r) => setTimeout(r));

      expect(seen).toEqual([]);
      expect(completed).toBe(true);
    });

    it('leaves an in-flight resolve running while another view still waits for it', async () => {
      const { svc } = setup();
      const complete = parkFetch();
      const dropped = svc.resolveMedia(full().media, 'full').subscribe();
      const waiting = firstValueFrom(svc.resolveMedia(full().media, 'full'));
      await new Promise((r) => setTimeout(r));

      dropped.unsubscribe();
      svc.drop(null, full());
      complete(okResponse());

      await expect(waiting).resolves.toMatch(/^blob:/);
    });
  });

  it('releaseUnpinned drops unpinned entries and keeps pinned ones resolvable from cache', async () => {
    const { svc } = setup();
    const pinned = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/on-screen'), 'full'),
    );
    svc.pin(pinned);
    const offScreen = await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/off-screen'), 'full'),
    );
    fetchMock.mockClear();

    svc.releaseUnpinned();

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(offScreen);
    // The pinned entry is still cached: resolving it again neither refetches nor changes URL.
    await expect(
      firstValueFrom(
        svc.resolveMedia(plainMedia('mxc://hs/on-screen'), 'full'),
      ),
    ).resolves.toBe(pinned);
    expect(fetchMock).not.toHaveBeenCalled();
    // The released one is fetched again on its next use.
    await firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/off-screen'), 'full'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('releaseUnpinned lets in-flight resolutions finish', async () => {
    const { svc } = setup();
    const pending = firstValueFrom(
      svc.resolveMedia(plainMedia('mxc://hs/loading'), 'full'),
    );

    svc.releaseUnpinned();

    await expect(pending).resolves.toMatch(/^blob:/);
  });

  it('downloadMedia returns the full bytes paired with the filename', async () => {
    const { svc } = setup();
    const media = plainMedia('mxc://hs/doc');

    const { blob, filename } = await firstValueFrom(svc.downloadMedia(media));

    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe('pic.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('display types of resolved blobs', () => {
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
    const storedBlob = () => createObjectURL.mock.calls[0][0] as Blob;
    const encryptedThumbnail = (thumbnailMimeType: string): MediaPayload => ({
      ...plainMedia('mxc://hs/original'),
      thumbnailFile: encryptedMedia().file,
      thumbnailMimeType,
    });

    it.each(NOT_DISPLAYABLE)(
      'gives a plaintext image declared %j an opaque blob type',
      async (declared) => {
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(plainMedia('mxc://hs/a', declared), 'full'),
        );

        expect(storedBlob().type).toBe(OPAQUE);
      },
    );

    it.each(NOT_DISPLAYABLE)(
      'gives an encrypted image declared %j an opaque blob type',
      async (declared) => {
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(
            { ...encryptedMedia(), kind: 'image', mimeType: declared },
            'full',
          ),
        );

        expect(storedBlob().type).toBe(OPAQUE);
      },
    );

    it.each(NOT_DISPLAYABLE)(
      'gives a plaintext thumbnail declared %j an opaque blob type',
      async (declared) => {
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(
            {
              ...plainMedia('mxc://hs/original'),
              thumbnailMxc: 'mxc://hs/thumb',
              thumbnailMimeType: declared,
            },
            'thumbnail',
          ),
        );

        expect(storedBlob().type).toBe(OPAQUE);
      },
    );

    it.each(NOT_DISPLAYABLE)(
      'gives an encrypted thumbnail declared %j an opaque blob type',
      async (declared) => {
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(encryptedThumbnail(declared), 'thumbnail'),
        );

        expect(storedBlob().type).toBe(OPAQUE);
      },
    );

    it('gives a sticker or pack image, resolved without a bundled thumbnail, an opaque blob type', async () => {
      const { svc } = setup();

      await firstValueFrom(
        svc.resolveMedia(
          plainMedia('mxc://hs/inherit', 'image/svg+xml; charset=utf-8'),
          'thumbnail',
        ),
      );

      expect(storedBlob().type).toBe(OPAQUE);
    });

    it('gives a saved attachment an opaque blob type as well', async () => {
      const { svc } = setup();

      const { blob, filename } = await firstValueFrom(
        svc.downloadMedia(plainMedia('mxc://hs/save', 'image/svg+xml')),
      );

      expect(blob.type).toBe(OPAQUE);
      expect(filename).toBe('pic.png');
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
        const { svc } = setup();

        await firstValueFrom(
          svc.resolveMedia(plainMedia('mxc://hs/ok', declared), 'full'),
        );

        expect(storedBlob().type).toBe(expected);
      },
    );
  });
});
