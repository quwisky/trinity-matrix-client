import { Injector } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { JsSdkHomeserverEngine } from './js-sdk-homeserver-engine';

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

function routesFor(host: string) {
  return {
    [`https://${host}/_matrix/federation/v1/version`]: () =>
      ok({ server: { name: 'Synapse', version: '1.1.0' } }),
    [`https://${host}/_matrix/client/versions`]: () =>
      ok({ versions: ['v1.11'], unstable_features: {} }),
    [`https://${host}/_matrix/client/v3/capabilities`]: () =>
      ok({ capabilities: { 'm.room_versions': { default: '10' } } }),
  };
}

function stubFetch(routes: Record<string, () => unknown>) {
  const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) => {
    const handler = routes[String(url)];
    if (!handler) {
      throw new Error(`unexpected fetch to ${String(url)}`);
    }
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const client = (
  host: string,
  token: string | null,
  baseUrl = `https://${host}`,
) => ({
  baseUrl,
  getDomain: () => host,
  getAccessToken: () => token,
});

function engineFor(clients: Record<string, ReturnType<typeof client>>) {
  return Injector.create({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => clients[id] ?? null },
      },
      JsSdkHomeserverEngine,
    ],
  }).get(JsSdkHomeserverEngine);
}

describe('JsSdkHomeserverEngine', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => vi.stubGlobal('fetch', realFetch));

  it('sends each account its own token, to its own host', async () => {
    const fetchMock = stubFetch({
      ...routesFor('one.example'),
      ...routesFor('two.example'),
    });
    const engine = engineFor({
      '@me:one.example': client('one.example', 'tok-one'),
      '@alt:two.example': client('two.example', 'tok-two'),
    });

    await firstValueFrom(engine.probe('@me:one.example'));
    await firstValueFrom(engine.probe('@alt:two.example'));

    const authFor = (host: string) =>
      (fetchMock.mock.calls as [URL, RequestInit][])
        .filter(([url]) =>
          String(url).startsWith(`https://${host}/_matrix/client/`),
        )
        .map(
          ([, init]) =>
            (init.headers as Record<string, string>)['Authorization'],
        );
    expect(authFor('one.example')).toEqual([
      'Bearer tok-one',
      'Bearer tok-one',
    ]);
    expect(authFor('two.example')).toEqual([
      'Bearer tok-two',
      'Bearer tok-two',
    ]);
  });

  it('trims the trailing slash from the base URL', async () => {
    stubFetch(routesFor('one.org'));
    const engine = engineFor({
      '@me:one.org': client('one.org', 'tok', 'https://one.org/'),
    });

    const probe = await firstValueFrom(engine.probe('@me:one.org'));

    expect(probe).toMatchObject({
      baseUrl: 'https://one.org',
      serverName: 'one.org',
      specVersions: ['v1.11'],
      capabilities: { defaultRoomVersion: '10' },
    });
  });

  it('reads the token no earlier than subscribe', async () => {
    stubFetch(routesFor('one.example'));
    const getAccessToken = vi.fn(() => 'tok');
    const engine = engineFor({
      '@me:one.example': { ...client('one.example', 'tok'), getAccessToken },
    });

    const pending = engine.probe('@me:one.example');
    expect(getAccessToken).not.toHaveBeenCalled();
    await firstValueFrom(pending);

    expect(getAccessToken).toHaveBeenCalled();
  });

  it('resolves a null-object probe when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const engine = engineFor({ '@me:one.org': client('one.org', 'tok') });

    await expect(
      firstValueFrom(engine.probe('@me:one.org')),
    ).resolves.toMatchObject({
      software: null,
      specVersions: null,
      capabilities: null,
    });
  });

  it('emits null for an account with no client', async () => {
    await expect(
      firstValueFrom(engineFor({}).probe('@x:y')),
    ).resolves.toBeNull();
  });
});
