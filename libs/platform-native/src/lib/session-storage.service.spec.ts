import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStorageService } from './session-storage.service';
import { SecureStorageService } from './secure-storage.service';
import { MatrixSession } from '@trinity/util/matrix';

// In-memory @capacitor/preferences (hoisted so the vi.mock factory can see it).
const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, string>() }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key);
    },
  },
}));

// Login-shaped sessions (no crypto prefix yet — storage assigns one).
const ALICE: MatrixSession = {
  baseUrl: 'https://hs',
  userId: '@alice:hs',
  deviceId: 'DEV1',
  accessToken: 'alice-token-xyz',
};
const BOB: MatrixSession = {
  baseUrl: 'https://other',
  userId: '@bob:other',
  deviceId: 'DEV2',
  accessToken: 'bob-token-abc',
};
// How each looks once stored: a per-account, per-device crypto store is assigned on
// first save (device id in the prefix so a new-device login never reopens an old store).
const ALICE_STORED: MatrixSession = {
  ...ALICE,
  cryptoPrefix: 'trinity-crypto:@alice:hs:DEV1',
};
const BOB_STORED: MatrixSession = {
  ...BOB,
  cryptoPrefix: 'trinity-crypto:@bob:other:DEV2',
};

// An OIDC-native ("next-gen auth") session: a refresh token + expiry + provider binding.
const OIDC_BINDING = {
  issuer: 'https://op.hs',
  clientId: 'client-abc',
  redirectUri: 'https://app/sso-callback',
  idTokenClaims: {
    iss: 'https://op.hs',
    sub: 'subject-123',
    aud: 'client-abc',
    exp: 2000000000,
    iat: 1000000000,
  },
};
const CAROL: MatrixSession = {
  baseUrl: 'https://hs',
  userId: '@carol:hs',
  deviceId: 'DEVC',
  accessToken: 'carol-access',
  refreshToken: 'carol-refresh',
  accessTokenExpiresAt: 1234567890,
  oidc: OIDC_BINDING,
};

/**
 * Provide the real {@link SessionStorageService} with a mocked
 * {@link SecureStorageService}. ng-mocks' auto-spies are backed by an in-memory map
 * so the keychain stand-in round-trips like the real thing; `secure.store` exposes
 * that map for assertions.
 */
function setup() {
  const store = new Map<string, string>();
  TestBed.configureTestingModule({
    providers: [SessionStorageService, MockProvider(SecureStorageService)],
  });
  const secure = TestBed.inject(SecureStorageService);
  vi.mocked(secure.get).mockImplementation(
    async (key) => store.get(key) ?? null,
  );
  vi.mocked(secure.set).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(secure.remove).mockImplementation(async (key) => {
    store.delete(key);
  });
  return { svc: TestBed.inject(SessionStorageService), secure: { store } };
}

