import { Injector } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AutoDiscovery } from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { JsSdkDiscoveryEngine } from './js-sdk-discovery-engine';

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

describe('JsSdkDiscoveryEngine retries (#978)', () => {
  const fetchMock = vi.fn();
  let engine: JsSdkDiscoveryEngine;
  const wellKnownCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === WELL_KNOWN).length;

  function discover() {
    const result = firstValueFrom(engine.discover('example.org'));
    // Attach a handler now so a rejection during timer advancement is never unhandled.
    result.catch(() => undefined);
    return result;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    engine = Injector.create({
      providers: [
        { provide: JS_SDK_CLIENTS, useValue: { clientFor: () => null } },
        JsSdkDiscoveryEngine,
      ],
    }).get(JsSdkDiscoveryEngine);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries a first attempt that times out and then succeeds', async () => {
    fetchMock
      .mockImplementationOnce(hang)
      .mockImplementationOnce(async () => wellKnownOk())
      .mockImplementationOnce(async () => versionsOk());

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toEqual({
      ok: true,
      value: { domain: 'example.org', baseUrl: 'https://hs.example' },
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
      ok: true,
      value: { baseUrl: 'https://hs.example' },
    });
    expect(wellKnownCalls()).toBe(2);
  });

  it('keeps the existing error once the retries are exhausted', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toMatchObject({
      ok: false,
      failure: {
        code: 'discovery-failed',
        params: { domain: 'example.org', reason: 'invalid' },
      },
    });
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

    await result;
    expect(wellKnownCalls()).toBe(1);
  });

  it('does not retry a host that answers but is not a Matrix server', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url) === WELL_KNOWN ? wellKnownOk() : json({}, 404),
    );

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a response whose body stalls after the headers', async () => {
    const stalledBody = (_url: unknown, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start: (controller) =>
            init?.signal?.addEventListener('abort', () =>
              controller.error(init.signal?.reason),
            ),
        }),
        { status: 200 },
      );
    fetchMock
      .mockImplementationOnce(async (url, init) => stalledBody(url, init))
      .mockImplementationOnce(async () => wellKnownOk())
      .mockImplementationOnce(async () => versionsOk());

    const result = discover();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toMatchObject({
      ok: true,
      value: { baseUrl: 'https://hs.example' },
    });
    expect(wellKnownCalls()).toBe(2);
  });

  it('gives the first attempt more than the SDK 5 s budget', async () => {
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(wellKnownOk()), 6_000),
          ),
      )
      .mockImplementationOnce(async () => versionsOk());

    const result = discover();
    await vi.advanceTimersByTimeAsync(7_000);

    await expect(result).resolves.toMatchObject({
      ok: true,
      value: { baseUrl: 'https://hs.example' },
    });
    expect(wellKnownCalls()).toBe(1);
  });

  it('does not retry, or wait for, a dead identity server', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href === WELL_KNOWN) {
        return json({
          'm.homeserver': { base_url: 'https://hs.example' },
          'm.identity_server': { base_url: 'https://id.example' },
        });
      }
      if (href.startsWith('https://id.example')) {
        throw new TypeError('Load failed');
      }
      return versionsOk();
    });

    const result = discover();
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toMatchObject({
      ok: true,
      value: { baseUrl: 'https://hs.example' },
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith('https://id.example'),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['Invalid JSON', { reason: 'invalid-json' }],
    ['a value from a newer SDK', {}],
  ])('maps the SDK discovery error %s to a reason', async (error, reason) => {
    vi.spyOn(AutoDiscovery, 'findClientConfig').mockResolvedValue({
      'm.homeserver': {
        state: AutoDiscovery.FAIL_ERROR,
        error,
        base_url: null,
      },
    } as never);

    await expect(
      firstValueFrom(engine.discover('example.org')),
    ).resolves.toMatchObject({
      ok: false,
      failure: {
        code: 'discovery-failed',
        params: { domain: 'example.org', ...reason },
      },
    });
  });

  it('reports an unclassified thrown error as a message-free request failure', async () => {
    vi.spyOn(AutoDiscovery, 'findClientConfig').mockRejectedValue(
      new Error('boom'),
    );

    const result = await firstValueFrom(engine.discover('example.org'));

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'unexpected', code: 'request-failed' },
    });
    expect(result).not.toHaveProperty('failure.message');
  });
});
