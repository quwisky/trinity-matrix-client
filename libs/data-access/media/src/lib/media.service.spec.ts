import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { MediaService } from './media.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import type { MediaPayload } from '@trinity/util/matrix';
import { decryptAttachment, encryptAttachment } from '@trinity/util/matrix';
import {
  bytesWithoutImageMetadata,
  withoutImageMetadata,
} from './image-metadata/strip-file-metadata';
import {
  containsAscii,
  identifyingJpeg,
} from './image-metadata/image-metadata.fixture';

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
    withoutImageMetadata: vi.fn(real.withoutImageMetadata),
    bytesWithoutImageMetadata: vi.fn(real.bytesWithoutImageMetadata),
  };
});

/** The mocked crypto fns, typed for call assertions / per-test overrides. */
const decryptMock = decryptAttachment as unknown as Mock;
const encryptMock = encryptAttachment as unknown as Mock;

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

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as Response;
}

function failResponse(status = 404): Response {
  return {
    ok: false,
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as Response;
}

/** Build a fake MatrixClient with the surface MediaService touches. */
function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    isVersionSupported: vi.fn().mockResolvedValue(true),
    getAccessToken: vi.fn(() => 'tok'),
    uploadContent: vi.fn().mockResolvedValue({ content_uri: 'mxc://hs/up' }),
    // Echo enough of the mxc back so distinct sources yield distinct URLs.
    mxcUrlToHttp: vi.fn(
      (mxc: string, w?: number, _h?: number) =>
        `https://hs/_matrix/download/${mxc.replace('mxc://', '')}${
          w ? `?w=${w}` : ''
        }`,
    ),
    ...overrides,
  };
}

function setup(clientOverrides: Record<string, unknown> = {}) {
  const client = fakeClient(clientOverrides);

  TestBed.configureTestingModule({
    providers: [
      MediaService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as unknown as MatrixClientService['instance'],
      }),
    ],
  });
  const svc = TestBed.inject(MediaService);
  return { svc, client };
}

