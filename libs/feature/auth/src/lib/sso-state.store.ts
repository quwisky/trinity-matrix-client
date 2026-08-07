import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { type LoginMode } from '@trinity/data-access/auth';

const STATE_KEY = 'sso.state';
const BASE_URL_KEY = 'sso.baseUrl';
const STARTED_KEY = 'sso.startedAt';
const MODE_KEY = 'sso.mode';
const DEVICE_ID_KEY = 'sso.deviceId';

/** SSO round-trips are short; reject a stash older than this to limit replay. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes
/**
 * How far the stash may appear to have been written in the FUTURE before it is rejected.
 * The lower bound exists so a clock nudged forward cannot mint a stash that never expires
 * — but a zero-tolerance version fails an ordinary login, because the same event class
 * (a clock stepped backwards: NITZ/NTP after airplane mode, a laptop resuming from sleep,
 * w32time) can land mid-round-trip while the user is typing at the provider. A minute
 * survives normal clock discipline and still bins a stash written hours ahead.
 */
const CLOCK_SKEW_MS = 60 * 1000;

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
      // Set the device id, or REMOVE any residue from a prior un-consumed attempt.
      // Every other key here is overwritten unconditionally; leaving this one behind
      // let an abandoned re-auth (which stashes a device id) hand its DEVICE_ID to the
      // next, ordinary login within the TTL — silently re-authenticating a stale device
      // instead of minting a fresh one. Mirrors OidcStateStore's blob handling.
      deviceId
        ? Preferences.set({ key: DEVICE_ID_KEY, value: deviceId })
        : Preferences.remove({ key: DEVICE_ID_KEY }),
    ]);
  }

  /**
   * Read the stash WITHOUT clearing it, returning an empty stash when nothing was saved
   * or it is older than the TTL. The callback verifies the returned state against this
   * before {@link clear}ing, so a forged/mismatched deep-link callback can't wipe an
   * in-flight login's stash.
   */
  async peek(): Promise<SsoStateStash> {
    const [state, baseUrl, startedAt, mode, deviceId] = await Promise.all([
      Preferences.get({ key: STATE_KEY }),
      Preferences.get({ key: BASE_URL_KEY }),
      Preferences.get({ key: STARTED_KEY }),
      Preferences.get({ key: MODE_KEY }),
      Preferences.get({ key: DEVICE_ID_KEY }),
    ]);

    const started = Number(startedAt.value);
    const age = Date.now() - started;
    // Two-sided, matching {@link OidcStateStore.peek}. `age <= TTL_MS` alone treats a
    // FUTURE timestamp as fresh, so a stash written before the clock was corrected
    // backwards would never expire — and the TTL is what bounds the window in which a
    // leaked `sso_state` nonce still buys an attacker a forged callback.
    const fresh =
      Number.isFinite(started) && age >= -CLOCK_SKEW_MS && age <= TTL_MS;
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
