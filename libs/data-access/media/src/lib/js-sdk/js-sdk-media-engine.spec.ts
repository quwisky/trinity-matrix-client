import { TestBed } from '@angular/core/testing';
import { MatrixError } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  assertProgressThenResult,
  encryptAttachment,
  type EncryptedFileInfo,
} from '@trinity/util/matrix';
import type { MediaRequest, UploadRequest } from '../media-engine';
import { downscaleImage } from '../media-processing';
import { JsSdkMediaEngine } from './js-sdk-media-engine';

vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const real = await importOriginal<typeof import('@trinity/util/matrix')>();
  return { ...real, encryptAttachment: vi.fn(real.encryptAttachment) };
});

vi.mock('../media-processing', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media-processing')>();
  return { ...real, downscaleImage: vi.fn(real.downscaleImage) };
});

const ALICE = '@alice:hs';

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getVersions: vi.fn().mockResolvedValue({ versions: ['v1.11'] }),
    getAccessToken: vi.fn(() => 'tok'),
    getMediaConfig: vi.fn().mockResolvedValue({ 'm.upload.size': 100 }),
    uploadContent: vi.fn().mockResolvedValue({ content_uri: 'mxc://hs/up' }),
    mxcUrlToHttp: vi.fn(
      (mxc: string, w?: number, h?: number, method?: string) =>
        `https://hs/${mxc.slice(6)}${w ? `?w=${w}&h=${h}&m=${method}` : ''}`,
    ),
    ...overrides,
  };
}

const PLAIN: UploadRequest = {
  filename: 'a.png',
  mimeType: 'image/png',
  encrypt: false,
};

function plainRequest(format: MediaRequest['format']): MediaRequest {
  return {
    source: { kind: 'plain', mxc: 'mxc://hs/a' },
    format,
    mimeType: 'image/png',
    downscaleTo: null,
  };
}

