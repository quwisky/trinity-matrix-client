// Shared TestBed scaffolding for the MediaService specs.
//
// media.service.spec.ts (resolve and cache) and media-upload.spec.ts (upload) drive the same
// service over a FakeMediaEngine whose calls are spied, so a spec can read every request,
// release and upload the service made.
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, from, map, switchMap } from 'rxjs';
import { vi } from 'vitest';
import {
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  encryptAttachment,
  engineOk,
  type EncryptedFileInfo,
  type EngineResult,
} from '@trinity/util/matrix';
import { FakeMediaEngine } from '../contract/fake-media-engine';
import type { MediaContent, MediaRequest } from './media-engine';
import { MEDIA_ENGINE } from './media-engine.token';
import { MediaService } from './media.service';
import { DEVICE_PIXEL_RATIO } from './thumbnail-size';

/** Bytes behind every plaintext `mxc://` a spec did not seed itself. */
export const PLAIN_BYTES = new Uint8Array(8);

/** A session where `accounts` are live, each in session `generation`, and `active` is active. */
export function sessionWith(
  active: string | null,
  accounts: readonly string[],
  generation = 1,
): SessionSnapshot {
  return {
    activeAccountId: active,
    accounts: accounts.map((accountId) => ({
      accountId,
      generation,
      syncState: 'syncing',
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
    softLoggedOut: [],
  };
}

/** Encrypt `plaintext` into the engine's repository at `url`; the info decrypts it. */
export async function seedEncrypted(
  engine: FakeMediaEngine,
  url: string,
  plaintext: Uint8Array = new Uint8Array([7, 7, 7]),
): Promise<EncryptedFileInfo> {
  const { data, info } = await encryptAttachment(plaintext.slice().buffer);
  engine.put(url, new Uint8Array(data));
  return { ...info, url };
}

/**
 * Configure MediaService over a fresh FakeMediaEngine with alice active. The spec owns its
 * devicePixelRatio (tests assign it), so the service reads it through this getter.
 */
export function mediaServiceSetup(devicePixelRatio: () => number) {
  return () => {
    const engine = new FakeMediaEngine();
    const session = signal(sessionWith(engine.alice, [engine.alice]));
    const realContent = engine.content.bind(engine);
    let contentSize: number | null = null;
    const seeded = new Set<string>();
    const base = (
      accountId: string,
      request: MediaRequest,
    ): Observable<EngineResult<MediaContent>> => {
      const { source } = request;
      if (source.kind === 'plain' && source.mxc && !seeded.has(source.mxc)) {
        seeded.add(source.mxc);
        engine.put(source.mxc, PLAIN_BYTES);
      }
      return realContent(accountId, request).pipe(
        map((result) =>
          result.ok && contentSize !== null
            ? engineOk({ ...result.value, size: contentSize })
            : result,
        ),
      );
    };
    const content = vi.spyOn(engine, 'content').mockImplementation(base);
    const release = vi.spyOn(engine, 'release');
    const upload = vi.spyOn(engine, 'upload');

    TestBed.configureTestingModule({
      providers: [
        MediaService,
        { provide: DEVICE_PIXEL_RATIO, useValue: devicePixelRatio },
        { provide: MEDIA_ENGINE, useValue: engine },
        { provide: SESSION_SNAPSHOT, useValue: session },
      ],
    });
    const svc = TestBed.inject(MediaService);
    return {
      svc,
      engine,
      session,
      content,
      upload,
      /** Every request the service sent to `content`, in order. */
      requests: (): MediaRequest[] => content.mock.calls.map(([, r]) => r),
      /** Every URL the service released, in order. */
      released: (): string[] => release.mock.calls.flatMap(([urls]) => urls),
      /** Report every minted URL as `mb` megabytes, so budget tests need not allocate them. */
      reportSize: (mb: number): void => {
        contentSize = mb * 1024 * 1024;
      },
      /** Hold the next `content` request until the returned function lets it run. */
      park: (): (() => void) => {
        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        content.mockImplementationOnce((accountId, request) =>
          from(gate).pipe(switchMap(() => base(accountId, request))),
        );
        return () => open();
      },
    };
  };
}
