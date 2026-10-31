import {
  type Observable,
  type Subscription,
  firstValueFrom,
  takeWhile,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EncryptedFileInfo,
  assertPlainData,
  assertProgressThenResult,
  mediaCaptionFields,
} from '@trinity/util/matrix';
import type {
  AttachmentRequest,
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
  /** A new room alice is in, with `m.room.encryption` when `encrypted`; the engine sees it. */
  room(encrypted: boolean): Promise<string>;
  /** The media messages in a room, oldest first. */
  messages(roomId: string): Promise<readonly ContractMessage[]>;
  /** The next message send reaches the server, but its answer is lost on the way back. */
  dropNextSendResponse(): void;
  /** Uploads (files and thumbnails) that reached the media repository so far in this test. */
  uploads(): number;
  /** Takes alice's crypto away, as for an account whose crypto store could not start. */
  withoutCrypto(): void;
  dispose(): Promise<void>;
}

export interface ContractMessage {
  readonly msgtype: string;
  readonly body: string;
  readonly hasThumbnail: boolean;
}

export interface MediaContractTiming {
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

const NOBODY = '@nobody:invalid';
const NO_ROOM = '!missing:invalid';

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
      'emits nothing more once unsubscribed after its first progress',
      async () => {
        const seen: unknown[] = [];
        let firstProgress!: () => void;
        const progressed = new Promise<void>((resolve) => {
          firstProgress = resolve;
        });
        const subscription: Subscription = engine
          .upload(alice, new Blob([randomBytes(1_048_576)]), {
            filename: 'gone.bin',
            mimeType: 'application/octet-stream',
            encrypt: false,
          })
          .subscribe({
            next: (update) => {
              seen.push(update.kind);
              if (update.kind === 'progress') firstProgress();
            },
            error: (error: unknown) => seen.push(error),
          });
        await progressed;
        subscription.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(seen).toEqual(['progress']);
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

  describe('MediaEngine attachments', () => {
    let context: MediaContractSetup;
    let engine: MediaEngine;
    let alice: string;
    let keys = 0;

    beforeEach(async () => {
      context = await setup();
      ({ engine, alice } = context);
    }, testTimeoutMs);

    afterEach(async () => {
      await context.dispose();
    }, testTimeoutMs);

    function attachment(
      overrides: Partial<AttachmentRequest> = {},
    ): AttachmentRequest {
      const merged = {
        attachmentKey: `key-${++keys}`,
        threadRootId: null,
        file: new Blob([PNG], { type: 'image/png' }),
        filename: 'photo.png',
        mimeType: 'image/png',
        msgtype: 'm.image',
        info: { w: 1, h: 1, durationMs: null },
        thumbnail: null,
        caption: '',
        metadata: 'stripped',
        ...overrides,
      } satisfies Omit<AttachmentRequest, 'captionFields'>;
      return {
        ...merged,
        captionFields: mediaCaptionFields(
          merged.filename || 'attachment',
          merged.caption,
        ),
      };
    }

    async function send(roomId: string, request: AttachmentRequest) {
      return assertProgressThenResult(
        engine.sendAttachment(alice, roomId, request),
      );
    }

    /** Sends until the engine reports the upload done, then unsubscribes before the send. */
    async function uploadOnly(
      roomId: string,
      request: AttachmentRequest,
    ): Promise<void> {
      const seen = await firstValueFrom(
        engine.sendAttachment(alice, roomId, request).pipe(
          takeWhile(
            (update) =>
              !(update.kind === 'progress' && update.phase === 'sending'),
            true,
          ),
          toArray(),
        ),
      );
      expect(seen.at(-1)).toMatchObject({ kind: 'progress', phase: 'sending' });
    }

    it(
      'uploads and sends one media message, reporting progress then one result',
      async () => {
        const roomId = await context.room(false);

        const { progress, result } = await send(
          roomId,
          attachment({
            caption: 'look',
            thumbnail: {
              blob: new Blob([PNG], { type: 'image/png' }),
              mimeType: 'image/png',
              w: 1,
              h: 1,
            },
          }),
        );

        expect(result.ok && result.value.kind).toBe('sent');
        expect(progress.map((update) => update.phase)).toContain('sending');
        expect(context.uploads()).toBe(2);
        expect(await context.messages(roomId)).toEqual([
          { msgtype: 'm.image', body: 'look', hasThumbnail: true },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'reuses the upload when the same key is sent again',
      async () => {
        const roomId = await context.room(false);
        const request = attachment();

        await uploadOnly(roomId, request);
        const { result } = await send(roomId, request);

        expect(result.ok && result.value.kind).toBe('sent');
        expect(context.uploads()).toBe(1);
        expect(await context.messages(roomId)).toHaveLength(1);
      },
      testTimeoutMs,
    );

    it(
      'reuses the upload for a changed caption',
      async () => {
        const roomId = await context.room(false);
        const request = attachment({ caption: 'first' });

        await uploadOnly(roomId, request);
        await send(roomId, { ...request, caption: 'second' });

        expect(context.uploads()).toBe(1);
        expect(await context.messages(roomId)).toEqual([
          { msgtype: 'm.image', body: 'second', hasThumbnail: false },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'uploads again for a changed key, and for one that supersedes the last',
      async () => {
        const roomId = await context.room(false);
        const first = attachment({ metadata: 'kept' });

        await uploadOnly(roomId, first);
        await uploadOnly(roomId, attachment());
        const { result } = await send(
          roomId,
          attachment({ supersedes: first.attachmentKey }),
        );

        expect(result.ok && result.value.kind).toBe('sent');
        expect(context.uploads()).toBe(3);
        expect(await context.messages(roomId)).toHaveLength(1);
      },
      testTimeoutMs,
    );

    it(
      'uploads again once the key is forgotten',
      async () => {
        const roomId = await context.room(false);
        const request = attachment();

        await uploadOnly(roomId, request);
        const forgotten = await firstValueFrom(
          engine.forgetAttachment(request.attachmentKey).pipe(toArray()),
        );
        await send(roomId, request);

        expect(forgotten).toEqual([null]);
        expect(context.uploads()).toBe(2);
      },
      testTimeoutMs,
    );

    // Withdrawing an echo on unsubscribe needs a send caught between its start and the
    // server's answer, which Synapse does not let a test hold; fake-media-engine.spec.ts and
    // js-sdk-media-engine.attachments.spec.ts cover it.
    it(
      'emits nothing more, uploads nothing more and sends nothing once unsubscribed after its first progress',
      async () => {
        const roomId = await context.room(false);
        const seen: unknown[] = [];
        let firstProgress!: () => void;
        const progressed = new Promise<void>((resolve) => {
          firstProgress = resolve;
        });
        const subscription: Subscription = engine
          .sendAttachment(alice, roomId, attachment())
          .subscribe({
            next: (update) => {
              seen.push(update.kind);
              if (update.kind === 'progress') firstProgress();
            },
            error: (error: unknown) => seen.push(error),
          });
        await progressed;
        subscription.unsubscribe();
        const uploaded = context.uploads();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(seen).toEqual(['progress']);
        expect(context.uploads()).toBe(uploaded);
        expect(await context.messages(roomId)).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'fails an upload with no sending update',
      async () => {
        const roomId = await context.room(false);
        const limit = await firstValueFrom(engine.uploadLimit(alice));
        if (!limit.ok || limit.value === null) {
          throw new Error('The server states no upload limit');
        }

        const { progress, result } = await send(
          roomId,
          attachment({ file: new Blob([new Uint8Array(limit.value + 1)]) }),
        );

        expect(result).toMatchObject({
          ok: false,
          failure: { code: 'too-large' },
        });
        expect(progress.map((update) => update.phase)).not.toContain('sending');
        expect(await context.messages(roomId)).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'fails a send after its sending update, and a retry with the key dedupes it without uploading again',
      async () => {
        const roomId = await context.room(false);
        const request = attachment({ caption: 'once' });
        context.dropNextSendResponse();

        const failed = await send(roomId, request);
        const uploaded = context.uploads();
        const retried = await send(roomId, request);

        expect(failed.progress.at(-1)).toMatchObject({ phase: 'sending' });
        expect(failed.result).toMatchObject({
          ok: false,
          failure: { code: 'request-failed' },
        });
        // The retry reuses the transaction, so the server answers with the event it holds;
        // an engine that already saw that event come back may only say it may have left.
        expect(retried.result.ok && retried.result.value.kind).toMatch(
          /^(sent|indeterminate)$/,
        );
        expect(context.uploads()).toBe(uploaded);
        expect(await context.messages(roomId)).toEqual([
          { msgtype: 'm.image', body: 'once', hasThumbnail: false },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'fails closed with encryption-unavailable in an encrypted room without crypto',
      async () => {
        const roomId = await context.room(true);
        context.withoutCrypto();

        const { progress, result } = await send(roomId, attachment());

        expect(progress).toEqual([]);
        expect(result).toMatchObject({
          ok: false,
          failure: { code: 'encryption-unavailable' },
        });
        expect(context.uploads()).toBe(0);
        expect(await context.messages(roomId)).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'refuses a file whose strip failed in an encrypted room and sends it in a plain one',
      async () => {
        const encrypted = await context.room(true);
        const plain = await context.room(false);

        const refused = await send(
          encrypted,
          attachment({ metadata: 'strip-failed' }),
        );
        const sent = await send(
          plain,
          attachment({ metadata: 'strip-failed' }),
        );

        expect(refused.progress).toEqual([]);
        expect(refused.result).toMatchObject({
          ok: false,
          failure: { code: 'request-failed' },
        });
        expect(sent.result.ok && sent.result.value.kind).toBe('sent');
        expect(context.uploads()).toBe(1);
      },
      testTimeoutMs,
    );

    it(
      'answers conversation-unavailable for an unknown room and account-not-live for an unknown account',
      async () => {
        const roomId = await context.room(false);

        const noRoom = await send(NO_ROOM, attachment());
        const nobody = await assertProgressThenResult(
          engine.sendAttachment(NOBODY, roomId, attachment()),
        );

        expect(
          [noRoom.result, nobody.result].map((r) => !r.ok && r.failure.code),
        ).toEqual(['conversation-unavailable', 'account-not-live']);
        expect(context.uploads()).toBe(0);
      },
      testTimeoutMs,
    );
  });
}
