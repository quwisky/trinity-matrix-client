import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const STATE_KEY = 'sso.state';
const BASE_URL_KEY = 'sso.baseUrl';
const STARTED_KEY = 'sso.startedAt';

/** SSO round-trips are short; reject a stash older than this to limit replay. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes

/** The single-use SSO stash read back on the callback (each field may be absent). */
export interface SsoStateStash {
  state: string | null;
  baseUrl: string | null;
}

/**
 * Persists the single-use SSO CSRF state + homeserver across the SSO round-trip via
 * Capacitor Preferences (localStorage on web, native key-value on device). Unlike
 * `sessionStorage`, Preferences survives a native process eviction, so a cold-start
 * deep-link callback — where the relaunched WebView has empty `sessionStorage` —
 * can still validate the returned state.
 *
 * These are NOT secret tokens (just a nonce + base URL), so Preferences is
 * acceptable here; the stash is single-use (cleared on read) and time-boxed.
 */
@Injectable({ providedIn: 'root' })
export class SsoStateStore {
  /** Stash the state + homeserver (timestamped) before redirecting to SSO. */
  async save(state: string, baseUrl: string): Promise<void> {
    await Promise.all([
      Preferences.set({ key: STATE_KEY, value: state }),
      Preferences.set({ key: BASE_URL_KEY, value: baseUrl }),
      Preferences.set({ key: STARTED_KEY, value: String(Date.now()) }),
    ]);
  }

  /**
   * Read and consume (single-use) the stash: always clears storage, and returns an
   * empty stash when nothing was saved or it is older than the TTL — so a stale or
   * already-used nonce can't be replayed.
   */
  async consume(): Promise<SsoStateStash> {
    const [state, baseUrl, startedAt] = await Promise.all([
      Preferences.get({ key: STATE_KEY }),
      Preferences.get({ key: BASE_URL_KEY }),
      Preferences.get({ key: STARTED_KEY }),
    ]);
    await this.clear();

    const started = Number(startedAt.value);
    const fresh = Number.isFinite(started) && Date.now() - started <= TTL_MS;
    if (!fresh) {
      return { state: null, baseUrl: null };
    }
    return { state: state.value ?? null, baseUrl: baseUrl.value ?? null };
  }

  /** Remove every SSO-state key. */
  async clear(): Promise<void> {
    await Promise.all([
      Preferences.remove({ key: STATE_KEY }),
      Preferences.remove({ key: BASE_URL_KEY }),
      Preferences.remove({ key: STARTED_KEY }),
    ]);
  }
}
