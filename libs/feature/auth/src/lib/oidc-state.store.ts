import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { type LoginMode } from '@trinity/data-access/auth';
import { DevicePreferenceStorageService } from '@trinity/platform-native';

const STATE_KEY = 'oidc.state';
const BASE_URL_KEY = 'oidc.baseUrl';
const STARTED_KEY = 'oidc.startedAt';
const MODE_KEY = 'oidc.mode';
const REDIRECT_URI_KEY = 'oidc.redirectUri';
const ISSUER_KEY = 'oidc.issuer';
const CLIENT_ID_KEY = 'oidc.clientId';
const DEVICE_ID_KEY = 'oidc.deviceId';
const CODE_VERIFIER_KEY = 'oidc.codeVerifier';
const EXPECTED_USER_ID_KEY = 'oidc.expectedUserId';
/**
 * Written by versions before matrix-js-sdk 42, when the SDK kept the sign-in state in
 * sessionStorage and this store shuttled an opaque copy of it. Nothing writes them now,
 * and the blob held a PKCE code_verifier in plaintext — so {@link OidcStateStore.clear}
 * purges them rather than leaving an abandoned one on disk forever. Drop in a later release.
 */
const LEGACY_KEYS = ['oidc.ssKey', 'oidc.ssBlob'] as const;

/** OIDC round-trips are short; reject a stash older than this to limit replay. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes
/**
 * How far the stash may appear to have been written in the FUTURE before it is rejected.
 * The lower bound exists so a clock nudged forward cannot mint a stash that never expires
 * — but a zero-tolerance version fails an ordinary login, because the same event class
 * (a clock stepped backwards: NITZ/NTP after airplane mode, a laptop resuming from sleep,
 * w32time) can land mid-round-trip while the user is typing at the provider. A minute
 * survives normal clock discipline and still bins a stash written hours ahead. Kept in
 * step with {@link SsoStateStore}.
 */
const CLOCK_SKEW_MS = 60 * 1000;

/** What {@link OidcStateStore.save} persists across the OIDC authorization round-trip. */
export interface OidcStateSave {
  /** The provider-facing OAuth `state`, verified against the callback's `state` param. */
  state: string;
  baseUrl: string;
  /** Whether this round-trip adds an account or replaces the current one. */
  mode: LoginMode;
  /** The redirect URI used to build the request; needed to rebuild the token refresher. */
  redirectUri: string;
  /** The OIDC issuer; lets the callback forget a stale client registration on failure. */
  issuer: string;
  /** The registered client id this request was built with. */
  clientId: string;
  /** The device id the SDK minted for this request. */
  deviceId: string;
  /** SECRET. The PKCE code_verifier the token exchange must present. */
  codeVerifier: string;
  /**
   * Re-auth only: the account this round-trip is meant to reconnect. A provider holding
   * a browser session can authorize with no interaction and return a DIFFERENT account,
   * and nothing in the token response says whose it is — so the callback compares this
   * against `whoami` before anything is persisted. Null for an ordinary login, where any
   * account the user picks is the right answer.
   */
  expectedUserId: string | null;
}

/** The single-use OIDC stash read back on the callback (each field may be absent). */
export interface OidcStateStash {
  state: string | null;
  baseUrl: string | null;
  mode: LoginMode;
  redirectUri: string | null;
  issuer: string | null;
  clientId: string | null;
  deviceId: string | null;
  codeVerifier: string | null;
  expectedUserId: string | null;
}

const EMPTY_STASH: OidcStateStash = {
  state: null,
  baseUrl: null,
  mode: 'replace',
  redirectUri: null,
  issuer: null,
  clientId: null,
  deviceId: null,
  codeVerifier: null,
  expectedUserId: null,
};

/**
 * Persists the OIDC PKCE round-trip state across the authorization redirect via Capacitor
 * Preferences (localStorage on web, native key-value on device).
 *
 * **This store is now the sole custodian of that state.** matrix-js-sdk 42 dropped
 * `oidc-client-ts`, and its replacement persists nothing at all — where this store
 * previously shuttled a copy of the SDK's `mx_oidc_<state>` sessionStorage entry, there is
 * no longer anything to copy. Preferences also survives a native/Electron process eviction
 * and reaches the app's WebView after a system-browser round-trip, so a cold-start
 * deep-link callback can still complete the token exchange.
 *
 * SECURITY: unlike {@link SsoStateStore} (which holds only a non-secret nonce),
 * `codeVerifier` here is the PKCE **code_verifier** — a short-lived secret. It is
 * single-use ({@link peek} then {@link clear}, only once the callback's state matches),
 * time-boxed (10 min), and never logged. Do not extend the TTL or reuse the stash.
 *
 * It is now written on **every** platform, not just native/Electron. Before, web relied on
 * the SDK's own sessionStorage copy; with that gone, skipping the write would simply break
 * web login. On web that means localStorage — accepted, because the single-use + TTL
 * discipline above is the mitigation, and script that can read localStorage can read
 * sessionStorage in the same document anyway.
 */
