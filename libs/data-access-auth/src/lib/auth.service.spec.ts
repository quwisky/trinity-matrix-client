import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
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

import { AutoDiscovery, MatrixError, createClient } from 'matrix-js-sdk';
import { AuthService } from './auth.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { AvatarService } from '@trinity/data-access-media';
import { MediaService } from '@trinity/data-access-media';
import { PushService } from '@trinity/data-access-notifications';

const findClientConfig = vi.mocked(AutoDiscovery.findClientConfig);
const createClientMock = vi.mocked(createClient);

function homeserver(state: string, base_url?: string) {
  return { 'm.homeserver': { state, base_url } } as never;
}

/** A user-interactive-auth 401 offering the password stage for `session`. */
function uia(session: string): MatrixError {
  return new MatrixError(
    { flows: [{ stages: ['m.login.password'] }], session },
    401,
  );
}

describe('AuthService', () => {
  let auth: AuthService;
  // MatrixClientService exposes account state as signals (not methods), so provide
  // them as real writable signals the tests drive; the methods are auto-spied.
  let accountIds: WritableSignal<readonly string[]>;
  let activeUserId: WritableSignal<string | null>;

  beforeEach(() => {
    vi.clearAllMocks();
    accountIds = signal<readonly string[]>([]);
    activeUserId = signal<string | null>(null);
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        MockProvider(MatrixClientService, {
          accountIds: accountIds.asReadonly(),
          activeUserId: activeUserId.asReadonly(),
        }),
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

  describe('login modes', () => {
    const loginRes = { user_id: '@me:hs', device_id: 'D', access_token: 'tok' };
    const stubLogin = () =>
      createClientMock.mockReturnValue({
        login: vi.fn().mockResolvedValue(loginRes),
      } as never);

    it('replace login drops prior caches + pusher, then inits', async () => {
      stubLogin();
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      const avatars = TestBed.inject(AvatarService);
      vi.mocked(push.unregister).mockReturnValue(of(undefined));
      vi.mocked(storage.save).mockReturnValue(
        of({
          baseUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'DEV',
          accessToken: 'tok',
        }),
      );
      vi.mocked(matrix.init).mockReturnValue(of(undefined));

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(avatars.releaseAll).toHaveBeenCalled();
      expect(push.unregister).toHaveBeenCalled();
      expect(matrix.init).toHaveBeenCalled();
      expect(matrix.add).not.toHaveBeenCalled();
    });

    it('add login keeps prior caches + pusher and adds alongside', async () => {
      stubLogin();
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      const avatars = TestBed.inject(AvatarService);
      vi.mocked(storage.save).mockReturnValue(
        of({
          baseUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'DEV',
          accessToken: 'tok',
        }),
      );
      vi.mocked(matrix.add).mockReturnValue(of(undefined));
      vi.mocked(push.register).mockReturnValue(of(undefined));

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw', 'add'),
      );

      expect(matrix.add).toHaveBeenCalled();
      expect(matrix.init).not.toHaveBeenCalled();
      expect(avatars.releaseAll).not.toHaveBeenCalled();
      expect(push.unregister).not.toHaveBeenCalled();
      expect(push.register).toHaveBeenCalled(); // pusher for the new account
    });

    it('threads an existing device_id into the login payload only when provided', async () => {
      // A soft-logged-out account is re-authed on its own device so its crypto
      // store is reused; a fresh login must NOT pin a device_id (server issues one).
      const login = vi.fn().mockResolvedValue(loginRes);
      createClientMock.mockReturnValue({ login } as never);
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      vi.mocked(storage.save).mockReturnValue(
        of({
          baseUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'EXISTING_DEV',
          accessToken: 'tok',
        }),
      );
      vi.mocked(matrix.add).mockReturnValue(of(undefined));
      vi.mocked(push.register).mockReturnValue(of(undefined));

      await firstValueFrom(
        auth.loginWithPassword(
          'https://hs',
          '@me:hs',
          'pw',
          'add',
          'EXISTING_DEV',
        ),
      );
      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw', 'add'),
      );

      expect(login).toHaveBeenCalledTimes(2);
      expect(login.mock.calls[0]).toEqual([
        'm.login.password',
        expect.objectContaining({ device_id: 'EXISTING_DEV' }),
      ]);
      expect(login.mock.calls[1][1]).not.toHaveProperty('device_id');
    });
  });

  describe('completeSsoLogin', () => {
    it('exchanges the SSO loginToken and establishes the account additively', async () => {
      const login = vi.fn().mockResolvedValue({
        user_id: '@me:hs',
        device_id: 'DEV',
        access_token: 'tok',
      });
      createClientMock.mockReturnValue({ login } as never);
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      const avatars = TestBed.inject(AvatarService);
      vi.mocked(storage.save).mockReturnValue(
        of({
          baseUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'DEV',
          accessToken: 'tok',
        }),
      );
      vi.mocked(matrix.add).mockReturnValue(of(undefined));
      vi.mocked(push.register).mockReturnValue(of(undefined));

      await firstValueFrom(
        auth.completeSsoLogin('https://hs', 'login-token', 'add', 'DEV'),
      );

      expect(login).toHaveBeenCalledWith(
        'm.login.token',
        expect.objectContaining({ token: 'login-token', device_id: 'DEV' }),
      );
      // Additive path: save → add → register, leaving other accounts intact.
      expect(storage.save).toHaveBeenCalled();
      expect(matrix.add).toHaveBeenCalled();
      expect(push.register).toHaveBeenCalled();
      expect(matrix.init).not.toHaveBeenCalled();
      expect(avatars.releaseAll).not.toHaveBeenCalled();
    });
  });

  describe('switchAccount', () => {
    it('flips the active client + persisted pointer for a live account', async () => {
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      accountIds.set(['@me:hs', '@you:hs']);
      vi.mocked(storage.setActive).mockReturnValue(of(undefined));

      await firstValueFrom(auth.switchAccount('@you:hs'));

      expect(matrix.setActive).toHaveBeenCalledWith('@you:hs');
      expect(storage.setActive).toHaveBeenCalledWith('@you:hs');
      expect(matrix.add).not.toHaveBeenCalled(); // already live → no start
    });

    it('starts an account that is not yet live, then switches', async () => {
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      accountIds.set([]);
      vi.mocked(storage.load).mockReturnValue(
        of({ userId: '@you:hs' }) as never,
      );
      vi.mocked(matrix.add).mockReturnValue(of(undefined));
      vi.mocked(storage.setActive).mockReturnValue(of(undefined));

      await firstValueFrom(auth.switchAccount('@you:hs'));

      expect(matrix.add).toHaveBeenCalled();
      expect(storage.setActive).toHaveBeenCalledWith('@you:hs');
    });
  });

  describe('logout', () => {
    it('signs out one account of several without a full reset', async () => {
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      const client = { logout: vi.fn().mockResolvedValue(undefined) };
      vi.mocked(matrix.clientFor).mockReturnValue(client as never);
      accountIds.set(['@me:hs', '@you:hs']);
      activeUserId.set('@me:hs');
      vi.mocked(matrix.remove).mockReturnValue(of(undefined));
      vi.mocked(storage.remove).mockReturnValue(of(undefined));
      vi.mocked(storage.setActive).mockReturnValue(of(undefined));
      vi.mocked(push.unregister).mockReturnValue(of(undefined));

      await firstValueFrom(auth.logout('@you:hs'));

      expect(push.unregister).toHaveBeenCalledWith('@you:hs'); // just this account
      expect(client.logout).toHaveBeenCalledWith(true);
      expect(matrix.remove).toHaveBeenCalledWith('@you:hs');
      expect(storage.remove).toHaveBeenCalledWith('@you:hs');
      expect(matrix.reset).not.toHaveBeenCalled();
    });

    it('fully resets + clears when the last account signs out', async () => {
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      const client = { logout: vi.fn().mockResolvedValue(undefined) };
      vi.mocked(matrix.clientFor).mockReturnValue(client as never);
      accountIds.set(['@me:hs']);
      activeUserId.set('@me:hs');
      vi.mocked(push.unregister).mockReturnValue(of(undefined));
      vi.mocked(matrix.reset).mockReturnValue(of(undefined));
      vi.mocked(storage.clear).mockReturnValue(of(undefined));

      await firstValueFrom(auth.logout()); // no id → the active (only) account

      expect(matrix.reset).toHaveBeenCalled();
      expect(storage.clear).toHaveBeenCalled();
      expect(matrix.remove).not.toHaveBeenCalled();
    });

    it('completes local teardown even when the server logout rejects (last account)', async () => {
      // A dropped/500 server logout must never strand the user signed in locally —
      // catchError swallows it so push.unregister + reset + clear all still run.
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      const client = {
        logout: vi.fn().mockRejectedValue(new Error('network down')),
      };
      vi.mocked(matrix.clientFor).mockReturnValue(client as never);
      accountIds.set(['@me:hs']);
      activeUserId.set('@me:hs');
      vi.mocked(push.unregister).mockReturnValue(of(undefined));
      vi.mocked(matrix.reset).mockReturnValue(of(undefined));
      vi.mocked(storage.clear).mockReturnValue(of(undefined));

      await expect(firstValueFrom(auth.logout())).resolves.toBeUndefined();

      expect(client.logout).toHaveBeenCalledWith(true);
      expect(push.unregister).toHaveBeenCalled();
      expect(matrix.reset).toHaveBeenCalled();
      expect(storage.clear).toHaveBeenCalled();
    });

    it('treats an empty-string userId as the active account (|| not ??), signing out just it', async () => {
      // The user panel emits '' for a null active id; `||` must fall back to the
      // active account and take the single-account branch, NOT storage.clear() every account.
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const push = TestBed.inject(PushService);
      const client = { logout: vi.fn().mockResolvedValue(undefined) };
      vi.mocked(matrix.clientFor).mockReturnValue(client as never);
      accountIds.set(['@me:hs', '@you:hs']);
      activeUserId.set('@me:hs');
      vi.mocked(matrix.remove).mockReturnValue(of(undefined));
      vi.mocked(storage.remove).mockReturnValue(of(undefined));
      vi.mocked(storage.setActive).mockReturnValue(of(undefined));
      vi.mocked(push.unregister).mockReturnValue(of(undefined));

      await firstValueFrom(auth.logout(''));

      expect(matrix.remove).toHaveBeenCalledWith('@me:hs');
      expect(storage.remove).toHaveBeenCalledWith('@me:hs');
      expect(storage.clear).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    // isInitialized/instance are getters ng-mocks leaves undefined; define them per
    // test so changePassword sees a live client (or, for the guard test, no session).
    function useClient(client: {
      setPassword: unknown;
      getUserId: unknown;
    }): void {
      const matrix = TestBed.inject(MatrixClientService);
      Object.defineProperty(matrix, 'isInitialized', {
        get: () => true,
        configurable: true,
      });
      Object.defineProperty(matrix, 'instance', {
        get: () => client,
        configurable: true,
      });
    }

    it('sets the new password when the server needs no interactive auth', async () => {
      const client = {
        setPassword: vi.fn().mockResolvedValue(undefined),
        getUserId: vi.fn(() => '@me:hs'),
      };
      useClient(client);

      await expect(
        firstValueFrom(auth.changePassword('old-pw', 'new-secret-pw')),
      ).resolves.toBeUndefined();

      // First attempt carries no auth; other sessions stay signed in (false).
      expect(client.setPassword).toHaveBeenCalledWith(
        {},
        'new-secret-pw',
        false,
      );
    });

    it('satisfies the UIA password stage with the current password', async () => {
      const client = {
        setPassword: vi
          .fn()
          .mockRejectedValueOnce(uia('sess-1'))
          .mockResolvedValueOnce(undefined),
        getUserId: vi.fn(() => '@me:hs'),
      };
      useClient(client);

      await expect(
        firstValueFrom(auth.changePassword('old-pw', 'new-secret-pw')),
      ).resolves.toBeUndefined();

      expect(client.setPassword).toHaveBeenCalledTimes(2);
      expect(client.setPassword.mock.calls[1][0]).toMatchObject({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: '@me:hs' },
        password: 'old-pw',
        session: 'sess-1',
      });
    });

    it('surfaces a rejected current password as a clear error', async () => {
      // The server keeps returning 401 (wrong password) — the single attempt is spent,
      // so the UIA helper cancels and we map that to a human message.
      const client = {
        setPassword: vi
          .fn()
          .mockRejectedValueOnce(uia('sess-1'))
          .mockRejectedValueOnce(uia('sess-2')),
        getUserId: vi.fn(() => '@me:hs'),
      };
      useClient(client);

      await expect(
        firstValueFrom(auth.changePassword('wrong-pw', 'new-secret-pw')),
      ).rejects.toThrow('Your current password is incorrect.');
    });

    it('errors without touching the client when not signed in', async () => {
      await expect(
        firstValueFrom(auth.changePassword('old-pw', 'new-secret-pw')),
      ).rejects.toThrow('Not signed in.');
    });
  });
});
