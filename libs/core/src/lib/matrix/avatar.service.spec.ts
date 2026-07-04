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
import { AvatarService } from './avatar.service';
import { MatrixClientService } from './matrix-client.service';

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAccessToken: vi.fn(() => 'tok'),
    mxcUrlToHttp: vi.fn(
      (mxc: string, w?: number) =>
        `https://hs/_matrix/media/thumbnail/${mxc.replace('mxc://', '')}${w ? `?w=${w}` : ''}`,
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
      AvatarService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  return { svc: TestBed.inject(AvatarService), client };
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as Response;
}

describe('AvatarService', () => {
  let fetchMock: Mock;
  let createObjectURL: Mock;
  let revokeObjectURL: Mock;
  let origCreate: typeof URL.createObjectURL;
  let origRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    let counter = 0;
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    createObjectURL = vi.fn(() => `blob:av-${++counter}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
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

  it('returns null for a missing avatar without fetching', async () => {
    const { svc } = setup();
    await expect(firstValueFrom(svc.resolve(null))).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches with the access token and resolves a blob URL', async () => {
    const { svc } = setup();

    const url = await firstValueFrom(svc.resolve('mxc://hs/abc'));

    expect(url).toBe('blob:av-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('caches per mxc+size so re-resolving does not refetch', async () => {
    const { svc } = setup();

    const a = await firstValueFrom(svc.resolve('mxc://hs/abc', 64));
    const b = await firstValueFrom(svc.resolve('mxc://hs/abc', 64));

    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to null when the avatar fetch fails', async () => {
    const { svc } = setup();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Response);

    await expect(
      firstValueFrom(svc.resolve('mxc://hs/missing')),
    ).resolves.toBeNull();
  });

  it('falls back to the legacy endpoint (no bearer) when the authed fetch fails', async () => {
    const { svc } = setup();
    // First (authenticated) attempt fails; the legacy retry succeeds — this is
    // what makes always-attempting-authed safe on legacy-only homeservers.
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as unknown as Response)
      .mockResolvedValueOnce(okResponse());

    const url = await firstValueFrom(svc.resolve('mxc://hs/legacy'));

    expect(url).toBe('blob:av-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined(); // legacy, no bearer
  });

  it('does not cache a transient failure — a later resolve retries', async () => {
    // A 502 is transient, so fetchMediaBytes now retries with backoff before the
    // service falls back to null. Drive the timers so the test doesn't wait on
    // real backoff delays.
    vi.useFakeTimers();
    try {
      const { svc } = setup();
      // Both attempts fail this time (offline blip).
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as unknown as Response);
      const pending = firstValueFrom(svc.resolve('mxc://hs/blip'));
      await vi.runAllTimersAsync(); // exhaust the retry backoff
      await expect(pending).resolves.toBeNull();

      // Network recovers; resolving the same avatar must refetch, not replay null.
      fetchMock.mockResolvedValue(okResponse());
      const recovered = firstValueFrom(svc.resolve('mxc://hs/blip'));
      await vi.runAllTimersAsync();
      await expect(recovered).resolves.toBe('blob:av-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releaseAll revokes every cached avatar URL and clears the cache', async () => {
    const { svc } = setup();
    const url = await firstValueFrom(svc.resolve('mxc://hs/abc'));

    svc.releaseAll();
    expect(revokeObjectURL).toHaveBeenCalledWith(url);

    // Cache cleared → the same avatar fetches again.
    await firstValueFrom(svc.resolve('mxc://hs/abc'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
