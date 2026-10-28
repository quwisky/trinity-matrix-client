import { type Observable, firstValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EncryptedFileInfo,
  assertPlainData,
  assertProgressThenResult,
} from '@trinity/util/matrix';
import type {
  MediaEngine,
  MediaRequest,
  MediaSource,
  UploadRequest,
  UploadedContent,
} from '../lib/media-engine';

export interface MediaContractSetup {
  readonly engine: MediaEngine;
  /** A live account in `engine`. */
  readonly alice: string;
  /** The bytes behind a URL from `content`; rejects once the URL is released. */
  read(url: string): Promise<Uint8Array>;
  /** The name and type the server holds for an uploaded `mxc://`. */
  stored(
    mxc: string,
  ): Promise<{ readonly filename: string | null; readonly mimeType: string }>;
  dispose(): Promise<void>;
}

export interface MediaContractTiming {
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

const NOBODY = '@nobody:invalid';

/** A 1×1 PNG, so a server can thumbnail it. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 65_536) {
    crypto.getRandomValues(bytes.subarray(i, i + 65_536));
  }
  return bytes;
}

function request(
  source: MediaSource,
  format: MediaRequest['format'] = { kind: 'file' },
): MediaRequest {
  return { source, format, mimeType: 'image/png', downscaleTo: null };
}

export function defineMediaEngineContract(
  setup: () => Promise<MediaContractSetup>,
  { testTimeoutMs }: MediaContractTiming,
): void {
  describe('MediaEngine contract', () => {
    let context: MediaContractSetup;
    let engine: MediaEngine;
    let alice: string;

    beforeEach(async () => {
      context = await setup();
      ({ engine, alice } = context);
    }, testTimeoutMs);

    afterEach(async () => {
      await context.dispose();
    }, testTimeoutMs);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    async function upload(
      bytes: Uint8Array<ArrayBuffer>,
      options: Partial<UploadRequest> = {},
    ): Promise<UploadedContent> {
      const { progress, result } = await assertProgressThenResult(
        engine.upload(alice, new Blob([bytes]), {
          filename: 'photo.png',
          mimeType: 'image/png',
          encrypt: false,
          ...options,
        }),
      );
      for (const update of progress) {
        expect(update.fraction).toBeGreaterThanOrEqual(0);
        expect(update.fraction).toBeLessThanOrEqual(1);
      }
      if (!result.ok) throw new Error(`Upload failed: ${result.failure.code}`);
      return result.value;
    }

    async function contentOf(
      mediaRequest: MediaRequest,
    ): Promise<{ readonly url: string; readonly bytes: Uint8Array }> {
      const result = await once(engine.content(alice, mediaRequest));
      if (!result.ok) {
        throw new Error(`Content failed: ${result.failure.code}`);
      }
      const bytes = await context.read(result.value.url);
      expect(result.value.size).toBe(bytes.byteLength);
      return { url: result.value.url, bytes };
    }

    async function failureOf(mediaRequest: MediaRequest): Promise<string> {
      const result = await once(engine.content(alice, mediaRequest));
      return result.ok ? 'ok' : result.failure.code;
    }

    async function encryptedPng(): Promise<EncryptedFileInfo> {
      const uploaded = await upload(PNG, {
        filename: 'secret-name.png',
        encrypt: true,
      });
      if (uploaded.kind !== 'encrypted') throw new Error('Not encrypted');
      return uploaded.file;
    }

    it(
      'uploads plain bytes under their name and type and reads them back',
      async () => {
        const bytes = randomBytes(4096);
        const uploaded = await upload(bytes);
        if (uploaded.kind !== 'plain') throw new Error('Not plain');

        expect(uploaded.mxc).toMatch(/^mxc:\/\//);
        expect(uploaded.size).toBe(bytes.byteLength);
        await expect(context.stored(uploaded.mxc)).resolves.toEqual({
          filename: 'photo.png',
          mimeType: 'image/png',
        });
        const { bytes: read } = await contentOf(
          request({ kind: 'plain', mxc: uploaded.mxc }),
        );
        expect(read).toEqual(bytes);
      },
      testTimeoutMs,
    );

    it(
      'uploads encrypted bytes without their name or type and decrypts them back',
      async () => {
        const file = await encryptedPng();

        expect(file.url).toMatch(/^mxc:\/\//);
        await expect(context.stored(file.url)).resolves.toEqual({
          filename: null,
          mimeType: 'application/octet-stream',
        });
        const { bytes } = await contentOf(request({ kind: 'encrypted', file }));
        expect(bytes).toEqual(PNG);
        const { bytes: ciphertext } = await contentOf(
          request({ kind: 'plain', mxc: file.url }),
        );
        expect(ciphertext).not.toEqual(PNG);
      },
      testTimeoutMs,
    );

    it(
      'mints a fresh URL on every subscription',
      async () => {
        const uploaded = await upload(PNG);
        if (uploaded.kind !== 'plain') throw new Error('Not plain');
        const content = engine.content(
          alice,
          request({ kind: 'plain', mxc: uploaded.mxc }),
        );

        const first = await once(content);
        const second = await once(content);

        expect(first.ok && second.ok).toBe(true);
        expect(first.ok && first.value.url).not.toBe(
          second.ok && second.value.url,
        );
      },
      testTimeoutMs,
    );

    it(
      'serves a thumbnail of plain media, and the whole file for encrypted media',
      async () => {
        const uploaded = await upload(PNG);
        if (uploaded.kind !== 'plain') throw new Error('Not plain');
        const thumbnail = {
          kind: 'thumbnail',
          width: 32,
          height: 32,
          method: 'scale',
          animated: false,
        } as const;

        const plain = await contentOf(
          request({ kind: 'plain', mxc: uploaded.mxc }, thumbnail),
        );
        const encrypted = await contentOf(
          request({ kind: 'encrypted', file: await encryptedPng() }, thumbnail),
        );

        expect(plain.bytes.byteLength).toBeGreaterThan(0);
        expect(encrypted.bytes).toEqual(PNG);
      },
      testTimeoutMs,
    );

    it(
      'answers media-unavailable for no source or a failed hash check',
      async () => {
        const file = await encryptedPng();
        const tampered = {
          ...file,
          hashes: { sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        };

        expect(await failureOf(request({ kind: 'plain', mxc: '' }))).toBe(
          'media-unavailable',
        );
        expect(
          await failureOf(request({ kind: 'encrypted', file: tampered })),
        ).toBe('media-unavailable');
      },
      testTimeoutMs,
    );

    it(
      'release ends a URL and replies null, ignoring unknown URLs',
      async () => {
        const uploaded = await upload(PNG);
        if (uploaded.kind !== 'plain') throw new Error('Not plain');
        const { url } = await contentOf(
          request({ kind: 'plain', mxc: uploaded.mxc }),
        );

        expect(await once(engine.release([url, 'blob:unknown']))).toBeNull();
        await expect(context.read(url)).rejects.toThrow();
      },
      testTimeoutMs,
    );

    it(
      'forgetProbes replies null and media still loads',
      async () => {
        const uploaded = await upload(PNG);
        if (uploaded.kind !== 'plain') throw new Error('Not plain');

        expect(await once(engine.forgetProbes())).toBeNull();
        const { bytes } = await contentOf(
          request({ kind: 'plain', mxc: uploaded.mxc }),
        );
        expect(bytes).toEqual(PNG);
      },
      testTimeoutMs,
    );

    it(
      'refuses an upload over the stated limit as too-large',
      async () => {
        const limit = await once(engine.uploadLimit(alice));
        if (!limit.ok || limit.value === null) {
          throw new Error('The server states no upload limit');
        }
        expect(limit.value).toBeGreaterThan(0);

        const { result } = await assertProgressThenResult(
          engine.upload(alice, new Blob([new Uint8Array(limit.value + 1)]), {
            filename: 'big.bin',
            mimeType: 'application/octet-stream',
            encrypt: false,
          }),
        );

        expect(result).toMatchObject({
          ok: false,
          failure: { code: 'too-large' },
        });
      },
      testTimeoutMs,
    );

    it(
      'stops an upload when unsubscribed',
      async () => {
        const seen: unknown[] = [];
        const subscription = engine
          .upload(alice, new Blob([randomBytes(1_048_576)]), {
            filename: 'gone.bin',
            mimeType: 'application/octet-stream',
            encrypt: false,
          })
          .subscribe({
            next: (update) => seen.push(update),
            error: (error: unknown) => seen.push(error),
          });
        subscription.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(seen).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'commands for an unknown account are account-not-live',
      async () => {
        const content = await once(
          engine.content(NOBODY, request({ kind: 'plain', mxc: 'mxc://x/y' })),
        );
        const limit = await once(engine.uploadLimit(NOBODY));
        const { result } = await assertProgressThenResult(
          engine.upload(NOBODY, new Blob([PNG]), {
            filename: null,
            mimeType: 'image/png',
            encrypt: false,
          }),
        );

        expect(
          [content, limit, result].map((r) => !r.ok && r.failure.code),
        ).toEqual(['account-not-live', 'account-not-live', 'account-not-live']);
      },
      testTimeoutMs,
    );
  });
}
