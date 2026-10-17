// Shared TestBed scaffolding for the MediaService specs.
//
// media.service.spec.ts (resolve and cache) and media-upload.spec.ts (upload) drive the same
// service over the same fake client and stubbed fetch/object-URL globals. Each spec repeats the
// hoisted vi.mock blocks, so the crypto and metadata functions imported here are those mocks.
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import { MediaService } from './media.service';
import { DEVICE_PIXEL_RATIO } from './thumbnail-size';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { decryptAttachment, encryptAttachment } from '@trinity/util/matrix';
import {
  bytesWithoutMediaMetadata,
  withoutMediaMetadata,
} from './image-metadata/strip-file-metadata';

/** The mocked crypto fns, typed for call assertions / per-test overrides. */
export const decryptMock = decryptAttachment as unknown as Mock;
export const encryptMock = encryptAttachment as unknown as Mock;

export function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as Response;
}

/** Build a fake MatrixClient with the surface MediaService touches. */
export function fakeClient(overrides: Record<string, unknown> = {}) {
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

/**
 * Configure MediaService over a fresh fake client. The spec owns its devicePixelRatio (tests
 * assign it), so the service reads it through this getter.
 */
export function mediaServiceSetup(devicePixelRatio: () => number) {
  return (clientOverrides: Record<string, unknown> = {}) => {
    const client = fakeClient(clientOverrides);

    TestBed.configureTestingModule({
      providers: [
        MediaService,
        { provide: DEVICE_PIXEL_RATIO, useValue: devicePixelRatio },
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: client as unknown as MatrixClientService['instance'],
        }),
      ],
    });
    const svc = TestBed.inject(MediaService);
    return { svc, client };
  };
}

export let fetchMock: Mock;
export let createObjectURL: Mock;
export let revokeObjectURL: Mock;

/** Stub fetch and the object-URL API per test, and reset the module-level mock call logs. */
export function useMediaGlobals(): void {
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
    (withoutMediaMetadata as Mock).mockClear();
    (bytesWithoutMediaMetadata as Mock).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
}
