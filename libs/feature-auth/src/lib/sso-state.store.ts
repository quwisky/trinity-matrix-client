import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { type LoginMode } from '@trinity/data-access-auth';

const STATE_KEY = 'sso.state';
const BASE_URL_KEY = 'sso.baseUrl';
const STARTED_KEY = 'sso.startedAt';
const MODE_KEY = 'sso.mode';
const DEVICE_ID_KEY = 'sso.deviceId';

/** SSO round-trips are short; reject a stash older than this to limit replay. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes

/** The single-use SSO stash read back on the callback (each field may be absent). */
export interface SsoStateStash {
  state: string | null;
  baseUrl: string | null;
  /** Whether this round-trip adds an account or replaces the current one. */
  mode: LoginMode;
  /** Device id to re-authenticate (re-auth of a soft-logged-out account), else null. */
  deviceId: string | null;
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
  /** Stash the state + homeserver + mode (timestamped) before redirecting to SSO. */
  async save(
    state: string,
    baseUrl: string,
    mode: LoginMode = 'replace',
    deviceId?: string,
  ): Promise<void> {
    await Promise.all([
      Preferences.set({ key: STATE_KEY, value: state }),
      Preferences.set({ key: BASE_URL_KEY, value: baseUrl }),
      Preferences.set({ key: STARTED_KEY, value: String(Date.now()) }),
      Preferences.set({ key: MODE_KEY, value: mode }),
      ...(deviceId
        ? [Preferences.set({ key: DEVICE_ID_KEY, value: deviceId })]
        : []),
    ]);
  }

  /**
   * Read and consume (single-use) the stash: always clears storage, and returns an
   * empty stash when nothing was saved or it is older than the TTL — so a stale or
   * already-used nonce can't be replayed.
   */
  async consume(): Promise<SsoStateStash> {
    const [state, baseUrl, startedAt, mode, deviceId] = await Promise.all([
      Preferences.get({ key: STATE_KEY }),
      Preferences.get({ key: BASE_URL_KEY }),
      Preferences.get({ key: STARTED_KEY }),
      Preferences.get({ key: MODE_KEY }),
      Preferences.get({ key: DEVICE_ID_KEY }),
    ]);
    await this.clear();

    const started = Number(startedAt.value);
    const fresh = Number.isFinite(started) && Date.now() - started <= TTL_MS;
    if (!fresh) {
      return { state: null, baseUrl: null, mode: 'replace', deviceId: null };
    }
    return {
      state: state.value ?? null,
      baseUrl: baseUrl.value ?? null,
      mode: mode.value === 'add' ? 'add' : 'replace',
      deviceId: deviceId.value ?? null,
    };
  }

  /** Remove every SSO-state key. */
  async clear(): Promise<void> {
    await Promise.all([
      Preferences.remove({ key: STATE_KEY }),
      Preferences.remove({ key: BASE_URL_KEY }),
      Preferences.remove({ key: STARTED_KEY }),
      Preferences.remove({ key: MODE_KEY }),
      Preferences.remove({ key: DEVICE_ID_KEY }),
    ]);
  }
}
