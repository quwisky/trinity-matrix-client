import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostNetworkPolicyService } from '@trinity/platform-native';
import { HomeserverDiscoveryService } from './homeserver-discovery.service';

// Runs the real SDK `AutoDiscovery` against a stubbed `fetch`, because the SDK swallows every
// fetch failure into the same FAIL_PROMPT a definitive negative produces (#978).
const WELL_KNOWN = 'https://example.org/.well-known/matrix/client';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const wellKnownOk = () =>
  json({ 'm.homeserver': { base_url: 'https://hs.example' } });
const versionsOk = () => json({ versions: ['v1.1', 'v1.5', 'v1.11'] });
const hang = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

describe('HomeserverDiscoveryService retries (#978)', () => {
  const fetchMock = vi.fn();
  const wellKnownCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === WELL_KNOWN).length;

  function discover() {
    const result = firstValueFrom(
      TestBed.inject(HomeserverDiscoveryService).discover('example.org'),
    );
    // Attach a handler now so a rejection during timer advancement is never unhandled.
    result.catch(() => undefined);
    return result;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [
        HomeserverDiscoveryService,
        MockProvider(HostNetworkPolicyService, { allowOrigin: vi.fn() }),
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries a first attempt that times out and then succeeds', async () => {
    fetchMock
      .mockImplementationOnce(hang)
      .mockImplementationOnce(async () => wellKnownOk())
      .mockImplementationOnce(async () => versionsOk());

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toEqual({
      domain: 'example.org',
      baseUrl: 'https://hs.example',
    });
    expect(wellKnownCalls()).toBe(2);
  });

  it('retries a network error and then succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockImplementationOnce(async () => wellKnownOk())
      .mockImplementationOnce(async () => versionsOk());

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toMatchObject({
      baseUrl: 'https://hs.example',
    });
    expect(wellKnownCalls()).toBe(2);
  });

  it('keeps the existing error once the retries are exhausted', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).rejects.toThrow(/invalid/i);
    expect(wellKnownCalls()).toBe(3);
  });

  it.each([
    ['a missing well-known (404)', () => json({}, 404)],
    ['a server error (500)', () => json({}, 500)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
  ])('does not retry %s', async (_name, response) => {
    fetchMock.mockImplementation(async () => response());

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await result.catch(() => undefined);
    expect(wellKnownCalls()).toBe(1);
  });

  it('does not retry a host that answers but is not a Matrix server', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url) === WELL_KNOWN ? wellKnownOk() : json({}, 404),
    );

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
