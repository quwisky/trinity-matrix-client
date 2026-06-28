import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
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
import { MatrixClientService } from './matrix-client.service';
import type { MediaPayload } from './media.model';
import { decryptAttachment, encryptAttachment } from './attachment-crypto';

// Stub attachment-crypto: exercise MediaService's fetch→decrypt→blob and
// encrypt→upload wiring without a real WebCrypto `subtle` backend (absent under
// jsdom). The crypto itself is round-tripped for real in attachment-crypto.spec.ts.
vi.mock('./attachment-crypto', () => ({
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

/** The mocked crypto fns, typed for call assertions / per-test overrides. */
const decryptMock = decryptAttachment as unknown as Mock;
const encryptMock = encryptAttachment as unknown as Mock;

/** Mirrors the (non-exported) CACHE_LIMIT in media.service.ts. */
const CACHE_LIMIT = 64;

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
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;

  TestBed.configureTestingModule({
    providers: [
      MediaService,
      { provide: MatrixClientService, useValue: matrix },
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

  it('downloadMedia returns the full bytes paired with the filename', async () => {
    const { svc } = setup();
    const media = plainMedia('mxc://hs/doc');

    const { blob, filename } = await firstValueFrom(svc.downloadMedia(media));

    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe('pic.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
