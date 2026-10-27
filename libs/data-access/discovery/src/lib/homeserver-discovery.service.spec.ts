import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostNetworkPolicyService } from '@trinity/platform-native';
import { EngineRequestError } from '@trinity/util/matrix';
import { FakeDiscoveryEngine } from '../contract/fake-discovery-engine';
import { DISCOVERY_ENGINE } from './discovery-engine';
import { HomeserverDiscoveryService } from './homeserver-discovery.service';

describe('HomeserverDiscoveryService', () => {
  const allowOrigin = vi.fn();
  let engine: FakeDiscoveryEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new FakeDiscoveryEngine();
    TestBed.configureTestingModule({
      providers: [
        HomeserverDiscoveryService,
        { provide: DISCOVERY_ENGINE, useValue: engine },
        MockProvider(HostNetworkPolicyService, { allowOrigin }),
      ],
    });
  });

  const discover = (
    input: string,
    options?: { readonly allowOrigins?: boolean },
  ) =>
    firstValueFrom(
      TestBed.inject(HomeserverDiscoveryService).discover(input, options),
    );

  it('discovers a homeserver base URL', async () => {
    engine.servers.set('example.org', 'https://hs.example');

    await expect(discover('example.org')).resolves.toEqual({
      domain: 'example.org',
      baseUrl: 'https://hs.example',
    });
  });

  it('extracts the domain from an MXID before asking the engine', async () => {
    engine.servers.set('example.org', 'https://example.org');

    const result = await discover('@me:example.org');

    expect(engine.calls).toEqual(['discover:example.org']);
    expect(result.baseUrl).toBe('https://example.org');
  });

  it('fails with the engine failure when no homeserver is found', async () => {
    const error = await discover('nope.invalid').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as Error).message).toBe(
      'Could not discover a homeserver for "nope.invalid".',
    );
  });

  it('allows the probe origin, then the resolved origin, for the host network policy', async () => {
    engine.servers.set('example.org', 'https://matrix.example');

    await discover('example.org');

    expect(allowOrigin.mock.calls).toEqual([
      ['https://example.org'],
      ['https://matrix.example'],
    ]);
  });

  it('allows only the probe origin when discovery fails', async () => {
    await discover('nope.invalid').catch(() => undefined);

    expect(allowOrigin.mock.calls).toEqual([['https://nope.invalid']]);
  });

  it('declares no origins for a lookup that only checks a server', async () => {
    engine.servers.set('example.org', 'https://matrix.example');

    await expect(
      discover('example.org', { allowOrigins: false }),
    ).resolves.toEqual({
      domain: 'example.org',
      baseUrl: 'https://matrix.example',
    });
    expect(allowOrigin).not.toHaveBeenCalled();
  });
});
