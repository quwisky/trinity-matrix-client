import { TestBed } from '@angular/core/testing';
import { MatrixError } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { assertProgressThenResult } from '@trinity/util/matrix';
import type { MediaRequest, UploadRequest } from '../media-engine';
import { JsSdkMediaEngine } from './js-sdk-media-engine';

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
});
