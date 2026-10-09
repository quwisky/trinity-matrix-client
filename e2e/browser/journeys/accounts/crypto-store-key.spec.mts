import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, testResourceId, type Page } from '../../../fixtures.mts';
import {
  databaseNames,
  homeserverSession,
  login,
  readPreference,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Each account's Rust crypto store is encrypted with its own store key. These journeys
// check the real stores in IndexedDB with the real crypto WASM, served beside the app so
// the page can open the app's own databases with a second, independent copy of it. The
// unit specs cover key creation, reuse and deletion; what only a browser can show is
// that the store really is encrypted, and that the WASM behaves the way the policy for
// older stores relies on.
const session = homeserverSession();

const WASM_DIR = join(
  import.meta.dirname,
  '../../../../node_modules/@matrix-org/matrix-sdk-crypto-wasm',
);
const WASM_PATH = '/__crypto-store-probe/';
const WRAPPING_KEY_DB = 'trinity-crypto-store-keys';

type CryptoWasm = typeof import('@matrix-org/matrix-sdk-crypto-wasm');

interface StoreOpen {
  readonly ok: boolean;
  readonly identity?: string;
  readonly error?: string;
}

interface StoredAccount {
  readonly userId: string;
  readonly deviceId: string;
  readonly cryptoPrefix: string;
  readonly cryptoStoreKeyed?: true;
}

async function storedAccount(page: Page): Promise<StoredAccount> {
  const registry = JSON.parse(
    (await readPreference(page, 'matrix.accounts')) ?? '{}',
  ) as { accounts: StoredAccount[] };
  return registry.accounts[0];
}

/** Delete the web wrapping-key database, as clearing part of the site's data would. */
function deleteWrappingKeys(page: Page): Promise<void> {
  return page.evaluate(
    (name) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess =
          request.onerror =
          request.onblocked =
            () => resolve();
      }),
    WRAPPING_KEY_DB,
  );
}

interface StoreRequest {
  readonly prefix: string;
  readonly userId: string;
  readonly deviceId: string;
  /** The store key's bytes, or null to open without a key. */
  readonly key: number[] | null;
}

async function serveCryptoWasm(page: Page): Promise<void> {
  await page.route(`**${WASM_PATH}**`, (route) => {
    const file = new URL(route.request().url()).pathname.slice(
      WASM_PATH.length,
    );
    return route.fulfill({
      body: readFileSync(join(WASM_DIR, file)),
      contentType: file.endsWith('.wasm')
        ? 'application/wasm'
        : 'text/javascript',
    });
  });
}

