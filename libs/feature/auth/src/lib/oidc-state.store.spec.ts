import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcStateStore } from './oidc-state.store';

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

const SAVE = {
  state: 'STATE1',
  baseUrl: 'https://hs.example',
  mode: 'add' as const,
  redirectUri: 'https://app/sso-callback',
  issuer: 'https://op.example',
  clientId: 'CLIENT1',
  deviceId: 'DEVICE1',
  codeVerifier: 'VERIFIER1',
};

describe('OidcStateStore', () => {
  let store: OidcStateStore;

  beforeEach(() => {
    prefs.clear();
    TestBed.configureTestingModule({ providers: [OidcStateStore] });
    store = TestBed.inject(OidcStateStore);
  });

  it('round-trips the full stash (including the PKCE verifier) through save → peek', async () => {
    await store.save(SAVE);

    expect(await store.peek()).toEqual({
      state: 'STATE1',
      baseUrl: 'https://hs.example',
      mode: 'add',
      redirectUri: 'https://app/sso-callback',
      issuer: 'https://op.example',
      clientId: 'CLIENT1',
      deviceId: 'DEVICE1',
      codeVerifier: 'VERIFIER1',
    });
  });

  it('peek returns the stash without clearing it (state can be verified first)', async () => {
    await store.save(SAVE);

    expect((await store.peek()).state).toBe('STATE1');
    // A second peek still sees it — peek never clears, so a forged callback can't wipe it.
    expect((await store.peek()).state).toBe('STATE1');
  });

  it('is single-use via peek + clear: after clear, peek is empty', async () => {
    await store.save(SAVE);
    await store.clear();

    expect(await store.peek()).toMatchObject({
      state: null,
      baseUrl: null,
      codeVerifier: null,
    });
  });

  it('reads back an empty stash when nothing was ever saved', async () => {
    expect(await store.peek()).toMatchObject({
      state: null,
      baseUrl: null,
      mode: 'replace',
      redirectUri: null,
      clientId: null,
      deviceId: null,
      codeVerifier: null,
    });
  });

  it('rejects a stash older than the TTL', async () => {
    await store.save(SAVE);
    // Backdate the round-trip well past the 10-minute TTL.
    prefs.set('oidc.startedAt', '0');

    expect(await store.peek()).toMatchObject({
      state: null,
      baseUrl: null,
      mode: 'replace',
      redirectUri: null,
    });
  });

  it('bins an expired stash instead of leaving the code_verifier on disk', async () => {
    // The stash holds the PKCE code_verifier — a secret — and on native/Electron it sits
    // in app-private PLAINTEXT. The TTL was only enforced at read time, so an abandoned
    // login left it there until some later save() happened to overwrite it.
    await store.save(SAVE);
    expect(prefs.get('oidc.codeVerifier')).toBe('VERIFIER1'); // stashed…
    prefs.set('oidc.startedAt', '0'); // …then abandoned past the TTL

    await store.peek();

    expect(prefs.get('oidc.codeVerifier')).toBeUndefined(); // gone, not just refused
    expect(prefs.get('oidc.state')).toBeUndefined();
  });

  it('clear purges the pre-42 sign-in-state keys too (no orphaned plaintext verifier)', async () => {
    // Versions before matrix-js-sdk 42 stashed an opaque copy of the SDK's sessionStorage
    // sign-in state, whose blob embedded a PKCE code_verifier in plaintext. Nothing writes
    // those keys now, so an abandoned pre-upgrade stash would otherwise sit on disk
    // forever — never overwritten, never TTL'd, because save() no longer touches it.
    prefs.set('oidc.ssKey', 'mx_oidc_OLDSTATE');
    prefs.set('oidc.ssBlob', 'LEGACY_BLOB_WITH_VERIFIER');
    await store.save(SAVE);

    await store.clear();

    expect(prefs.get('oidc.ssKey')).toBeUndefined();
    expect(prefs.get('oidc.ssBlob')).toBeUndefined();
    expect(prefs.get('oidc.codeVerifier')).toBeUndefined();
  });

  it('a new attempt overwrites the previous one’s verifier (no stale secret)', async () => {
    // Attempt A stashes a verifier but is abandoned (never consumed)…
    await store.save(SAVE);
    // …then attempt B starts with its own PKCE context: B must not inherit any of A's.
    await store.save({
      ...SAVE,
      state: 'STATE2',
      clientId: 'CLIENT2',
      deviceId: 'DEVICE2',
      codeVerifier: 'VERIFIER2',
    });

    const stash = await store.peek();
    expect(stash.state).toBe('STATE2');
    expect(stash.clientId).toBe('CLIENT2');
    expect(stash.deviceId).toBe('DEVICE2');
    expect(stash.codeVerifier).toBe('VERIFIER2'); // NOT the stale 'VERIFIER1'
  });
});
