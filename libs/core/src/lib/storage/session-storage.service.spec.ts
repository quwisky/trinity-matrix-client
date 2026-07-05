import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStorageService } from './session-storage.service';
import { SecureStorageService } from './secure-storage.service';
import { MatrixSession } from '../matrix/session.model';

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

const SESSION: MatrixSession = {
  baseUrl: 'https://hs',
  userId: '@me:hs',
  deviceId: 'DEV1',
  accessToken: 'secret-token-xyz',
};

/**
 * Provide the real {@link SessionStorageService} with a mocked
 * {@link SecureStorageService}. ng-mocks' auto-spies are backed by an in-memory
 * map so the keychain stand-in round-trips like the real thing (a real
 * keychain/keystore in production); `secure.store` exposes that map for assertions.
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

  it('keeps the access token out of Preferences and in secure storage', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(SESSION));

    expect(secure.store.get('matrix.accessToken')).toBe('secret-token-xyz');
    const blob = prefs.get('matrix.session') ?? '';
    expect(blob).not.toContain('secret-token-xyz');
    expect(JSON.parse(blob)).toEqual({
      baseUrl: 'https://hs',
      userId: '@me:hs',
      deviceId: 'DEV1',
    });
  });

  it('round-trips save → load', async () => {
    const { svc } = setup();
    await firstValueFrom(svc.save(SESSION));
    expect(await firstValueFrom(svc.load())).toEqual(SESSION);
  });

  it('returns null when nothing is stored', async () => {
    const { svc } = setup();
    expect(await firstValueFrom(svc.load())).toBeNull();
  });

  it('clear() removes both the Preferences blob and the secure token', async () => {
    const { svc, secure } = setup();
    await firstValueFrom(svc.save(SESSION));
    await firstValueFrom(svc.clear());

    expect(prefs.get('matrix.session')).toBeUndefined();
    expect(secure.store.get('matrix.accessToken')).toBeUndefined();
    expect(await firstValueFrom(svc.load())).toBeNull();
  });

  it('migrates a legacy plaintext session blob (token → secure, stripped from Preferences)', async () => {
    const { svc, secure } = setup();
    // Pre-secure-storage format: the whole session (incl. token) lived in Preferences.
    prefs.set('matrix.session', JSON.stringify(SESSION));

    const loaded = await firstValueFrom(svc.load());
    expect(loaded).toEqual(SESSION); // transparent — no re-login

    expect(secure.store.get('matrix.accessToken')).toBe('secret-token-xyz');
    const blob = prefs.get('matrix.session') ?? '';
    expect(blob).not.toContain('secret-token-xyz');
    expect(
      (JSON.parse(blob) as Partial<MatrixSession>).accessToken,
    ).toBeUndefined();
  });
});
