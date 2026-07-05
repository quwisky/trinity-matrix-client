import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub only the two SDK entry points AuthService touches for discovery/SSO,
// keeping every other real export so the sibling core services still load.
vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    AutoDiscovery: { ...actual.AutoDiscovery, findClientConfig: vi.fn() },
    createClient: vi.fn(),
  };
});

import { AutoDiscovery, createClient } from 'matrix-js-sdk';
import { AuthService } from './auth.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { AvatarService } from './avatar.service';
import { MediaService } from './media.service';
import { PushService } from './push.service';

const findClientConfig = vi.mocked(AutoDiscovery.findClientConfig);
const createClientMock = vi.mocked(createClient);

function homeserver(state: string, base_url?: string) {
  return { 'm.homeserver': { state, base_url } } as never;
}

describe('AuthService', () => {
  let auth: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Injected deps aren't exercised by discovery/SSO — mock stubs suffice.
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        MockProvider(MatrixClientService),
        MockProvider(SessionStorageService),
        MockProvider(AvatarService),
        MockProvider(MediaService),
        MockProvider(PushService),
      ],
    });
    auth = TestBed.inject(AuthService);
  });

  describe('discoverHomeserver', () => {
    it('returns the discovered base_url with a trailing slash stripped', async () => {
      findClientConfig.mockResolvedValue(
        homeserver(AutoDiscovery.SUCCESS, 'https://hs.example/'),
      );
      expect(await firstValueFrom(auth.discoverHomeserver('example.org'))).toBe(
        'https://hs.example',
      );
    });

    it('falls back to https://<domain> when discovery yields no base_url', async () => {
      findClientConfig.mockResolvedValue(
        homeserver(AutoDiscovery.SUCCESS, undefined),
      );
      expect(await firstValueFrom(auth.discoverHomeserver('matrix.org'))).toBe(
        'https://matrix.org',
      );
    });

    it('extracts the domain from a full MXID before discovery', async () => {
      findClientConfig.mockResolvedValue(
        homeserver(AutoDiscovery.SUCCESS, 'https://hs'),
      );
      await firstValueFrom(auth.discoverHomeserver('@me:example.org'));
      expect(findClientConfig).toHaveBeenCalledWith('example.org');
    });

    it('throws when discovery fails (FAIL_PROMPT)', async () => {
      findClientConfig.mockResolvedValue(homeserver(AutoDiscovery.FAIL_PROMPT));
      await expect(
        firstValueFrom(auth.discoverHomeserver('nope.invalid')),
      ).rejects.toThrow();
    });
  });

  it('builds the SSO login URL via the SDK', () => {
    const getSsoLoginUrl = vi.fn(() => 'https://hs/_matrix/sso?redirect=cb');
    createClientMock.mockReturnValue({ getSsoLoginUrl } as never);

    expect(auth.getSsoUrl('https://hs', 'cb')).toBe(
      'https://hs/_matrix/sso?redirect=cb',
    );
    expect(getSsoLoginUrl).toHaveBeenCalledWith('cb', 'sso');
  });
});