/** Open a crypto store the way `initRustCrypto` does; report its identity or error. */
function openCryptoStore(
  page: Page,
  request: StoreRequest,
): Promise<StoreOpen> {
  return page.evaluate(
    async ({ path, prefix, userId, deviceId, key }) => {
      const sdk = (await import(`${path}index.mjs`)) as CryptoWasm;
      await sdk.initAsync();
      try {
        const handle = key
          ? await sdk.StoreHandle.openWithKey(prefix, new Uint8Array(key))
          : await sdk.StoreHandle.open(prefix, null);
        try {
          const machine = await sdk.OlmMachine.initFromStore(
            new sdk.UserId(userId),
            new sdk.DeviceId(deviceId),
            handle,
          );
          const identity = machine.identityKeys.curve25519.toBase64();
          machine.close();
          return { ok: true, identity };
        } finally {
          handle.free();
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { path: WASM_PATH, ...request },
  );
}

/** Whether a crypto store holds its cipher: the WASM writes one only for a keyed store. */
function hasStoreCipher(page: Page, prefix: string): Promise<boolean> {
  return page.evaluate(
    (name) =>
      new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('matrix-sdk-crypto')) {
            db.close();
            resolve(false);
            return;
          }
          const read = db
            .transaction('matrix-sdk-crypto')
            .objectStore('matrix-sdk-crypto')
            .getKey('store_cipher');
          read.onsuccess = () => {
            db.close();
            resolve(read.result !== undefined);
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
    `${prefix}::matrix-sdk-crypto-meta`,
  );
}

function deleteStore(page: Page, prefix: string): Promise<void> {
  return page.evaluate(async (base) => {
    for (const suffix of ['::matrix-sdk-crypto', '::matrix-sdk-crypto-meta']) {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(`${base}${suffix}`);
        request.onsuccess = request.onerror = request.onblocked = resolve;
      });
    }
  }, prefix);
}

test.describe('Crypto store key', () => {
  test("encrypts a new sign-in's crypto store, which does not open without its key", async ({
    page,
    request,
  }) => {
    test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
    const user = `store-key-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    await login(page, {
      available: true,
      hs: session.hs,
      user,
      pass,
    } as HomeserverSession);

    const account = await storedAccount(page);
    expect(account.cryptoPrefix).toBe(
      `trinity-crypto:${account.userId}:${account.deviceId}`,
    );
    expect(account.cryptoStoreKeyed).toBe(true);

    // On the web the key is stored wrapped (IV, ciphertext and GCM tag), never as the
    // 32 raw bytes, and its wrapping key lives in IndexedDB.
    const stored = await readPreference(
      page,
      `secure.matrix.cryptoStoreKey:${account.cryptoPrefix}`,
    );
    expect(Buffer.from(stored ?? '', 'base64')).toHaveLength(12 + 32 + 16);
    expect(await databaseNames(page)).toContain('trinity-crypto-store-keys');

    expect(await hasStoreCipher(page, account.cryptoPrefix)).toBe(true);
    await serveCryptoWasm(page);
    const keyless = await openCryptoStore(page, {
      prefix: account.cryptoPrefix,
      userId: account.userId,
      deviceId: account.deviceId,
      key: null,
    });
    expect(keyless.ok).toBe(false);

    // A restart reads the key back through the real IndexedDB wrapping key. Crypto is
    // live again exactly when the session's verification state is known, and an
    // encrypted store shows no request to sign in again.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openSettingsSection(page, 'security');
    await expect(page.getByTestId('security-verify')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('security-stored-keys')).toHaveCount(0);
  });

  test('a lost store key never opens the store without it, and a new sign-in recovers', async ({
    page,
    request,
  }) => {
    test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
    const user = `store-key-lost-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const credentials = {
      available: true,
      hs: session.hs,
      user,
      pass,
    } as HomeserverSession;
    await login(page, credentials);
    const before = await storedAccount(page);
    expect(await databaseNames(page)).toContain(WRAPPING_KEY_DB);

    // The key can no longer be unwrapped: its wrapping key is gone.
    await deleteWrappingKeys(page);
    expect(await databaseNames(page)).not.toContain(WRAPPING_KEY_DB);

    // The restart reads the key, finds it unusable and stops before opening the store.
    // Reading must not bring the wrapping-key database back.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-startup-blocked')).toBeVisible({
      timeout: 30_000,
    });
    expect(await databaseNames(page)).not.toContain(WRAPPING_KEY_DB);
    // The store was never opened without its key, so it is still the encrypted one.
    expect(await hasStoreCipher(page, before.cryptoPrefix)).toBe(true);

    // Removing the account deletes its key; deleting must not bring the database back
    // either.
    const recover = page.getByTestId('app-startup-recovery');
    await expect(recover).toHaveAttribute('data-recovery', 'reauthenticate');
    await recover.click();
    await page.getByTestId('alert-confirm').click();
    await expect
      .poll(() => readPreference(page, 'matrix.accounts'), { timeout: 30_000 })
      .toBeNull();
    expect(await databaseNames(page)).not.toContain(WRAPPING_KEY_DB);

    // Start again from a cold document. The startup retry that follows "Remove account"
    // in the same document still sees the sign-out in progress and asks for one more
    // retry; that recovery behaviour predates store keys and is not what this checks.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Homeserver')).toBeVisible({
      timeout: 30_000,
    });

    // Signing in again sets the account up as a new device with a new store and key.
    await login(page, credentials);
    const after = await storedAccount(page);
    expect(after.deviceId).not.toBe(before.deviceId);
    expect(after.cryptoStoreKeyed).toBe(true);
    expect(await databaseNames(page)).toContain(WRAPPING_KEY_DB);
    expect(await hasStoreCipher(page, after.cryptoPrefix)).toBe(true);
  });

  test('refuses a key for a store created without one, and leaves that store usable', async ({
    page,
  }) => {
    // Why a store created before store keys existed keeps opening without one: adding a
    // key fails to open it, and the WASM has no way to encrypt it in place.
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await serveCryptoWasm(page);
    const store = {
      prefix: `e2e-store-key-probe-${testResourceId('run')}`,
      userId: '@probe:example.org',
      deviceId: 'PROBEDEVICE',
    };

    try {
      const created = await openCryptoStore(page, { ...store, key: null });
      expect(created.ok).toBe(true);

      const withKey = await openCryptoStore(page, {
        ...store,
        key: Array.from({ length: 32 }, (_, i) => i),
      });
      expect(withKey.ok).toBe(false);

      const reopened = await openCryptoStore(page, { ...store, key: null });
      expect(reopened).toEqual(created);
    } finally {
      await deleteStore(page, store.prefix);
    }
  });
});
