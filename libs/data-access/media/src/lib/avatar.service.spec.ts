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
import { MatrixClientService } from '@trinity/data-access/matrix-client';

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
  ngMocks.stubMember(matrix, 'clientFor', () => client as never);
  return { svc: TestBed.inject(AvatarService), client };
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as Response;
}

/** Mirrors the (non-exported) AVATAR_CACHE_LIMIT in avatar.service.ts. */
const CACHE_LIMIT = 256;

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

  it('uploads avatar bytes through the owning Account media client', async () => {
    const uploadContent = vi
      .fn()
      .mockResolvedValue({ content_uri: 'mxc://hs/new' });
    const { svc } = setup({ uploadContent });
    const file = new File([new Uint8Array([1])], 'me.png', {
      type: 'image/png',
    });

    await expect(firstValueFrom(svc.upload(file, '@me:hs'))).resolves.toBe(
      'mxc://hs/new',
    );
    expect(uploadContent).toHaveBeenCalledWith(file, {
      name: 'me.png',
      type: 'image/png',
    });
  });

  it('keeps avatar upload cold until subscribed', () => {
    const uploadContent = vi.fn().mockResolvedValue({
      content_uri: 'mxc://hs/new',
    });
    const { svc } = setup({ uploadContent });

    svc.upload(new File([], 'me.png'), '@me:hs');

    expect(uploadContent).not.toHaveBeenCalled();
  });

  it('fetches with the access token and resolves a blob URL', async () => {
    const { svc } = setup();

    const url = await firstValueFrom(svc.resolve('mxc://hs/abc'));

    expect(url).toBe('blob:av-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('binds avatar bytes as an opaque blob rather than an untyped one', async () => {
    const { svc } = setup();

    await firstValueFrom(svc.resolve('mxc://hs/abc'));

    const bound = createObjectURL.mock.calls[0][0] as Blob;
    expect(bound.type).toBe('application/octet-stream');
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

  describe('bounded cache', () => {
    async function fill(svc: AvatarService, count: number, from = 0) {
      const urls: string[] = [];
      for (let i = from; i < from + count; i++) {
        urls.push((await firstValueFrom(svc.resolve(`mxc://hs/${i}`)))!);
      }
      return urls;
    }

    it('revokes the least recently used URL once the cap is exceeded', async () => {
      const { svc } = setup();
      const urls = await fill(svc, CACHE_LIMIT + 1);

      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith(urls[0]);
    });

    it('evicts in recency order: a re-resolved key outlives an older one', async () => {
      const { svc } = setup();
      const urls = await fill(svc, CACHE_LIMIT);
      await firstValueFrom(svc.resolve('mxc://hs/0')); // touch the oldest
      await fill(svc, 1, CACHE_LIMIT);

      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith(urls[1]);
    });

    it('never revokes a URL a live subscriber is still showing', async () => {
      const { svc } = setup();
      const shown: (string | null)[] = [];
      const sub = svc.resolve('mxc://hs/0').subscribe((u) => shown.push(u));
      await new Promise((r) => setTimeout(r));
      await fill(svc, CACHE_LIMIT + 5, 1);

      expect(revokeObjectURL).not.toHaveBeenCalledWith(shown[0]);

      // Once the row is gone the URL becomes evictable again.
      sub.unsubscribe();
      await fill(svc, 1, CACHE_LIMIT + 10);
      expect(revokeObjectURL).toHaveBeenCalledWith(shown[0]);
    });

    it('re-resolves an evicted key with a fresh fetch and URL', async () => {
      const { svc } = setup();
      const urls = await fill(svc, CACHE_LIMIT + 1);
      fetchMock.mockClear();

      const again = await firstValueFrom(svc.resolve('mxc://hs/0'));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(again).not.toBe(urls[0]);
    });
  });

  describe('fetches that land after releaseAll', () => {
    /** A fetch the test settles by hand. */
    function deferFetch(): { ok: () => void } {
      let settle!: (r: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
      return { ok: () => settle(okResponse()) };
    }
    const tick = () => new Promise((r) => setTimeout(r));

    it('does not create an object URL nobody can revoke', async () => {
      const { svc } = setup();
      const late = deferFetch();
      const seen: (string | null)[] = [];
      svc.resolve('mxc://hs/slow').subscribe((u) => seen.push(u));
      svc.releaseAll();

      late.ok();
      await tick();

      expect(createObjectURL).not.toHaveBeenCalled();
      expect(seen).toEqual([null]);
    });

    it('does not let a late failure delete or cool down the newer entry', async () => {
      const { svc } = setup();
      vi.useFakeTimers();
      try {
        // Call 1 (the stale fetch) hangs until failed by hand, call 2 (the fresh entry)
        // succeeds, and every retry the stale fetch makes after that fails too.
        let calls = 0;
        let failFirst!: () => void;
        fetchMock.mockImplementation(() => {
          calls++;
          if (calls === 1) {
            return new Promise((_, reject) => {
              failFirst = () => reject(new TypeError('Failed to fetch'));
            });
          }
          return calls === 2
            ? Promise.resolve(okResponse())
            : Promise.reject(new TypeError('Failed to fetch'));
        });
        svc.resolve('mxc://hs/slow').subscribe();
        svc.releaseAll();
        // Re-resolve in between: a new entry for the same key.
        const fresh: (string | null)[] = [];
        svc.resolve('mxc://hs/slow').subscribe((u) => fresh.push(u));
        await vi.advanceTimersByTimeAsync(10);
        expect(fresh).toEqual(['blob:av-1']);

        failFirst();
        await vi.runAllTimersAsync();

        // Still cached (no refetch) and not cooling down.
        fetchMock.mockClear();
        const again: (string | null)[] = [];
        svc.resolve('mxc://hs/slow').subscribe((u) => again.push(u));
        await vi.advanceTimersByTimeAsync(10);
        expect(again).toEqual(['blob:av-1']);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
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

  it('releaseUnpinned revokes only avatars no subscriber is showing', async () => {
    const { svc } = setup();
    let shownUrl: string | null = null;
    const shown = svc.resolve('mxc://hs/shown').subscribe((url) => {
      shownUrl = url;
    });
    await vi.waitFor(() => expect(shownUrl).not.toBeNull());
    const unused = await firstValueFrom(svc.resolve('mxc://hs/unused'));
    fetchMock.mockClear();

    svc.releaseUnpinned();

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(unused);
    // The held avatar is still cached; the released one fetches again.
    await expect(firstValueFrom(svc.resolve('mxc://hs/shown'))).resolves.toBe(
      shownUrl,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await firstValueFrom(svc.resolve('mxc://hs/unused'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    shown.unsubscribe();
  });
});

// In the mixed-account view a row can belong to a signed-in account that isn't active.
// Resolving its media through the ACTIVE client would ask one homeserver for another
// identity's media — leaking the association, and failing outright where the two servers
// don't federate media to each other.
describe('AvatarService per-account resolution', () => {
  // Stub the network like the block above: without it, resolve() really fetches
  // `https://owner/…`, which only passes where that host fails to resolve quickly.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