@Injectable({ providedIn: 'root' })
export class OidcStateStore {
  private readonly storage = inject(DevicePreferenceStorageService);

  /** Stash the round-trip state before redirecting to the OIDC provider. */
  async save(params: OidcStateSave): Promise<void> {
    await firstValueFrom(
      this.storage.setMany([
        { key: STATE_KEY, value: params.state },
        { key: BASE_URL_KEY, value: params.baseUrl },
        { key: STARTED_KEY, value: String(Date.now()) },
        { key: MODE_KEY, value: params.mode },
        { key: REDIRECT_URI_KEY, value: params.redirectUri },
        { key: ISSUER_KEY, value: params.issuer },
        { key: CLIENT_ID_KEY, value: params.clientId },
        { key: DEVICE_ID_KEY, value: params.deviceId },
        { key: CODE_VERIFIER_KEY, value: params.codeVerifier },
        ...(params.expectedUserId
          ? [{ key: EXPECTED_USER_ID_KEY, value: params.expectedUserId }]
          : []),
      ]),
    );
    // Absent rather than empty for an ordinary login, so a stale value can never be
    // read back as an expectation.
    if (!params.expectedUserId) {
      await firstValueFrom(this.storage.remove(EXPECTED_USER_ID_KEY));
    }
  }

  /**
   * Read the stash WITHOUT clearing it, returning an empty stash when nothing was saved
   * or it is older than the TTL. The callback verifies the returned state against this
   * before {@link clear}ing — so a forged/mismatched callback (any app can fire the
   * shared deep-link scheme) can't wipe an in-flight login's stash.
   */
  async peek(): Promise<OidcStateStash> {
    const [
      state,
      baseUrl,
      startedAt,
      mode,
      redirectUri,
      issuer,
      clientId,
      deviceId,
      codeVerifier,
      expectedUserId,
    ] = await firstValueFrom(
      this.storage.getMany([
        STATE_KEY,
        BASE_URL_KEY,
        STARTED_KEY,
        MODE_KEY,
        REDIRECT_URI_KEY,
        ISSUER_KEY,
        CLIENT_ID_KEY,
        DEVICE_ID_KEY,
        CODE_VERIFIER_KEY,
        EXPECTED_USER_ID_KEY,
      ]),
    );

    const started = Number(startedAt);
    const age = Date.now() - started;
    // Two-sided on purpose. `age <= TTL_MS` alone treats a FUTURE timestamp as fresh, so a
    // stash written while the device clock was ahead — or nudged forward by any means —
    // would never expire and would keep serving a live code_verifier indefinitely. A
    // negative age is not a young stash, it is an untrustworthy one.
    const fresh =
      Number.isFinite(started) && age >= -CLOCK_SKEW_MS && age <= TTL_MS;
    if (!fresh) {
      // Bin it rather than just refusing to serve it. The stash holds the PKCE
      // code_verifier — a secret — in plaintext, and the TTL is only enforced here at READ
      // time, so an abandoned login leaves it on disk until something reads or overwrites
      // it. It is spent either way; a secret should not outlive its purpose. Best-effort:
      // a failed cleanup must not turn a "nothing stashed" answer into a rejection.
      //
      // This does NOT weaken the verify-before-clear contract: that exists so a forged
      // callback cannot wipe a LIVE stash, and this one is already dead.
      await this.clear().catch(() => undefined);
      return EMPTY_STASH;
    }
    return {
      state,
      baseUrl,
      mode: mode === 'add' ? 'add' : 'replace',
      redirectUri,
      issuer,
      clientId,
      deviceId,
      codeVerifier,
      expectedUserId,
    };
  }

  /** Remove every OIDC-state key. */
  async clear(): Promise<void> {
    await firstValueFrom(
      this.storage.removeMany([
        STATE_KEY,
        BASE_URL_KEY,
        STARTED_KEY,
        MODE_KEY,
        REDIRECT_URI_KEY,
        ISSUER_KEY,
        CLIENT_ID_KEY,
        DEVICE_ID_KEY,
        CODE_VERIFIER_KEY,
        EXPECTED_USER_ID_KEY,
        ...LEGACY_KEYS,
      ]),
    );
  }
}
