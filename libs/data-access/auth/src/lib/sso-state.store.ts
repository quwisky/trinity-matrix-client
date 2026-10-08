import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { type LoginMode } from './account-establishment';
import { DevicePreferenceStorageService } from '@trinity/platform-native';
import { isFresh } from './stash-freshness';

const STATE_KEY = 'sso.state';
const BASE_URL_KEY = 'sso.baseUrl';
const STARTED_KEY = 'sso.startedAt';
const MODE_KEY = 'sso.mode';
const DEVICE_ID_KEY = 'sso.deviceId';

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
  private readonly storage = inject(DevicePreferenceStorageService);

  /** Stash the state + homeserver + mode (timestamped) before redirecting to SSO. */
  async save(
    state: string,
    baseUrl: string,
    mode: LoginMode = 'replace',
    deviceId?: string,
  ): Promise<void> {
    await firstValueFrom(
      this.storage.setMany([
        { key: STATE_KEY, value: state },
        { key: BASE_URL_KEY, value: baseUrl },
        { key: STARTED_KEY, value: String(Date.now()) },
        { key: MODE_KEY, value: mode },
        ...(deviceId ? [{ key: DEVICE_ID_KEY, value: deviceId }] : []),
      ]),
    );
    // Remove residue from a prior un-consumed re-auth attempt for ordinary login.
    if (!deviceId) {
      await firstValueFrom(this.storage.remove(DEVICE_ID_KEY));
    }
  }

  /**
   * Read the stash WITHOUT clearing it, returning an empty stash when nothing was saved
   * or it is older than the TTL. The callback verifies the returned state against this
   * before {@link clear}ing, so a forged/mismatched deep-link callback can't wipe an
   * in-flight login's stash.
   */
  async peek(): Promise<SsoStateStash> {
    const [state, baseUrl, startedAt, mode, deviceId] = await firstValueFrom(
      this.storage.getMany([
        STATE_KEY,
        BASE_URL_KEY,
        STARTED_KEY,
        MODE_KEY,
        DEVICE_ID_KEY,
      ]),
    );

    const fresh = isFresh(startedAt);
    if (!fresh) {
      return { state: null, baseUrl: null, mode: 'replace', deviceId: null };
    }
    return {
      state,
      baseUrl,
      mode: mode === 'add' ? 'add' : 'replace',
      deviceId,
    };
  }

  /** Remove every SSO-state key. */
  async clear(): Promise<void> {
    await firstValueFrom(
      this.storage.removeMany([
        STATE_KEY,
        BASE_URL_KEY,
        STARTED_KEY,
        MODE_KEY,
        DEVICE_ID_KEY,
      ]),
    );
  }
}
