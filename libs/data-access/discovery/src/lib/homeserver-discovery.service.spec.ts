import { TestBed } from '@angular/core/testing';
import { AutoDiscovery } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostNetworkPolicyService } from '@trinity/platform-native';
import { HomeserverDiscoveryService } from './homeserver-discovery.service';

vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    AutoDiscovery: { ...actual.AutoDiscovery, findClientConfig: vi.fn() },
  };
});

const findClientConfig = vi.mocked(AutoDiscovery.findClientConfig);

function homeserver(state: string, base_url?: string) {
  return { 'm.homeserver': { state, base_url } } as never;
}

describe('HomeserverDiscoveryService', () => {
  const allowOrigin = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        HomeserverDiscoveryService,
        MockProvider(HostNetworkPolicyService, { allowOrigin }),
      ],
    });
  });

  it('discovers and normalizes a homeserver base URL', async () => {
    findClientConfig.mockResolvedValue(
      homeserver(AutoDiscovery.SUCCESS, 'https://hs.example/'),
    );

    await expect(
      firstValueFrom(
        TestBed.inject(HomeserverDiscoveryService).discover('example.org'),
      ),
    ).resolves.toEqual({
      domain: 'example.org',
      baseUrl: 'https://hs.example',
    });
  });

  it('falls back to the entered domain and extracts a domain from an MXID', async () => {
    findClientConfig.mockResolvedValue(
      homeserver(AutoDiscovery.SUCCESS, undefined),
    );

    const result = await firstValueFrom(
      TestBed.inject(HomeserverDiscoveryService).discover('@me:example.org'),
    );

    expect(findClientConfig).toHaveBeenCalledWith('example.org');
    expect(result.baseUrl).toBe('https://example.org');
  });

  it('fails when the SDK cannot discover a homeserver', async () => {
    findClientConfig.mockResolvedValue(homeserver(AutoDiscovery.FAIL_PROMPT));

    await expect(
      firstValueFrom(
        TestBed.inject(HomeserverDiscoveryService).discover('nope.invalid'),
      ),
    ).rejects.toThrow(/Could not discover/);
  });

  it('allows both the probe and resolved origins for the host network policy', async () => {
    findClientConfig.mockResolvedValue(
      homeserver(AutoDiscovery.SUCCESS, 'https://matrix.example/'),
    );

    await firstValueFrom(
      TestBed.inject(HomeserverDiscoveryService).discover('example.org'),
    );

    expect(allowOrigin).toHaveBeenCalledWith('https://example.org');
    expect(allowOrigin).toHaveBeenCalledWith('https://matrix.example');
  });
});