describe('SessionStorageService', () => {
  beforeEach(() => prefs.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the token out of Preferences (secure, per-account) and records the account', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(ALICE));

    // Token lives in secure storage under a per-account key, never in Preferences.
    expect(secure.store.get('matrix.accessToken:@alice:hs')).toBe(
      'alice-token-xyz',
    );
    const registry = prefs.get('matrix.accounts') ?? '';
    expect(registry).not.toContain('alice-token-xyz');
    expect(JSON.parse(registry)).toEqual({
      activeUserId: '@alice:hs',
      accounts: [
        {
          baseUrl: 'https://hs',
          userId: '@alice:hs',
          deviceId: 'DEV1',
          cryptoPrefix: 'trinity-crypto:@alice:hs:DEV1',
        },
      ],
    });
  });

  it('round-trips save → load (active account)', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE));
    expect(await firstValueFrom(svc.load())).toEqual(ALICE_STORED);
  });

  it('returns the stored session (with its resolved crypto prefix) from save', async () => {
    const { svc } = setup();
    // The caller starts the client with this, so it must carry the freshly-assigned
    // prefix — not the SDK default, which would collide with another account's store.
    expect(await firstValueFrom(svc.save(ALICE))).toEqual(ALICE_STORED);
  });

  it('returns null when nothing is stored', async () => {
    const { svc } = setup();
    expect(await firstValueFrom(svc.load())).toBeNull();
  });

  it('assigns a fresh account a device-scoped crypto store', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE));
    const [record] = await firstValueFrom(svc.list());
    // Device id in the prefix: a later fresh login (new device) gets a fresh store
    // instead of reopening this one and hitting the Rust account/device mismatch.
    expect(record.cryptoPrefix).toBe('trinity-crypto:@alice:hs:DEV1');
  });

  it('gives two accounts DISTINCT crypto stores (no cross-account key collision)', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save(BOB));

    const prefixes = (await firstValueFrom(svc.list())).map(
      (a) => a.cryptoPrefix,
    );
    expect(prefixes).toEqual([
      'trinity-crypto:@alice:hs:DEV1',
      'trinity-crypto:@bob:other:DEV2',
    ]);
    // The invariant a future refactor is most likely to break: never a shared store.
    expect(new Set(prefixes).size).toBe(2);
  });

  it('record() returns a stored account by id without needing its token', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE));
    // Drop the token (soft-logout) — record() must still resolve the account.
    await firstValueFrom(svc.invalidateToken('@alice:hs'));

    expect(await firstValueFrom(svc.record('@alice:hs'))).toMatchObject({
      userId: '@alice:hs',
      baseUrl: 'https://hs',
      deviceId: 'DEV1',
      cryptoPrefix: 'trinity-crypto:@alice:hs:DEV1',
    });
    expect(await firstValueFrom(svc.record('@nobody:hs'))).toBeNull();
  });

  it('invalidateToken drops the token but keeps the record (re-auth on same store)', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(ALICE));

    await firstValueFrom(svc.invalidateToken('@alice:hs'));

    // Token gone → load() treats it as absent, so a restart skips the dead account…
    expect(secure.store.has('matrix.accessToken:@alice:hs')).toBe(false);
    expect(await firstValueFrom(svc.load('@alice:hs'))).toBeNull();
    // …but the record (with its crypto prefix) survives for re-authentication.
    const [record] = await firstValueFrom(svc.list());
    expect(record).toMatchObject({
      userId: '@alice:hs',
      cryptoPrefix: 'trinity-crypto:@alice:hs:DEV1',
    });
  });

  describe('OIDC token persistence', () => {
    it('stores the refresh token securely (never Preferences) and keeps expiry + oidc in the registry', async () => {
      const { svc, secure } = setup();
      await firstValueFrom(svc.save(CAROL));

      // The refresh token is a credential → secure storage, under its own per-account key.
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBe(
        'carol-refresh',
      );
      const registry = prefs.get('matrix.accounts') ?? '';
      expect(registry).not.toContain('carol-refresh');
      // The non-secret expiry + provider binding DO live in the registry record.
      const record = JSON.parse(registry).accounts[0];
      expect(record.refreshToken).toBeUndefined();
      expect(record.accessTokenExpiresAt).toBe(1234567890);
      expect(record.oidc).toEqual(OIDC_BINDING);
    });

    it('round-trips the refresh token, expiry and oidc binding on load', async () => {
      const { svc } = setup();
      await firstValueFrom(svc.save(CAROL));

      expect(await firstValueFrom(svc.load('@carol:hs'))).toMatchObject({
        accessToken: 'carol-access',
        refreshToken: 'carol-refresh',
        accessTokenExpiresAt: 1234567890,
        oidc: OIDC_BINDING,
      });
    });

    it('updateTokens rotates access + refresh tokens and refreshes the expiry', async () => {
      const { svc, secure } = setup();
      await firstValueFrom(svc.save(CAROL));

      await firstValueFrom(
        svc.updateTokens('@carol:hs', 'new-access', 'new-refresh', 9999999999),
      );

      expect(secure.store.get('matrix.accessToken:@carol:hs')).toBe(
        'new-access',
      );
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBe(
        'new-refresh',
      );
      expect(await firstValueFrom(svc.load('@carol:hs'))).toMatchObject({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accessTokenExpiresAt: 9999999999,
      });
    });

    it('updateTokens keeps the existing refresh token when the provider rotated none', async () => {
      const { svc, secure } = setup();
      await firstValueFrom(svc.save(CAROL));

      await firstValueFrom(
        svc.updateTokens('@carol:hs', 'new-access', undefined, 8888),
      );

      expect(secure.store.get('matrix.accessToken:@carol:hs')).toBe(
        'new-access',
      );
      // Untouched — the OP didn't rotate it, so the stored one stays valid.
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBe(
        'carol-refresh',
      );
    });

    it('updateTokens is a no-op for an account no longer registered (signed out mid-refresh)', async () => {
      const { svc, secure } = setup();

      await firstValueFrom(svc.updateTokens('@ghost:hs', 'x', 'y', 1));

      expect(secure.store.get('matrix.accessToken:@ghost:hs')).toBeUndefined();
      expect(secure.store.get('matrix.refreshToken:@ghost:hs')).toBeUndefined();
    });

    it('a same-device re-login carries the rotated expiry + oidc (no silent staleness)', async () => {
      const { svc } = setup();
      await firstValueFrom(svc.save(CAROL));
      // Re-login on the same device with a fresh access-token window.
      await firstValueFrom(
        svc.save({
          ...CAROL,
          accessToken: 'reissued',
          accessTokenExpiresAt: 5555555555,
        }),
      );

      const [record] = await firstValueFrom(svc.list());
      expect(record.cryptoPrefix).toBe('trinity-crypto:@carol:hs:DEVC'); // store reused
      // The record must carry the NEW expiry, not the stale 1234567890.
      expect(record.accessTokenExpiresAt).toBe(5555555555);
      expect(record.oidc).toEqual(OIDC_BINDING);
    });

    it('clears a stale refresh token + oidc when the account re-logs in without one', async () => {
      const { svc, secure } = setup();
      await firstValueFrom(svc.save(CAROL));
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBe(
        'carol-refresh',
      );

      // Same account + device, but a plain (non-OIDC) login: no refresh token / binding.
      await firstValueFrom(
        svc.save({
          baseUrl: CAROL.baseUrl,
          userId: CAROL.userId,
          deviceId: CAROL.deviceId,
          accessToken: 'pw-token',
        }),
      );

      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBeUndefined();
      const [record] = await firstValueFrom(svc.list());
      expect(record.oidc).toBeUndefined();
      expect(record.accessTokenExpiresAt).toBeUndefined();
    });

    it('updateTokens for one account leaves a co-resident account untouched (no cross-account bleed)', async () => {
      const { svc, secure } = setup();
      const DAVE: MatrixSession = {
        baseUrl: 'https://hs',
        userId: '@dave:hs',
        deviceId: 'DEVD',
        accessToken: 'dave-access',
        refreshToken: 'dave-refresh',
        accessTokenExpiresAt: 111,
        oidc: OIDC_BINDING,
      };
      await firstValueFrom(svc.save(CAROL));
      await firstValueFrom(svc.save(DAVE)); // DAVE saved last → active

      // Refresh CAROL (the non-active account, as a background refresh would).
      await firstValueFrom(
        svc.updateTokens('@carol:hs', 'carol-new', 'carol-new-refresh', 222),
      );

      // CAROL rotated…
      expect(secure.store.get('matrix.accessToken:@carol:hs')).toBe(
        'carol-new',
      );
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBe(
        'carol-new-refresh',
      );
      // …DAVE's three values are byte-identical (the refresher must never write under
      // another account's key).
      expect(secure.store.get('matrix.accessToken:@dave:hs')).toBe(
        'dave-access',
      );
      expect(secure.store.get('matrix.refreshToken:@dave:hs')).toBe(
        'dave-refresh',
      );
      const dave = (await firstValueFrom(svc.list())).find(
        (a) => a.userId === '@dave:hs',
      );
      expect(dave?.accessTokenExpiresAt).toBe(111);
    });

    it('serializes a concurrent remove + token refresh so a signed-out account is not resurrected', async () => {
      const { svc, secure } = setup();
      await firstValueFrom(svc.save(CAROL));

      // A sign-out and a background token refresh for the SAME account race. Subscriptions
      // are created in array order, so remove is queued before the refresh.
      await Promise.all([
        firstValueFrom(svc.remove('@carol:hs')),
        firstValueFrom(
          svc.updateTokens('@carol:hs', 'late-access', 'late-refresh', 999),
        ),
      ]);

      // The refresh runs AFTER the remove committed, finds no account, and no-ops — CAROL
      // stays gone rather than being resurrected with rotated tokens (the lost-update race).
      expect(await firstValueFrom(svc.load('@carol:hs'))).toBeNull();
      expect(secure.store.get('matrix.accessToken:@carol:hs')).toBeUndefined();
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBeUndefined();
      expect(await firstValueFrom(svc.list())).toEqual([]);
    });

    it('invalidateToken, remove and clear each wipe the refresh token', async () => {
      const { svc, secure } = setup();

      await firstValueFrom(svc.save(CAROL));
      await firstValueFrom(svc.invalidateToken('@carol:hs'));
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBeUndefined();

      await firstValueFrom(svc.save(CAROL));
      await firstValueFrom(svc.remove('@carol:hs'));
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBeUndefined();

      await firstValueFrom(svc.save(CAROL));
      await firstValueFrom(svc.clear());
      expect(secure.store.get('matrix.refreshToken:@carol:hs')).toBeUndefined();
    });
  });

  it('holds multiple accounts and makes the latest saved one active', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save(BOB));

    const list = await firstValueFrom(svc.list());
    expect(list.map((a) => a.userId)).toEqual(['@alice:hs', '@bob:other']);
    // The most recent save is active; both are independently loadable.
    expect(await firstValueFrom(svc.load())).toEqual(BOB_STORED);
    expect(await firstValueFrom(svc.load('@alice:hs'))).toEqual(ALICE_STORED);
  });

  it('a same-device re-save (token rotation) reuses the crypto store', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save({ ...ALICE, accessToken: 'rotated' }));

    const list = await firstValueFrom(svc.list());
    expect(list).toEqual([
      {
        baseUrl: 'https://hs',
        userId: '@alice:hs',
        deviceId: 'DEV1',
        cryptoPrefix: 'trinity-crypto:@alice:hs:DEV1', // reused: same device
      },
    ]);
    expect(await firstValueFrom(svc.load('@alice:hs'))).toMatchObject({
      deviceId: 'DEV1',
      accessToken: 'rotated',
    });
  });

  it('recomputes the crypto store when a re-save brings a NEW device id', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE)); // DEV1
    await firstValueFrom(
      svc.save({ ...ALICE, deviceId: 'DEV1b', accessToken: 'rotated' }),
    );

    // A new server-issued device can't use the old device's Olm store, so the prefix
    // must move to a fresh device-scoped store rather than reopening the old one (which
    // the Rust OlmMachine rejects as an account/device mismatch).
    const [record] = await firstValueFrom(svc.list());
    expect(record.cryptoPrefix).toBe('trinity-crypto:@alice:hs:DEV1b');
  });

  it('a fresh login AFTER signing an account out lands on a new store (no orphan reopen)', async () => {
    const { svc } = setup();
    // Sign in, then fully sign out that account (its record is removed)…
    await firstValueFrom(svc.save(ALICE)); // device DEV1
    await firstValueFrom(svc.remove('@alice:hs'));
    // …then log the SAME user back in — the server issues a NEW device id.
    await firstValueFrom(
      svc.save({ ...ALICE, deviceId: 'DEV9', accessToken: 'fresh' }),
    );

    // The new login must NOT re-derive DEV1's prefix (that store is orphaned and still
    // holds DEV1's account → the reported "account in the store doesn't match" error).
    const [record] = await firstValueFrom(svc.list());
    expect(record.cryptoPrefix).toBe('trinity-crypto:@alice:hs:DEV9');
    expect(record.cryptoPrefix).not.toBe('trinity-crypto:@alice:hs:DEV1');
  });

  it('setActive switches which account load() returns', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save(BOB)); // Bob active

    await firstValueFrom(svc.setActive('@alice:hs'));
    expect(await firstValueFrom(svc.load())).toEqual(ALICE_STORED);

    // Switching to an unknown account is a no-op.
    await firstValueFrom(svc.setActive('@nobody:hs'));
    expect(await firstValueFrom(svc.load())).toEqual(ALICE_STORED);
  });

  it('remove drops one account + its token and repoints active; others survive', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save(BOB)); // Bob active

    await firstValueFrom(svc.remove('@bob:other'));

    expect(secure.store.get('matrix.accessToken:@bob:other')).toBeUndefined();
    expect(await firstValueFrom(svc.load('@bob:other'))).toBeNull();
    // Active repointed to the remaining account; Alice's token untouched.
    expect(await firstValueFrom(svc.load())).toEqual(ALICE_STORED);
    expect(secure.store.get('matrix.accessToken:@alice:hs')).toBe(
      'alice-token-xyz',
    );
  });

  it('remove of a NON-active background account leaves the active pointer put', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save(BOB)); // Bob active

    // Remove the backgrounded, non-active account.
    await firstValueFrom(svc.remove('@alice:hs'));

    // Active must stay on Bob — never silently repointed to accounts[0], which
    // would sign the user into a different account with no error.
    expect(await firstValueFrom(svc.load())).toEqual(BOB_STORED);
    // Only Alice's token + record are dropped; Bob's token is untouched.
    expect(secure.store.get('matrix.accessToken:@alice:hs')).toBeUndefined();
    expect(await firstValueFrom(svc.load('@alice:hs'))).toBeNull();
    expect((await firstValueFrom(svc.list())).map((a) => a.userId)).toEqual([
      '@bob:other',
    ]);
    expect(secure.store.get('matrix.accessToken:@bob:other')).toBe(
      'bob-token-abc',
    );
  });

  it('clear removes every account and token', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save(BOB));

    await firstValueFrom(svc.clear());

    expect(prefs.get('matrix.accounts')).toBeUndefined();
    expect(secure.store.get('matrix.accessToken:@alice:hs')).toBeUndefined();
    expect(secure.store.get('matrix.accessToken:@bob:other')).toBeUndefined();
    expect(await firstValueFrom(svc.load())).toBeNull();
    expect(await firstValueFrom(svc.list())).toEqual([]);
  });

  it('clear also retires leftover legacy single-slot residue (interrupted migration)', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(ALICE));
    await firstValueFrom(svc.save(BOB));
    // An interrupted migration left the legacy single-slot keys behind, coexisting
    // with the new registry.
    prefs.set(
      'matrix.session',
      JSON.stringify({
        baseUrl: ALICE.baseUrl,
        userId: ALICE.userId,
        deviceId: ALICE.deviceId,
      }),
    );
    secure.store.set('matrix.accessToken', ALICE.accessToken);

    await firstValueFrom(svc.clear());

    // Registry + per-account tokens gone…
    expect(prefs.get('matrix.accounts')).toBeUndefined();
    expect(secure.store.get('matrix.accessToken:@alice:hs')).toBeUndefined();
    expect(secure.store.get('matrix.accessToken:@bob:other')).toBeUndefined();
    // …AND the legacy residue, so the next fresh start can't re-migrate and
    // resurrect the signed-out account (a data leak on a shared device).
    expect(prefs.get('matrix.session')).toBeUndefined();
    expect(secure.store.get('matrix.accessToken')).toBeUndefined();
    expect(await firstValueFrom(svc.load())).toBeNull();
  });

  it('migrates the legacy single-slot session (secure token → per-account key, default crypto store)', async () => {
    const { svc, secure } = setup();
    // Legacy format: non-secret fields in `matrix.session`, token in secure storage.
    prefs.set(
      'matrix.session',
      JSON.stringify({
        baseUrl: ALICE.baseUrl,
        userId: ALICE.userId,
        deviceId: ALICE.deviceId,
      }),
    );
    secure.store.set('matrix.accessToken', ALICE.accessToken);

    // Transparent — no re-login — and the migrated account carries NO crypto prefix,
    // so it stays on the SDK default store (no forced re-verification on upgrade).
    expect(await firstValueFrom(svc.load())).toEqual(ALICE);
    expect((await firstValueFrom(svc.load()))?.cryptoPrefix).toBeUndefined();

    expect(secure.store.get('matrix.accessToken:@alice:hs')).toBe(
      'alice-token-xyz',
    );
    expect(secure.store.get('matrix.accessToken')).toBeUndefined(); // legacy key retired
    expect(prefs.get('matrix.session')).toBeUndefined(); // legacy slot retired
    expect(JSON.parse(prefs.get('matrix.accounts') ?? '')).toEqual({
      activeUserId: '@alice:hs',
      accounts: [
        { baseUrl: 'https://hs', userId: '@alice:hs', deviceId: 'DEV1' },
      ],
    });
  });

  /** Seed + migrate a legacy single-slot session for ALICE (device DEV1, no prefix). */
  async function migrateLegacyAlice(
    svc: SessionStorageService,
    secure: {
      store: Map<string, string>;
    },
  ): Promise<void> {
    prefs.set(
      'matrix.session',
      JSON.stringify({
        baseUrl: ALICE.baseUrl,
        userId: ALICE.userId,
        deviceId: ALICE.deviceId,
      }),
    );
    secure.store.set('matrix.accessToken', ALICE.accessToken);
    await firstValueFrom(svc.load()); // trigger migration (no prefix)
  }

  it('a same-device re-login of a migrated legacy account keeps its default crypto store', async () => {
    const { svc, secure } = setup();
    await migrateLegacyAlice(svc, secure);

    // Same device (soft-logout re-auth / token rotation): assigning a prefix would
    // orphan the account's existing default-prefixed Olm store and force re-verification.
    await firstValueFrom(svc.save({ ...ALICE, accessToken: 'rotated' }));
    const [record] = await firstValueFrom(svc.list());
    expect(record.cryptoPrefix).toBeUndefined();
  });

  it('moves a migrated legacy account to a device-scoped store when its device changes', async () => {
    const { svc, secure } = setup();
    await migrateLegacyAlice(svc, secure);

    // A genuinely new device can't reuse the legacy default store (bound to the old
    // device), so it must get a fresh device-scoped store — re-verification is
    // unavoidable for the new device, but login succeeds instead of throwing.
    await firstValueFrom(svc.save({ ...ALICE, deviceId: 'DEV1b' }));
    const [record] = await firstValueFrom(svc.list());
    expect(record.cryptoPrefix).toBe('trinity-crypto:@alice:hs:DEV1b');
  });

  describe('reclaiming a superseded crypto store on a device change', () => {
    /** Stub browser IndexedDB (absent under jsdom) and expose its deleteDatabase spy. */
    function stubIndexedDb() {
      const deleteDatabase = vi.fn();
      vi.stubGlobal('indexedDB', { deleteDatabase });
      return deleteDatabase;
    }

    it('deletes the old device store when a re-save brings a new device id', async () => {
      const deleteDatabase = stubIndexedDb();
      const { svc } = setup();
      await firstValueFrom(svc.save(ALICE)); // DEV1 → trinity-crypto:@alice:hs:DEV1
      await firstValueFrom(svc.save({ ...ALICE, deviceId: 'DEV1b' }));

      // The superseded DEV1 store (both its IndexedDB databases) is reclaimed so it
      // doesn't leak — the account already moved to its DEV1b store.
      expect(deleteDatabase).toHaveBeenCalledWith(
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto',
      );
      expect(deleteDatabase).toHaveBeenCalledWith(
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto-meta',
      );
    });

    it('leaves the store untouched on a same-device re-save (token rotation)', async () => {
      const deleteDatabase = stubIndexedDb();
      const { svc } = setup();
      await firstValueFrom(svc.save(ALICE));
      await firstValueFrom(svc.save({ ...ALICE, accessToken: 'rotated' }));

      expect(deleteDatabase).not.toHaveBeenCalled();
    });

    it('does not delete anything for a brand-new account (no prior store)', async () => {
      const deleteDatabase = stubIndexedDb();
      const { svc } = setup();
      await firstValueFrom(svc.save(ALICE));

      expect(deleteDatabase).not.toHaveBeenCalled();
    });

    it('still completes the save when deleteDatabase throws (best-effort)', async () => {
      vi.stubGlobal('indexedDB', {
        deleteDatabase: vi.fn(() => {
          throw new Error('blocked');
        }),
      });
      const { svc } = setup();
      await firstValueFrom(svc.save(ALICE));

      // A reclaim that throws must never fail the re-login it rides along with.
      const stored = await firstValueFrom(
        svc.save({ ...ALICE, deviceId: 'DEV1b' }),
      );
      expect(stored.cryptoPrefix).toBe('trinity-crypto:@alice:hs:DEV1b');
    });

    it('reclaims the SDK default store when a migrated legacy account changes device', async () => {
      const deleteDatabase = stubIndexedDb();
      const { svc, secure } = setup();
      await migrateLegacyAlice(svc, secure); // DEV1, no prefix → SDK default store
      await firstValueFrom(svc.save({ ...ALICE, deviceId: 'DEV1b' }));

      expect(deleteDatabase).toHaveBeenCalledWith(
        'matrix-js-sdk::matrix-sdk-crypto',
      );
      expect(deleteDatabase).toHaveBeenCalledWith(
        'matrix-js-sdk::matrix-sdk-crypto-meta',
      );
    });
  });

  describe('sweepOrphanedCryptoStores', () => {
    /** Stub browser IndexedDB with a fixed database listing; expose deleteDatabase. */
    function stubIndexedDbWith(names: string[]) {
      const deleteDatabase = vi.fn();
      const databases = vi
        .fn()
        .mockResolvedValue(names.map((name) => ({ name })));
      vi.stubGlobal('indexedDB', { databases, deleteDatabase });
      return deleteDatabase;
    }

    it('deletes a crypto store no signed-in account owns (a pre-fix orphan)', async () => {
      const { svc } = setup();
      await firstValueFrom(svc.save(ALICE)); // registers @alice, device-scoped store
      const deleteDatabase = stubIndexedDbWith([
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto',
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto-meta',
      ]);

      await firstValueFrom(svc.sweepOrphanedCryptoStores());

      expect(deleteDatabase).toHaveBeenCalledWith(
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto',
      );
      expect(deleteDatabase).toHaveBeenCalledWith(
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto-meta',
      );
    });

    it("never deletes a signed-in account's own crypto store", async () => {
      const { svc } = setup();
      await firstValueFrom(svc.save(ALICE)); // trinity-crypto:@alice:hs:DEV1
      const deleteDatabase = stubIndexedDbWith([
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto',
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto-meta',
      ]);

      await firstValueFrom(svc.sweepOrphanedCryptoStores());

      expect(deleteDatabase).not.toHaveBeenCalled();
    });

    it('spares the SDK default store while a migrated legacy account still uses it', async () => {
      const { svc, secure } = setup();
      await migrateLegacyAlice(svc, secure); // undefined prefix → SDK default store
      const deleteDatabase = stubIndexedDbWith([
        'matrix-js-sdk::matrix-sdk-crypto',
        'matrix-js-sdk::matrix-sdk-crypto-meta',
      ]);

      await firstValueFrom(svc.sweepOrphanedCryptoStores());

      expect(deleteDatabase).not.toHaveBeenCalled();
    });

    it('ignores non-crypto databases (the message-sync store, unrelated names)', async () => {
      const { svc } = setup();
      const deleteDatabase = stubIndexedDbWith([
        'trinity-sync:@ghost:hs',
        'some-unrelated-db',
      ]);

      await firstValueFrom(svc.sweepOrphanedCryptoStores());

      expect(deleteDatabase).not.toHaveBeenCalled();
    });

    it('is a no-op where indexedDB.databases() is unavailable (e.g. Firefox)', async () => {
      const deleteDatabase = vi.fn();
      vi.stubGlobal('indexedDB', { deleteDatabase }); // no databases()
      const { svc } = setup();

      await firstValueFrom(svc.sweepOrphanedCryptoStores());

      expect(deleteDatabase).not.toHaveBeenCalled();
    });

    it('resolves without throwing when databases() rejects (best-effort)', async () => {
      const deleteDatabase = vi.fn();
      vi.stubGlobal('indexedDB', {
        databases: vi.fn().mockRejectedValue(new Error('nope')),
        deleteDatabase,
      });
      const { svc } = setup();

      await expect(
        firstValueFrom(svc.sweepOrphanedCryptoStores()),
      ).resolves.toBeUndefined();
      expect(deleteDatabase).not.toHaveBeenCalled();
    });
  });

  it('migrates a pre-secure-storage blob (token inline in the legacy JSON)', async () => {
    const { svc, secure } = setup();
    prefs.set('matrix.session', JSON.stringify(ALICE)); // token inside the JSON

    expect(await firstValueFrom(svc.load())).toEqual(ALICE);

    // Token re-homed to the per-account secure key; never left in Preferences.
    expect(secure.store.get('matrix.accessToken:@alice:hs')).toBe(
      'alice-token-xyz',
    );
    expect(prefs.get('matrix.accounts') ?? '').not.toContain('alice-token-xyz');
    expect(prefs.get('matrix.session')).toBeUndefined();
  });

  it('ignores an incomplete legacy blob', async () => {
    const { svc } = setup();
    prefs.set('matrix.session', JSON.stringify({ userId: '@x:hs' })); // no baseUrl/token

    expect(await firstValueFrom(svc.load())).toBeNull();
    expect(await firstValueFrom(svc.list())).toEqual([]);
  });
});
