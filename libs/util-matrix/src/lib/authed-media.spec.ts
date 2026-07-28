import { ConnectionError, HTTPError, type MatrixClient } from 'matrix-js-sdk';
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
import { fetchMediaBytes, mediaHttpUrl } from './authed-media';

/**
 * A client whose `mxcUrlToHttp` reports which endpoint it was asked for, so a test can
 * assert not just how many requests were made but *which* — the authenticated one being
 * re-issued is the whole point of several of these.
 */
function fakeClient(overrides: Record<string, unknown> = {}): MatrixClient {
  return {
    getAccessToken: vi.fn(() => 'tok'),
    mxcUrlToHttp: vi.fn(
      (
        mxc: string,
        _w?: number,
        _h?: number,
        _method?: string,
        _allowDirect?: boolean,
        _allowRedirects?: boolean,
        useAuthentication?: boolean,
      ) => `https://hs/${useAuthentication ? 'authed' : 'legacy'}/${mxc}`,
    ),
    ...overrides,
  } as unknown as MatrixClient;
}

const response = (status: number): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  }) as unknown as Response;

/** Which endpoint each recorded `fetch` call went to. */
const endpointsOf = (mock: Mock): string[] =>
  mock.mock.calls.map((call) =>
    String(call[0]).includes('/authed/') ? 'authed' : 'legacy',
  );

describe('mediaHttpUrl', () => {
  it('throws when the client cannot resolve the mxc', () => {
    const client = fakeClient({ mxcUrlToHttp: vi.fn(() => null) });

    expect(() => mediaHttpUrl(client, 'mxc://hs/x', null, true)).toThrow(
      'Could not resolve media URL',
    );
  });
});

describe('fetchMediaBytes', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends the bearer token to the authenticated endpoint', async () => {
    fetchMock.mockResolvedValue(response(200));

    await firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    );

    expect(endpointsOf(fetchMock)).toEqual(['authed']);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('falls back to the legacy endpoint when authenticated media is unsupported', async () => {
    // The case the fallback exists for: a server that advertises v1.11 but answers the
    // authenticated route with M_UNRECOGNIZED.
    fetchMock
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200));

    await firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    );

    expect(endpointsOf(fetchMock)).toEqual(['authed', 'legacy']);
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined(); // legacy carries no bearer
  });

  it('re-issues the AUTHENTICATED request on a transient failure', async () => {
    // The regression this guards: building the request eagerly (`from(fetch(...))`)
    // instead of inside a `defer` reads identically but makes the retry a no-op —
    // re-subscribing to a settled promise replays it, so the server is asked once.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(response(503));

    const settled = firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    ).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await settled).toBeInstanceOf(HTTPError);
    expect(endpointsOf(fetchMock)).toEqual([
      'authed', // 1 initial…
      'authed', // …+ 3 retries, every one of them a real request
      'authed',
      'authed',
    ]);
  });

  it('does not fall back to legacy on a transient status', async () => {
    // Falling back here is what turned a retryable 503 into a terminal 404 on a
    // homeserver that has disabled legacy media (Synapse's default since 1.120).
    vi.useFakeTimers();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(response(String(url).includes('/authed/') ? 503 : 404)),
    );

    const settled = firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    ).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const error = await settled;
    expect(endpointsOf(fetchMock)).not.toContain('legacy');
    // The status that surfaces is the server's own, not one manufactured by a
    // fallback the server never asked for.
    expect((error as HTTPError).httpStatus).toBe(503);
  });

  it('recovers when a transient failure clears within the retry budget', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(response(502))
      .mockResolvedValueOnce(response(200));

    const bytes = firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    );
    await vi.runAllTimersAsync();

    await expect(bytes).resolves.toBeInstanceOf(ArrayBuffer);
    expect(endpointsOf(fetchMock)).toEqual(['authed', 'authed']);
  });

  it('retries a rejected fetch — an offline blip is not a terminal answer', async () => {
    // `fetch` rejects with a bare TypeError when the network is down, which carries no
    // status for retryTransient to read; it is re-tagged as the SDK's ConnectionError.
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const settled = firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    ).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await settled).toBeInstanceOf(ConnectionError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('retries when the body read fails after the headers arrived', async () => {
    // The connection dropping mid-stream rejects `arrayBuffer()`, not `fetch()`, so this
    // failure enters the pipeline a step later than the one above — and as the same
    // status-less TypeError.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.reject(new TypeError('network error')),
    } as unknown as Response);

    const settled = firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    ).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await settled).toBeInstanceOf(ConnectionError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it.each([405, 501])(
    'falls back to legacy when a proxy answers the v1 path with %i',
    async (status) => {
      // A gateway that does not route `/_matrix/client/v1/media/download` reports the
      // endpoint as missing without using 404, and legacy serves the media perfectly.
      fetchMock
        .mockResolvedValueOnce(response(status))
        .mockResolvedValueOnce(response(200));

      await firstValueFrom(
        fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
      );

      expect(endpointsOf(fetchMock)).toEqual(['authed', 'legacy']);
    },
  );

  it('gives up immediately on a genuine client error', async () => {
    fetchMock.mockResolvedValue(response(403));

    const settled = await firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, true),
    ).catch((e: unknown) => e);

    expect((settled as HTTPError).httpStatus).toBe(403);
    expect(endpointsOf(fetchMock)).toEqual(['authed']); // no retry, no fallback
  });

  it('goes straight to the legacy endpoint when the caller says the server is legacy', async () => {
    fetchMock.mockResolvedValue(response(404));

    await firstValueFrom(
      fetchMediaBytes(fakeClient(), 'mxc://hs/a', null, false),
    ).catch(() => undefined);

    // authed=false means the probe already said so: one request, and no fallback loop.
    expect(endpointsOf(fetchMock)).toEqual(['legacy']);
  });

  it('uses the legacy endpoint when the client has no access token', async () => {
    fetchMock.mockResolvedValue(response(200));
    const client = fakeClient({ getAccessToken: vi.fn(() => null) });

    await firstValueFrom(fetchMediaBytes(client, 'mxc://hs/a', null, true));

    expect(endpointsOf(fetchMock)).toEqual(['legacy']);
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });

  it('surfaces an unresolvable mxc as an error rather than throwing at the caller', async () => {
    // Built inside the `defer`, so a subscriber's error handler sees it; thrown while
    // assembling the pipeline it would escape past every downstream catchError.
    const client = fakeClient({ mxcUrlToHttp: vi.fn(() => null) });

    const build = () => fetchMediaBytes(client, 'mxc://hs/a', null, true);

    expect(build).not.toThrow();
    await expect(firstValueFrom(build())).rejects.toThrow(
      'Could not resolve media URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
