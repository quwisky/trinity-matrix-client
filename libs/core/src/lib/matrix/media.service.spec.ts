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

  it('errors on an encrypted attachment (decryption is out of scope for Phase 1)', async () => {
    const { svc } = setup();

    await expect(
      firstValueFrom(svc.resolveMedia(encryptedMedia(), 'full')),
    ).rejects.toThrow(/not supported/i);
    expect(fetchMock).not.toHaveBeenCalled();
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
});
