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
  sessionStateKey: 'mx_oidc_STATE1',
  sessionStateBlob: 'SIGNIN_BLOB',
};

describe('OidcStateStore', () => {
  let store: OidcStateStore;

  beforeEach(() => {
    prefs.clear();
    TestBed.configureTestingModule({ providers: [OidcStateStore] });
    store = TestBed.inject(OidcStateStore);
  });

  it('round-trips the full stash (including the sign-in blob) through save → peek', async () => {
    await store.save(SAVE);

    expect(await store.peek()).toEqual({
      state: 'STATE1',
      baseUrl: 'https://hs.example',
      mode: 'add',
      redirectUri: 'https://app/sso-callback',
      issuer: 'https://op.example',
      sessionStateKey: 'mx_oidc_STATE1',
      sessionStateBlob: 'SIGNIN_BLOB',
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
      sessionStateBlob: null,
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
    // The blob holds the PKCE code_verifier — a secret — and on native/Electron it sits
    // in app-private PLAINTEXT. The TTL was only enforced at read time, so an abandoned
    // login left it there until some later save() happened to overwrite it.
    await store.save(SAVE);
    expect(prefs.get('oidc.ssBlob')).toBeDefined(); // stashed…
    prefs.set('oidc.startedAt', '0'); // …then abandoned past the TTL

    await store.peek();

    expect(prefs.get('oidc.ssBlob')).toBeUndefined(); // gone, not just refused
    expect(prefs.get('oidc.state')).toBeUndefined();
  });

  it('persists no blob when there is none to stash', async () => {
    await store.save({ ...SAVE, sessionStateBlob: null });

    const stash = await store.peek();
    expect(stash.sessionStateKey).toBe('mx_oidc_STATE1');
    expect(stash.sessionStateBlob).toBeNull();
  });

  it('clears a prior attempt’s blob when a new attempt has none (no stale verifier)', async () => {
    // Attempt A stashes a blob but is abandoned (never consumed)…
    await store.save(SAVE);
    // …then attempt B starts with no blob and a fresh state: B must not inherit A's blob.
    await store.save({
      ...SAVE,
      state: 'STATE2',
      sessionStateKey: 'mx_oidc_STATE2',
      sessionStateBlob: null,
    });

    const stash = await store.peek();
    expect(stash.state).toBe('STATE2');
    expect(stash.sessionStateKey).toBe('mx_oidc_STATE2');
    expect(stash.sessionStateBlob).toBeNull(); // NOT the stale 'SIGNIN_BLOB'
  });
});
