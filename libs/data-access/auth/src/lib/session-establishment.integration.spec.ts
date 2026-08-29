import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preferences } = vi.hoisted(() => ({
  preferences: new Map<string, string>(),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: preferences.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      preferences.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      preferences.delete(key);
    },
  },
}));

vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: vi.fn() };
});

import { createClient } from 'matrix-js-sdk';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { PushService } from '@trinity/data-access/notifications';
import {
  DraftStoreService,
  SessionStorageService,
} from '@trinity/platform-native';
import { AuthService } from './auth.service';
import {
  OidcClientService,
  type OidcGrantContext,
} from './oidc-client.service';
import { SessionEstablishmentService } from './session-establishment.service';

const createClientMock = vi.mocked(createClient);

const response = {
  user_id: '@new:hs',
  device_id: 'DEVICE',
  access_token: 'access',
  refresh_token: 'refresh',
};

describe('authentication to Account Runtime integration', () => {
  let service: SessionEstablishmentService;
  let accounts: AccountRuntimeService;
  let matrix: MatrixClientService;
  let storage: SessionStorageService;
  let auth: AuthService;
  let oidc: OidcClientService;

  beforeEach(() => {
    vi.clearAllMocks();
    preferences.clear();
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        SessionEstablishmentService,
        AccountRuntimeService,
        MockProvider(MatrixClientService, {
          activeUserId: signal<string | null>('@old:hs').asReadonly(),
          restorePersisted: vi.fn(() => of({ kind: 'ready' as const })),
          clientFor: vi.fn(() => ({}) as never),
          activateAccount: vi.fn(),
          rollbackAccountStart: vi.fn(() => of(void 0)),
        }),
        SessionStorageService,
        MockProvider(AvatarService, { releaseAll: vi.fn() }),
        MockProvider(MediaService, { releaseAll: vi.fn() }),
        MockProvider(PushService, {
          unregister: vi.fn(() => of(void 0)),
          register: vi.fn(() => of(void 0)),
        }),
        MockProvider(DraftStoreService),
        MockProvider(OidcClientService),
      ],
    });
    auth = TestBed.inject(AuthService);
    service = TestBed.inject(SessionEstablishmentService);
    accounts = TestBed.inject(AccountRuntimeService);
    matrix = TestBed.inject(MatrixClientService);
    storage = TestBed.inject(SessionStorageService);
    oidc = TestBed.inject(OidcClientService);
    vi.spyOn(storage, 'persistForEstablishment');
    vi.spyOn(storage, 'setActiveForEstablishment');
  });

  it('preserves the stored crypto prefix before committing active placement', async () => {
    await firstValueFrom(
      storage.save({
        baseUrl: 'https://hs',
        userId: '@new:hs',
        deviceId: 'DEVICE',
        accessToken: 'old-access',
        cryptoPrefix: 'existing-prefix',
      }),
    );
    await firstValueFrom(
      storage.save({
        baseUrl: 'https://old',
        userId: '@old:hs',
        deviceId: 'OLD',
        accessToken: 'old-active-access',
      }),
    );

    await firstValueFrom(service.establish('https://hs', response, 'replace'));

    expect(storage.persistForEstablishment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '@new:hs',
        accessToken: 'access',
        refreshToken: 'refresh',
      }),
      'upsert',
    );
    expect(matrix.restorePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ cryptoPrefix: 'existing-prefix' }),
      'background',
    );
    expect(storage.setActiveForEstablishment).toHaveBeenCalledWith('@new:hs');
    expect(matrix.activateAccount).toHaveBeenCalledWith('@new:hs', 'replace');
    expect(accounts.state()).toMatchObject({
      phase: 'establishment-settled',
      outcome: { kind: 'ready', accountId: '@new:hs' },
    });
  });

  it('retries an identical registration grant without repeating its new-record write', async () => {
    vi.mocked(matrix.restorePersisted)
      .mockReturnValueOnce(of({ kind: 'failed', failure: 'transient-network' }))
      .mockReturnValueOnce(of({ kind: 'ready' }));

    await expect(
      firstValueFrom(service.establishNew('https://hs', response, 'replace')),
    ).resolves.toMatchObject({ failure: 'transient-network' });
    await expect(
      firstValueFrom(
        service.establishNew('https://hs', { ...response }, 'replace'),
      ),
    ).resolves.toMatchObject({ kind: 'ready' });

    expect(storage.persistForEstablishment).toHaveBeenCalledOnce();
    expect(matrix.restorePersisted).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['password', () => auth.loginWithPassword('https://hs', 'new', 'secret')],
    ['SSO', () => auth.completeSsoLogin('https://hs', 'login-token')],
  ])(
    'routes %s authentication through the facade, Runtime, and production adapter',
    async (_flow, authenticate) => {
      const loginRequest = vi.fn().mockResolvedValue(response);
      createClientMock.mockReturnValue({ loginRequest } as never);

      await expect(firstValueFrom(authenticate())).resolves.toMatchObject({
        kind: 'ready',
        accountId: '@new:hs',
        placement: 'active',
      });

      expect(loginRequest).toHaveBeenCalledOnce();
      expect(storage.persistForEstablishment).toHaveBeenCalledWith(
        expect.objectContaining({ userId: '@new:hs' }),
        'upsert',
      );
      expect(matrix.restorePersisted).toHaveBeenCalledWith(
        expect.objectContaining({
          cryptoPrefix: 'trinity-crypto:@new:hs:DEVICE',
        }),
        'background',
      );
      expect(matrix.activateAccount).toHaveBeenCalledWith('@new:hs', 'replace');
    },
  );

  it('routes OIDC authentication through the facade, Runtime, and production adapter', async () => {
    const context: OidcGrantContext = {
      baseUrl: 'https://hs',
      redirectUri: 'https://app/sso-callback',
      clientId: 'client',
      deviceId: 'DEVICE',
      codeVerifier: 'verifier',
    };
    vi.mocked(oidc.completeGrant).mockReturnValue(
      of({
        homeserverUrl: 'https://hs',
        userId: '@new:hs',
        deviceId: 'DEVICE',
        accessToken: 'access',
        refreshToken: 'refresh',
        oidc: {
          issuer: 'https://op',
          clientId: 'client',
          redirectUri: context.redirectUri,
        },
      }),
    );

    await expect(
      firstValueFrom(auth.completeOidcLogin('code', context)),
    ).resolves.toMatchObject({
      kind: 'ready',
      accountId: '@new:hs',
      placement: 'active',
    });

    expect(oidc.completeGrant).toHaveBeenCalledWith('code', context);
    expect(storage.persistForEstablishment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '@new:hs',
        oidc: expect.objectContaining({ issuer: 'https://op' }),
      }),
      'upsert',
    );
    expect(matrix.restorePersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        cryptoPrefix: 'trinity-crypto:@new:hs:DEVICE',
      }),
      'background',
    );
  });

  it('migrates a legacy persisted session and reuses its SDK-default crypto store through password auth', async () => {
    preferences.set(
      'matrix.session',
      JSON.stringify({
        baseUrl: 'https://hs',
        userId: '@new:hs',
        deviceId: 'DEVICE',
      }),
    );
    preferences.set('secure.matrix.accessToken', 'legacy-secure-access');
    const loginRequest = vi.fn().mockResolvedValue(response);
    createClientMock.mockReturnValue({ loginRequest } as never);

    await expect(
      firstValueFrom(auth.loginWithPassword('https://hs', 'new', 'secret')),
    ).resolves.toMatchObject({ kind: 'ready', accountId: '@new:hs' });

    expect(matrix.restorePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '@new:hs' }),
      'background',
    );
    const [startedSession] = vi.mocked(matrix.restorePersisted).mock.calls[0];
    expect(startedSession).not.toHaveProperty('cryptoPrefix');
    expect(preferences.has('matrix.session')).toBe(false);
    expect(preferences.has('secure.matrix.accessToken')).toBe(false);
    expect(
      JSON.parse(preferences.get('matrix.accounts') ?? '{}'),
    ).toMatchObject({
      activeUserId: '@new:hs',
      accounts: [expect.objectContaining({ userId: '@new:hs' })],
    });
    expect(preferences.get('secure.matrix.accessToken:@new:hs')).toBe('access');
  });
});
