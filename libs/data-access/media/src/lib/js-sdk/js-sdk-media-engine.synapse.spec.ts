import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, vi } from 'vitest';
import { defineMediaEngineContract } from '../../contract/media-engine.contract';
import { JsSdkMediaEngine } from './js-sdk-media-engine';
import {
  baseUrl,
  localpart,
  register,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

function filenameOf(disposition: string): string | null {
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

// Runs the media contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkMediaEngine against Synapse', () => {
  useSynapseSuite();

  // jsdom cannot fetch a blob: URL, so the object-URL registry is kept here and read back.
  const blobs = new Map<string, Blob>();
  let minted = 0;
  beforeEach(() => {
    blobs.clear();
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:synapse/${++minted}`;
      blobs.set(url, blob as Blob);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      blobs.delete(url);
    });
  });

  defineMediaEngineContract(
    async () => {
      const session = await startSession(await register(localpart('alice')));

      return {
        engine: TestBed.inject(JsSdkMediaEngine),
        alice: session.userId,
        read: async (url) => {
          const blob = blobs.get(url);
          if (!blob) throw new Error(`No bytes behind ${url}`);
          return new Uint8Array(await blob.arrayBuffer());
        },
        stored: async (mxc) => {
          const res = await fetch(
            `${baseUrl}/_matrix/client/v1/media/download/${mxc.slice('mxc://'.length)}`,
            { headers: { authorization: `Bearer ${session.accessToken}` } },
          );
          if (!res.ok)
            throw new Error(`Synapse download failed: ${res.status}`);
          return {
            filename: filenameOf(res.headers.get('content-disposition') ?? ''),
            mimeType: (res.headers.get('content-type') ?? '')
              .split(';')[0]
              .trim(),
          };
        },
        dispose: () => session.dispose(),
      };
    },
    { testTimeoutMs: 180_000 },
  );
});