describe('JsSdkMediaEngine', () => {
  let client: ReturnType<typeof fakeClient>;
  let engine: JsSdkMediaEngine;
  let fetchMock: ReturnType<typeof vi.fn>;

  function setup(overrides: Record<string, unknown> = {}): void {
    client = fakeClient(overrides);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === ALICE ? client : null),
          },
        },
      ],
    });
    engine = TestBed.inject(JsSdkMediaEngine);
  }

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  /** The blob the engine hands to `URL.createObjectURL` during `run`. */
  async function mintedBlob(run: () => Promise<unknown>): Promise<Blob> {
    const mint = vi.spyOn(URL, 'createObjectURL');
    try {
      await run();
      return mint.mock.calls[0][0] as Blob;
    } finally {
      mint.mockRestore();
    }
  }

  /** Serve `ciphertext` for every fetch; the file info decrypts it. */
  async function serveEncrypted(
    plaintext: Uint8Array,
  ): Promise<EncryptedFileInfo> {
    const { data, info } = await encryptAttachment(plaintext.slice().buffer);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(data),
    });
    return { ...info, url: 'mxc://hs/cipher' };
  }

  function encryptedRequest(
    file: EncryptedFileInfo,
    downscaleTo: number | null,
  ): MediaRequest {
    return {
      source: { kind: 'encrypted', file },
      format: { kind: 'file' },
      mimeType: 'image/jpeg',
      downscaleTo,
    };
  }

  const authHeaderOf = (call: number): unknown =>
    fetchMock.mock.calls[call]?.[1]?.headers?.Authorization;

  it('uses the legacy media endpoint without a token when v1.11 is unsupported', async () => {
    setup({ getVersions: vi.fn().mockResolvedValue({ versions: ['v1.10'] }) });

    await firstValueFrom(engine.content(ALICE, plainRequest({ kind: 'file' })));

    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });

  it('mints a plain file with the requested mime type', async () => {
    setup();

    const blob = await mintedBlob(() =>
      firstValueFrom(engine.content(ALICE, plainRequest({ kind: 'file' }))),
    );

    expect(blob.type).toBe('image/png');
  });

  it.each([
    ['a later spec version only', { versions: ['v1.12'] }],
    [
      'the unstable authenticated-media flag',
      {
        versions: ['v1.10'],
        unstable_features: { 'org.matrix.msc3916.stable': true },
      },
    ],
  ])(
    'uses authenticated media when the server advertises %s',
    async (_label, versions) => {
      setup({ getVersions: vi.fn().mockResolvedValue(versions) });

      await firstValueFrom(
        engine.content(ALICE, plainRequest({ kind: 'file' })),
      );

      expect(authHeaderOf(0)).toBe('Bearer tok');
    },
  );

  it('tries authenticated media while /versions is unreadable and asks again on the next request', async () => {
    const getVersions = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ versions: ['v1.10'] });
    setup({ getVersions });
    const content = engine.content(ALICE, plainRequest({ kind: 'file' }));

    await firstValueFrom(content);
    await firstValueFrom(content);

    expect(authHeaderOf(0)).toBe('Bearer tok');
    expect(getVersions).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined();
  });

  it('decrypts an encrypted file and mints its plaintext', async () => {
    setup();
    const plaintext = new Uint8Array([1, 2, 3]);
    const file = await serveEncrypted(plaintext);

    const result = await firstValueFrom(
      engine.content(ALICE, encryptedRequest(file, null)),
    );

    expect(result).toEqual({
      ok: true,
      value: { url: expect.stringMatching(/^blob:/), size: 3 },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('hs/cipher');
    expect(downscaleImage).not.toHaveBeenCalled();
  });

  it('mints a decrypted file with the requested mime type', async () => {
    setup();
    const file = await serveEncrypted(new Uint8Array([1, 2, 3]));

    const blob = await mintedBlob(() =>
      firstValueFrom(engine.content(ALICE, encryptedRequest(file, null))),
    );

    expect(blob.type).toBe('image/jpeg');
  });

  it('shrinks a decrypted image to the requested edge before minting it', async () => {
    setup();
    const file = await serveEncrypted(new Uint8Array([1, 2, 3]));
    vi.mocked(downscaleImage).mockResolvedValueOnce(
      new Blob([new Uint8Array(2)], { type: 'image/jpeg' }),
    );

    const result = await firstValueFrom(
      engine.content(ALICE, encryptedRequest(file, 640)),
    );

    expect(vi.mocked(downscaleImage).mock.calls[0]?.[1]).toBe(640);
    expect(result.ok && result.value.size).toBe(2);
  });

  it('errors the stream when the downscale itself fails', async () => {
    setup();
    const file = await serveEncrypted(new Uint8Array([1, 2, 3]));
    vi.mocked(downscaleImage).mockRejectedValueOnce(new Error('canvas gone'));

    await expect(
      firstValueFrom(engine.content(ALICE, encryptedRequest(file, 640))),
    ).rejects.toThrow('canvas gone');
  });

  it('answers media-unavailable for bytes that fail their hash check', async () => {
    setup();
    const file = await serveEncrypted(new Uint8Array([1, 2, 3]));

    const result = await firstValueFrom(
      engine.content(
        ALICE,
        encryptedRequest({ ...file, hashes: { sha256: 'tampered' } }, null),
      ),
    );

    expect(!result.ok && result.failure.code).toBe('media-unavailable');
  });

  it('asks the server for a thumbnail at the requested size and method', async () => {
    setup();

    const result = await firstValueFrom(
      engine.content(
        ALICE,
        plainRequest({
          kind: 'thumbnail',
          width: 64,
          height: 48,
          method: 'crop',
          animated: false,
        }),
      ),
    );

    expect(result).toEqual({
      ok: true,
      value: { url: expect.stringMatching(/^blob:/), size: 4 },
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://hs/hs/a?w=64&h=48&m=crop',
    );
  });

  it('keeps the authenticated-media probe until forgetProbes', async () => {
    setup();
    const content = engine.content(ALICE, plainRequest({ kind: 'file' }));

    await firstValueFrom(content);
    await firstValueFrom(content);
    await firstValueFrom(engine.forgetProbes());
    await firstValueFrom(content);

    expect(client.getVersions).toHaveBeenCalledTimes(2);
  });

  it('caches the upload limit per client but retries a failed lookup', async () => {
    setup({
      getMediaConfig: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ 'm.upload.size': 100 }),
    });

    const failed = await firstValueFrom(engine.uploadLimit(ALICE));
    const first = await firstValueFrom(engine.uploadLimit(ALICE));
    const second = await firstValueFrom(engine.uploadLimit(ALICE));

    expect([failed, first, second]).toEqual([
      { ok: true, value: null },
      { ok: true, value: 100 },
      { ok: true, value: 100 },
    ]);
    expect(client.getMediaConfig).toHaveBeenCalledTimes(2);
  });

  it('uploads plain bytes under their name and type, reporting progress', async () => {
    setup({
      uploadContent: vi.fn(
        async (_file: Blob, opts: { progressHandler(p: object): void }) => {
          opts.progressHandler({ loaded: 1, total: 4 });
          return { content_uri: 'mxc://hs/up' };
        },
      ),
    });

    const { progress, result } = await assertProgressThenResult(
      engine.upload(ALICE, new Blob(['abcd']), PLAIN),
    );

    expect(progress).toEqual([
      { kind: 'progress', phase: 'uploading', fraction: 0.25 },
    ]);
    expect(result).toEqual({
      ok: true,
      value: { kind: 'plain', mxc: 'mxc://hs/up', size: 4 },
    });
    expect(client.uploadContent.mock.calls[0][1]).toMatchObject({
      name: 'a.png',
      type: 'image/png',
    });
  });

  it('uploads encrypted bytes with no name and an opaque type', async () => {
    setup();

    const { result } = await assertProgressThenResult(
      engine.upload(ALICE, new Blob(['abcd']), { ...PLAIN, encrypt: true }),
    );

    expect(result.ok && result.value).toMatchObject({
      kind: 'encrypted',
      file: { url: 'mxc://hs/up', v: 'v2' },
      size: 4,
    });
    const options = client.uploadContent.mock.calls[0][1];
    expect(options).toMatchObject({
      includeFilename: false,
      type: 'application/octet-stream',
    });
    expect(options).not.toHaveProperty('name');
  });

  it('aborts the upload when unsubscribed', async () => {
    let signal: AbortSignal | undefined;
    setup({
      uploadContent: vi.fn(
        (_file: Blob, opts: { abortController: AbortController }) => {
          signal = opts.abortController.signal;
          return new Promise(() => undefined);
        },
      ),
    });

    const subscription = engine
      .upload(ALICE, new Blob(['abcd']), PLAIN)
      .subscribe();
    await vi.waitFor(() => expect(signal).toBeDefined());
    subscription.unsubscribe();

    expect(signal?.aborted).toBe(true);
  });

  it('refuses a file over the stated limit before uploading it', async () => {
    setup();

    const { progress, result } = await assertProgressThenResult(
      engine.upload(ALICE, new Blob([new Uint8Array(101)]), PLAIN),
    );

    expect(progress).toEqual([]);
    expect(!result.ok && result.failure.code).toBe('too-large');
    expect(client.uploadContent).not.toHaveBeenCalled();
  });

  it('answers too-large for M_TOO_LARGE', async () => {
    setup({
      uploadContent: vi
        .fn()
        .mockRejectedValue(
          new MatrixError({ errcode: 'M_TOO_LARGE', error: 'big' }, 413),
        ),
    });

    const { result } = await assertProgressThenResult(
      engine.upload(ALICE, new Blob(['abcd']), PLAIN),
    );

    expect(!result.ok && result.failure.code).toBe('too-large');
  });

  it('errors the stream when the file cannot be read', async () => {
    setup();
    const unreadable = new Blob(['abcd']);
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(
      new Error('file gone'),
    );

    await expect(
      firstValueFrom(
        engine.upload(ALICE, unreadable, { ...PLAIN, encrypt: true }),
      ),
    ).rejects.toThrow('file gone');
    expect(client.uploadContent).not.toHaveBeenCalled();
  });

  it('errors the stream when encryption fails', async () => {
    setup();
    vi.mocked(encryptAttachment).mockRejectedValueOnce(
      new Error('no subtle crypto'),
    );

    await expect(
      firstValueFrom(
        engine.upload(ALICE, new Blob(['abcd']), { ...PLAIN, encrypt: true }),
      ),
    ).rejects.toThrow('no subtle crypto');
    expect(client.uploadContent).not.toHaveBeenCalled();
  });
});