describe('MediaService', () => {
  let fetchMock: Mock;
  let createObjectURL: Mock;
  let revokeObjectURL: Mock;
  let origCreate: typeof URL.createObjectURL;
  let origRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    let counter = 0;
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    createObjectURL = vi.fn(() => `blob:obj-${++counter}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // jsdom doesn't implement the object-URL API, so swap it wholesale.
    origCreate = URL.createObjectURL;
    origRevoke = URL.revokeObjectURL;
    URL.createObjectURL =
      createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL =
      revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    // The crypto stubs are module-level (created once); reset their call logs so
    // per-test counts start clean. Their default implementations are preserved.
    decryptMock.mockClear();
    encryptMock.mockClear();
    (withoutImageMetadata as Mock).mockClear();
    (bytesWithoutImageMetadata as Mock).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
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

      expect(fetchMock.mock.calls[0][0]).toContain('w=480');
      expect(bitmapMock).not.toHaveBeenCalled();
      expect(storedBlob().size).toBe(8);
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

  describe('uploadMedia', () => {
    // jsdom's File/Blob lack arrayBuffer() (real browsers/WebViews have it).
    const fileWithBuffer = (
      name: string,
      type: string,
      bytes = new Uint8Array([1, 2, 3, 4]),
    ) => {
      const file = new File([bytes], name, { type });
      if (typeof file.arrayBuffer !== 'function') {
        Object.defineProperty(file, 'arrayBuffer', {
          value: () => Promise.resolve(bytes.buffer),
        });
      }
      return file;
    };
    const pngFile = () => fileWithBuffer('pic.png', 'image/png');
    const imageFile = () => fileWithBuffer('photo.jpg', 'image/jpeg');
    const mediaFile = (name: string, type: string) =>
      fileWithBuffer(name, type);

    // jsdom can't decode images (createImageBitmap/canvas) or load media metadata,
    // so the thumbnail/duration probes are driven by fakes. Mutable per-test meta
    // lets a test set a video/audio duration before uploading.
    let videoMeta: {
      duration: number;
      videoWidth: number;
      videoHeight: number;
    };
    let audioMeta: { duration: number };
    let origCreateElement: typeof document.createElement;
    // How the fake media element behaves on `src` assignment: fire loadedmetadata,
    // fire an error, or stay silent (so the real timeout branch runs).
    let mediaElementMode: 'load' | 'silent' | 'error';
    // Whether a video `currentTime` seek fires `seeked` (false → poster timeout).
    let videoSeekFires: boolean;
    // If true, a seek fires `error` (post-metadata) instead of `seeked`.
    let videoErrorsOnSeek: boolean;
    // What the fake canvas 2D context resolves to (null → drawPoster bails out).
    let canvasContext: 'ctx' | 'null';

    const fakeMediaElement = (tag: 'video' | 'audio') => {
      const el = {
        preload: '',
        muted: false,
        onloadedmetadata: null as null | (() => void),
        onerror: null as null | (() => void),
        onseeked: null as null | (() => void),
        duration: tag === 'video' ? videoMeta.duration : audioMeta.duration,
        videoWidth: tag === 'video' ? videoMeta.videoWidth : 0,
        videoHeight: tag === 'video' ? videoMeta.videoHeight : 0,
        removeAttribute: vi.fn(),
        load: vi.fn(),
        _src: '',
        _currentTime: 0,
        set src(v: string) {
          this._src = v;
          if (mediaElementMode === 'silent') {
            return; // nothing fires → exercises the metadata timeout branch
          }
          // Real elements fire loadedmetadata (or error) async once the header
          // is parsed.
          queueMicrotask(() =>
            mediaElementMode === 'error'
              ? this.onerror?.()
              : this.onloadedmetadata?.(),
          );
        },
        get src() {
          return this._src;
        },
        set currentTime(v: number) {
          const changed = v !== this._currentTime;
          this._currentTime = v;
          // Real <video> only dispatches 'seeked' when the position actually moves.
          if (!changed) {
            return;
          }
          if (videoErrorsOnSeek) {
            queueMicrotask(() => this.onerror?.());
          } else if (videoSeekFires) {
            queueMicrotask(() => this.onseeked?.());
          }
        },
        get currentTime() {
          return this._currentTime;
        },
      };
      return el as unknown as HTMLMediaElement;
    };

    const fakeCanvas = () =>
      ({
        width: 0,
        height: 0,
        getContext: vi.fn(() =>
          canvasContext === 'null' ? null : { drawImage: vi.fn() },
        ),
        toBlob: (cb: (b: Blob) => void, type: string) => {
          const bytes = new Uint8Array([5, 5, 5]);
          const blob = new Blob([bytes], { type });
          if (typeof blob.arrayBuffer !== 'function') {
            Object.defineProperty(blob, 'arrayBuffer', {
              value: () => Promise.resolve(bytes.buffer),
            });
          }
          cb(blob);
        },
      }) as unknown as HTMLCanvasElement;

    /** Stub createImageBitmap to make analyzeImage produce a thumbnail. */
    const stubBitmap = (width: number, height: number) =>
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => ({ width, height, close: vi.fn() })),
      );

    beforeEach(() => {
      videoMeta = { duration: NaN, videoWidth: 0, videoHeight: 0 };
      audioMeta = { duration: NaN };
      mediaElementMode = 'load';
      videoSeekFires = true;
      videoErrorsOnSeek = false;
      canvasContext = 'ctx';
      origCreateElement = document.createElement;
      const realCreate = origCreateElement.bind(document);
      document.createElement = ((tagName: string) => {
        if (tagName === 'video' || tagName === 'audio') {
          return fakeMediaElement(tagName);
        }
        if (tagName === 'canvas') {
          return fakeCanvas();
        }
        return realCreate(tagName);
      }) as unknown as typeof document.createElement;
    });

    afterEach(() => {
      document.createElement = origCreateElement;
    });

    it('uploads a plaintext file and returns a url descriptor', async () => {
      const { svc, client } = setup();

      const res = await firstValueFrom(svc.uploadMedia(pngFile(), false));

      expect(client.uploadContent).toHaveBeenCalledTimes(1);
      const [body, opts] = client.uploadContent.mock.calls[0];
      expect(body).toBeInstanceOf(File);
      expect(opts.name).toBe('pic.png');
      expect(opts.type).toBe('image/png');
      expect(encryptMock).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        msgtype: 'm.image',
        body: 'pic.png',
        mxc: 'mxc://hs/up',
        file: null,
        info: { mimetype: 'image/png', size: 4 },
      });
    });

    it('encrypts then uploads ciphertext for an E2EE room, filling file.url', async () => {
      const { svc, client } = setup();

      const res = await firstValueFrom(svc.uploadMedia(pngFile(), true));

      expect(encryptMock).toHaveBeenCalledTimes(1);
      const [body, opts] = client.uploadContent.mock.calls[0];
      expect(body).toBeInstanceOf(Blob);
      // Encrypted uploads must not leak the filename/MIME.
      expect(opts.includeFilename).toBe(false);
      expect(opts.type).toBe('application/octet-stream');
      expect(res.mxc).toBeNull();
      expect(res.file).toMatchObject({ url: 'mxc://hs/up', v: 'v2' });
      // size is the ciphertext length (mock returns 4 bytes), not the original.
      expect(res.info).toMatchObject({ mimetype: 'image/png', size: 4 });
    });

    describe('photo metadata', () => {
      const photo = () =>
        new File([identifyingJpeg(6)], 'IMG_0001.jpg', { type: 'image/jpeg' });

      it('uploads a plaintext photo without its location, camera or capture time', async () => {
        const { svc, client } = setup();
        const original = photo();

        const res = await firstValueFrom(svc.uploadMedia(original, false));

        expect(withoutImageMetadata).toHaveBeenCalledWith(original);
        const [body, opts] = client.uploadContent.mock.calls[0];
        expect(body).toBeInstanceOf(File);
        expect(body).not.toBe(original);
        const sent = new Uint8Array(await (body as File).arrayBuffer());
        expect(containsAscii(sent, '52.5200')).toBe(false);
        expect(containsAscii(sent, 'Canon')).toBe(false);
        expect(opts).toMatchObject({
          name: 'IMG_0001.jpg',
          type: 'image/jpeg',
        });
        // content.info describes what was uploaded, not what was picked.
        expect(res.info).toMatchObject({
          mimetype: 'image/jpeg',
          size: (body as File).size,
        });
        expect((body as File).size).toBeLessThan(original.size);
      });

      it('strips an E2EE photo before it is encrypted', async () => {
        const { svc } = setup();
        const original = photo();

        await firstValueFrom(svc.uploadMedia(original, true));

        expect(bytesWithoutImageMetadata).toHaveBeenCalledWith(original);
        const stripOrder = (bytesWithoutImageMetadata as Mock).mock
          .invocationCallOrder[0];
        expect(stripOrder).toBeLessThan(
          encryptMock.mock.invocationCallOrder[0] ?? 0,
        );
        const plaintext = new Uint8Array(
          encryptMock.mock.calls[0]?.[0] as ArrayBuffer,
        );
        expect(plaintext.length).toBeLessThan(original.size);
        expect(containsAscii(plaintext, '52.5200')).toBe(false);
        expect(containsAscii(plaintext, 'Canon')).toBe(false);
      });

      it('uploads a video exactly as picked', async () => {
        const { svc, client } = setup();
        const clip = mediaFile('clip.mp4', 'video/mp4');

        await firstValueFrom(svc.uploadMedia(clip, false));

        expect(client.uploadContent.mock.calls.at(-1)?.[0]).toBe(clip);
      });
    });

    it('derives the msgtype from the MIME type', async () => {
      const { svc } = setup();
      const kindFor = async (type: string) =>
        (
          await firstValueFrom(
            svc.uploadMedia(
              new File([new Uint8Array([0])], 'f', { type }),
              false,
            ),
          )
        ).msgtype;

      expect(await kindFor('image/png')).toBe('m.image');
      expect(await kindFor('video/mp4')).toBe('m.video');
      expect(await kindFor('audio/ogg')).toBe('m.audio');
      expect(await kindFor('application/pdf')).toBe('m.file');
    });

    it('forwards upload progress as a fraction in [0, 1]', async () => {
      const { svc, client } = setup();
      const seen: number[] = [];

      await firstValueFrom(
        svc.uploadMedia(pngFile(), false, (f) => seen.push(f)),
      );

      const opts = client.uploadContent.mock.calls[0][1];
      opts.progressHandler({ loaded: 5, total: 10 });
      expect(seen).toEqual([0.5]);
    });

    it('renders and uploads a thumbnail for a large plaintext image', async () => {
      const { svc, client } = setup();
      // The thumbnail uploads first (it's small), then the main resource.
      client.uploadContent
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/thumb' })
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' });
      stubBitmap(1000, 500);

      const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

      expect(client.uploadContent).toHaveBeenCalledTimes(2);
      expect(res.mxc).toBe('mxc://hs/full');
      expect(res.info.w).toBe(1000);
      expect(res.info.h).toBe(500);
      expect(res.info.thumbnail_url).toBe('mxc://hs/thumb');
      expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
      // 1000×500 scaled to fit a 480px edge → 480×240.
      expect(res.info.thumbnail_info?.w).toBe(480);
      expect(res.info.thumbnail_info?.h).toBe(240);
    });

    it('encrypts the thumbnail for an E2EE image and sets thumbnail_file (not _url)', async () => {
      const { svc, client } = setup();
      encryptMock
        .mockResolvedValueOnce({
          data: new Uint8Array([1]).buffer,
          info: {
            url: '',
            v: 'v2',
            key: {},
            iv: 'tiv',
            hashes: { sha256: 'th' },
          },
        }) // thumbnail (encrypted first)
        .mockResolvedValueOnce({
          data: new Uint8Array([2]).buffer,
          info: {
            url: '',
            v: 'v2',
            key: {},
            iv: 'fiv',
            hashes: { sha256: 'fh' },
          },
        }); // main resource
      client.uploadContent
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/thumb-ct' })
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/full-ct' });
      stubBitmap(1024, 768);

      const res = await firstValueFrom(svc.uploadMedia(imageFile(), true));

      expect(encryptMock).toHaveBeenCalledTimes(2);
      expect(res.mxc).toBeNull();
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(res.info.thumbnail_file).toMatchObject({
        url: 'mxc://hs/thumb-ct',
        iv: 'tiv',
        v: 'v2',
      });
      expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
    });

    it('does not generate a thumbnail for an already-small image', async () => {
      const { svc, client } = setup();
      stubBitmap(320, 200); // within the 480px bound → original is its own thumbnail

      const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

      expect(client.uploadContent).toHaveBeenCalledTimes(1); // main only
      expect(res.info.thumbnail_url).toBeUndefined();
      // Intrinsic dimensions are still recorded.
      expect(res.info).toMatchObject({ w: 320, h: 200 });
    });

    it('still uploads the image when thumbnail generation fails', async () => {
      const { svc, client } = setup();
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(() => Promise.reject(new Error('decode failed'))),
      );

      const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

      expect(client.uploadContent).toHaveBeenCalledTimes(1); // main only
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(res.info.thumbnail_file).toBeUndefined();
      expect(res.mxc).toBe('mxc://hs/up');
    });

    it('still sends when the thumbnail upload fails', async () => {
      const { svc, client } = setup();
      client.uploadContent
        .mockRejectedValueOnce(new Error('thumb upload failed'))
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' });
      stubBitmap(1000, 800);

      const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

      expect(client.uploadContent).toHaveBeenCalledTimes(2);
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(res.mxc).toBe('mxc://hs/full');
    });

    it('probes a video and captures a poster-frame thumbnail', async () => {
      const { svc, client } = setup();
      client.uploadContent
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/poster' }) // poster first
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' }); // then the video
      videoMeta = { duration: 12.5, videoWidth: 640, videoHeight: 480 };

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
      );

      expect(res.msgtype).toBe('m.video');
      expect(res.info.duration).toBe(12500);
      expect(res.info.w).toBe(640);
      expect(res.info.h).toBe(480);
      expect(client.uploadContent).toHaveBeenCalledTimes(2);
      expect(res.mxc).toBe('mxc://hs/full');
      // 640×480 scaled to a 480px edge → 480×360.
      expect(res.info.thumbnail_url).toBe('mxc://hs/poster');
      expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
      expect(res.info.thumbnail_info?.w).toBe(480);
      expect(res.info.thumbnail_info?.h).toBe(360);
    });

    it('encrypts the video poster thumbnail for an E2EE room', async () => {
      const { svc, client } = setup();
      encryptMock
        .mockResolvedValueOnce({
          data: new Uint8Array([1]).buffer,
          info: {
            url: '',
            v: 'v2',
            key: {},
            iv: 'pv',
            hashes: { sha256: 'p' },
          },
        }) // poster (encrypted first)
        .mockResolvedValueOnce({
          data: new Uint8Array([2]).buffer,
          info: {
            url: '',
            v: 'v2',
            key: {},
            iv: 'mv',
            hashes: { sha256: 'm' },
          },
        }); // main video
      client.uploadContent
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/poster-ct' })
        .mockResolvedValueOnce({ content_uri: 'mxc://hs/full-ct' });
      videoMeta = { duration: 8, videoWidth: 1280, videoHeight: 720 };

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), true),
      );

      expect(encryptMock).toHaveBeenCalledTimes(2);
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(res.info.thumbnail_file).toMatchObject({
        url: 'mxc://hs/poster-ct',
        iv: 'pv',
        v: 'v2',
      });
      expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
    });

    it('keeps the video dimensions when the poster seek never completes', async () => {
      const { svc, client } = setup();
      videoMeta = { duration: 12.5, videoWidth: 640, videoHeight: 480 };
      videoSeekFires = false; // seeked never fires → the poster timeout fires
      vi.useFakeTimers();
      try {
        const pending = firstValueFrom(
          svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
        );
        // Advance past POSTER_TIMEOUT_MS (3000ms in media.service.ts).
        await vi.advanceTimersByTimeAsync(3000);
        const res = await pending;

        // Dimensions/duration survive even though no poster was captured.
        expect(res.info.duration).toBe(12500);
        expect(res.info.w).toBe(640);
        expect(res.info.thumbnail_url).toBeUndefined();
        expect(client.uploadContent).toHaveBeenCalledTimes(1); // main only
      } finally {
        vi.useRealTimers();
      }
    });

    it('captures the first frame for an unknown-duration video without seeking', async () => {
      const { svc, client } = setup();
      // seekTo resolves to 0 (== currentTime), so no 'seeked' fires — the poster
      // must still be drawn from the current frame.
      videoMeta = { duration: NaN, videoWidth: 320, videoHeight: 240 };
      videoSeekFires = false;

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
      );

      expect(res.info.duration).toBeUndefined();
      expect(client.uploadContent).toHaveBeenCalledTimes(2); // poster + main
      expect(res.info.thumbnail_url).toBeDefined();
      // 320×240 already within the 480px bound → kept as-is.
      expect(res.info.thumbnail_info?.w).toBe(320);
      expect(res.info.thumbnail_info?.h).toBe(240);
    });

    it('keeps the video dimensions when the poster frame fails to encode', async () => {
      const { svc, client } = setup();
      videoMeta = { duration: 5, videoWidth: 640, videoHeight: 480 };
      canvasContext = 'null'; // getContext('2d') → null, so drawPoster bails

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
      );

      expect(res.info.duration).toBe(5000);
      expect(res.info.w).toBe(640);
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(client.uploadContent).toHaveBeenCalledTimes(1); // main only
    });

    it('keeps the video dimensions when the poster seek errors', async () => {
      const { svc, client } = setup();
      videoMeta = { duration: 5, videoWidth: 640, videoHeight: 480 };
      videoErrorsOnSeek = true; // the element errors after metadata, during the seek

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
      );

      expect(res.info.duration).toBe(5000);
      expect(res.info.w).toBe(640);
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(client.uploadContent).toHaveBeenCalledTimes(1); // main only
    });

    describe('with capture hints', () => {
      const hintedThumbnail = (w: number, h: number) => ({
        blob: new Blob([new Uint8Array([7, 7])], { type: 'image/jpeg' }),
        w,
        h,
      });

      it('lets complete video hints win and skips the WebView probe entirely', async () => {
        const { svc, client } = setup();
        client.uploadContent
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/hinted-poster' })
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' });
        // What a probe WOULD report, so one that ran would show in the result.
        videoMeta = { duration: 3, videoWidth: 640, videoHeight: 480 };
        const created = vi.spyOn(document, 'createElement');

        const res = await firstValueFrom(
          svc.uploadMedia(
            mediaFile('video.mov', 'video/quicktime'),
            false,
            undefined,
            undefined,
            undefined,
            {
              width: 1920,
              height: 1080,
              durationMs: 12_500,
              thumbnail: hintedThumbnail(480, 270),
            },
          ),
        );

        expect(created).not.toHaveBeenCalledWith('video');
        expect(res.msgtype).toBe('m.video');
        expect(res.info).toMatchObject({
          w: 1920,
          h: 1080,
          duration: 12_500,
          thumbnail_url: 'mxc://hs/hinted-poster',
          thumbnail_info: { mimetype: 'image/jpeg', w: 480, h: 270, size: 2 },
        });
      });

      it('probes only for what partial hints leave out', async () => {
        const { svc, client } = setup();
        client.uploadContent
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/poster' })
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' });
        videoMeta = { duration: 8, videoWidth: 640, videoHeight: 480 };

        const res = await firstValueFrom(
          svc.uploadMedia(
            mediaFile('video.mp4', 'video/mp4'),
            false,
            undefined,
            undefined,
            undefined,
            { width: 1920, height: 1080 },
          ),
        );

        // Hints win for the size; the probe supplies duration and poster.
        expect(res.info.w).toBe(1920);
        expect(res.info.h).toBe(1080);
        expect(res.info.duration).toBe(8000);
        expect(res.info.thumbnail_url).toBe('mxc://hs/poster');
        expect(res.info.thumbnail_info).toMatchObject({ w: 480, h: 360 });
      });

      it('renders its own thumbnail when the hinted one exceeds the thumbnail bound', async () => {
        const { svc, client } = setup();
        client.uploadContent
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/poster' })
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' });
        videoMeta = { duration: 3, videoWidth: 640, videoHeight: 480 };

        const res = await firstValueFrom(
          svc.uploadMedia(
            mediaFile('video.mov', 'video/quicktime'),
            false,
            undefined,
            undefined,
            undefined,
            {
              width: 1920,
              height: 1080,
              durationMs: 12_500,
              thumbnail: hintedThumbnail(1280, 720),
            },
          ),
        );

        expect(res.info.duration).toBe(12_500); // the hint still wins
        expect(res.info.thumbnail_info).toMatchObject({ w: 480, h: 360 });
      });

      it('lets complete photo hints skip decoding the image', async () => {
        const { svc, client } = setup();
        client.uploadContent
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/thumb' })
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' });
        stubBitmap(4000, 3000);

        const res = await firstValueFrom(
          svc.uploadMedia(imageFile(), false, undefined, undefined, undefined, {
            width: 4032,
            height: 3024,
            thumbnail: hintedThumbnail(480, 360),
          }),
        );

        expect(createImageBitmap).not.toHaveBeenCalled();
        expect(res.info).toMatchObject({ w: 4032, h: 3024 });
        expect(res.info.thumbnail_url).toBe('mxc://hs/thumb');
      });

      it('still sends when a hinted thumbnail fails to upload', async () => {
        const { svc, client } = setup();
        client.uploadContent
          .mockRejectedValueOnce(new Error('thumb upload failed'))
          .mockResolvedValueOnce({ content_uri: 'mxc://hs/full' });

        const res = await firstValueFrom(
          svc.uploadMedia(
            mediaFile('video.mov', 'video/quicktime'),
            false,
            undefined,
            undefined,
            undefined,
            {
              width: 1920,
              height: 1080,
              durationMs: 4000,
              thumbnail: hintedThumbnail(480, 270),
            },
          ),
        );

        expect(res.mxc).toBe('mxc://hs/full');
        expect(res.info.thumbnail_url).toBeUndefined();
        expect(res.info.duration).toBe(4000);
      });
    });

    it('probes duration (ms) for audio without dimensions', async () => {
      const { svc } = setup();
      audioMeta = { duration: 30 };

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('voice.ogg', 'audio/ogg'), false),
      );

      expect(res.msgtype).toBe('m.audio');
      expect(res.info.duration).toBe(30000);
      expect(res.info.w).toBeUndefined();
      expect(res.info.h).toBeUndefined();
    });

    it('omits duration when metadata loads but duration is unavailable', async () => {
      const { svc } = setup(); // videoMeta defaults to NaN duration / 0 dims

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
      );

      expect(res.info.duration).toBeUndefined();
      expect(res.info.w).toBeUndefined();
    });

    it('resolves empty (no hang) when metadata never arrives, via the timeout', async () => {
      const { svc, client } = setup();
      mediaElementMode = 'silent'; // neither loadedmetadata nor error ever fires
      vi.useFakeTimers();
      try {
        const pending = firstValueFrom(
          svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
        );
        // Advance past METADATA_TIMEOUT_MS (5000ms in media.service.ts) so the
        // probe's safety timeout fires and resolves to empty dims.
        await vi.advanceTimersByTimeAsync(5000);
        const res = await pending;

        expect(res.msgtype).toBe('m.video');
        expect(res.info.duration).toBeUndefined();
        expect(res.info.w).toBeUndefined();
        // The off-screen probe URL is revoked even on the timeout path.
        expect(revokeObjectURL).toHaveBeenCalled();
        // The main upload still ran.
        expect(client.uploadContent).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves empty when the media element errors', async () => {
      const { svc } = setup();
      mediaElementMode = 'error'; // the element fires onerror instead of metadata

      const res = await firstValueFrom(
        svc.uploadMedia(mediaFile('voice.ogg', 'audio/ogg'), false),
      );

      expect(res.msgtype).toBe('m.audio');
      expect(res.info.duration).toBeUndefined();
      expect(revokeObjectURL).toHaveBeenCalled(); // URL revoked on the error path too
    });
  });

  describe('uploadLimit', () => {
    it('reads m.upload.size once per client and shares it', async () => {
      const getMediaConfig = vi
        .fn()
        .mockResolvedValue({ 'm.upload.size': 52_428_800 });
      const { svc, client } = setup({ getMediaConfig });
      const c = client as unknown as MatrixClient;

      expect(await firstValueFrom(svc.uploadLimit(c))).toBe(52_428_800);
      expect(await firstValueFrom(svc.uploadLimit(c))).toBe(52_428_800);
      expect(getMediaConfig).toHaveBeenCalledTimes(1);
      expect(getMediaConfig).toHaveBeenCalledWith(true); // authenticated media
    });

    it('is null when the server states no limit', async () => {
      const { svc, client } = setup({
        getMediaConfig: vi.fn().mockResolvedValue({}),
      });

      expect(
        await firstValueFrom(
          svc.uploadLimit(client as unknown as MatrixClient),
        ),
      ).toBeNull();
    });

    it('is null when the server cannot be asked, and asks again next time', async () => {
      const getMediaConfig = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ 'm.upload.size': 1000 });
      const { svc, client } = setup({ getMediaConfig });
      const c = client as unknown as MatrixClient;

      expect(await firstValueFrom(svc.uploadLimit(c))).toBeNull();
      expect(await firstValueFrom(svc.uploadLimit(c))).toBe(1000);
    });
  });
});
