import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
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
import { MatrixClientService } from '@trinity/data-access-matrix-client';

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
  TestBed.configureTestingModule({
    providers: [AvatarService, MockProvider(MatrixClientService)],
  });
  const matrix = TestBed.inject(MatrixClientService);
  // `instance` is a getter that would throw before init; stub it to the fake
  // matrix-js-sdk client the service reaches through (never a real SDK object).
  ngMocks.stubMember(matrix, 'instance', client as never);
  ngMocks.stubMember(matrix, 'isInitialized', true);
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

  it('does not cache a transient failure for good — a later resolve retries', async () => {
    // A 502 is transient, so fetchMediaBytes retries with backoff before the service
    // falls back to null. Drive the timers so the test doesn't wait on real delays.
    vi.useFakeTimers();
    try {
      const { svc } = setup();
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as unknown as Response);
      const pending = firstValueFrom(svc.resolve('mxc://hs/blip'));
      await vi.runAllTimersAsync(); // exhaust the retry backoff
      await expect(pending).resolves.toBeNull();

      // Network recovers. Past the cooldown the avatar must refetch, not replay null —
      // a failure is never allowed to pin someone to initials for the whole session.
      fetchMock.mockResolvedValue(okResponse());
      await vi.advanceTimersByTimeAsync(30_000);
      const recovered = firstValueFrom(svc.resolve('mxc://hs/blip'));
      await vi.runAllTimersAsync();
      await expect(recovered).resolves.toBe('blob:av-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-attempt a failed avatar until its cooldown expires', async () => {
    // Rows are recreated constantly as a list scrolls, and each recreation re-resolves.
    // Without a cooldown every one of those starts a fresh multi-request retry — which,
    // offline, is a stampede against a network that is not there.
    vi.useFakeTimers();
    try {
      const { svc } = setup();
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      const first = firstValueFrom(svc.resolve('mxc://hs/offline'));
      await vi.runAllTimersAsync();
      await expect(first).resolves.toBeNull();
      const afterFirst = fetchMock.mock.calls.length;
      expect(afterFirst).toBe(4); // 1 initial + 3 retries

      // Five more rows ask for the same avatar while still offline. Subscribed rather
      // than awaited: a cooled-down key answers synchronously, while a regression would
      // start a fetch on subscribe — so this asserts in both directions without hanging
      // on a promise that a regression would never settle.
      const seen: (string | null)[] = [];
      for (let i = 0; i < 5; i++) {
        svc.resolve('mxc://hs/offline').subscribe((url) => seen.push(url));
      }

      expect(fetchMock.mock.calls.length).toBe(afterFirst); // not one extra request
      expect(seen).toEqual([null, null, null, null, null]); // and each got its initial
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

// In the mixed-account view a row can belong to a signed-in account that isn't active.
// Resolving its media through the ACTIVE client would ask one homeserver for another
// identity's media — leaking the association, and failing outright where the two servers
// don't federate media to each other.
describe('AvatarService per-account resolution', () => {
  function setupAccounts() {
    const activeClient = fakeClient();
    const ownerClient = fakeClient({
      mxcUrlToHttp: vi.fn(
        (mxc: string) => `https://owner/${mxc.replace('mxc://', '')}`,
      ),
    });
    TestBed.configureTestingModule({
      providers: [AvatarService, MockProvider(MatrixClientService)],
    });
    const matrix = TestBed.inject(MatrixClientService);
    ngMocks.stubMember(matrix, 'instance', activeClient as never);
    ngMocks.stubMember(matrix, 'isInitialized', true);
    ngMocks.stubMember(
      matrix,
      'clientFor',
      vi.fn((id: string) =>
        id === '@owner:hs' ? (ownerClient as never) : null,
      ),
    );
    return { svc: TestBed.inject(AvatarService), activeClient, ownerClient };
  }

  it('fetches through the owning account’s client, not the active one', async () => {
    const { svc, activeClient, ownerClient } = setupAccounts();

    await firstValueFrom(svc.resolve('mxc://hs/a', 40, '@owner:hs'));

    expect(ownerClient.mxcUrlToHttp).toHaveBeenCalled();
    expect(activeClient.mxcUrlToHttp).not.toHaveBeenCalled();
  });

  it('still uses the active client when no account is named', async () => {
    const { svc, activeClient, ownerClient } = setupAccounts();

    await firstValueFrom(svc.resolve('mxc://hs/a', 40));

    expect(activeClient.mxcUrlToHttp).toHaveBeenCalled();
    expect(ownerClient.mxcUrlToHttp).not.toHaveBeenCalled();
  });

  // The same mxc through a different homeserver is a different request, so it must not
  // share a cache entry — that would defeat the routing above.
  it('caches per account rather than by mxc alone', async () => {
    const { svc, activeClient, ownerClient } = setupAccounts();

    await firstValueFrom(svc.resolve('mxc://hs/a', 40, '@owner:hs'));
    await firstValueFrom(svc.resolve('mxc://hs/a', 40));

    expect(ownerClient.mxcUrlToHttp).toHaveBeenCalled();
    expect(activeClient.mxcUrlToHttp).toHaveBeenCalled();
  });

  it('falls back to the active client when the named account has none', async () => {
    const { svc, activeClient } = setupAccounts();

    await firstValueFrom(svc.resolve('mxc://hs/a', 40, '@gone:hs'));

    expect(activeClient.mxcUrlToHttp).toHaveBeenCalled();
  });
});
