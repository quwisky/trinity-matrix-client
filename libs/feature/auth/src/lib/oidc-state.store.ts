import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { type LoginMode } from '@trinity/data-access/auth';

const STATE_KEY = 'oidc.state';
const BASE_URL_KEY = 'oidc.baseUrl';
const STARTED_KEY = 'oidc.startedAt';
const MODE_KEY = 'oidc.mode';
const REDIRECT_URI_KEY = 'oidc.redirectUri';
const ISSUER_KEY = 'oidc.issuer';
const CLIENT_ID_KEY = 'oidc.clientId';
const DEVICE_ID_KEY = 'oidc.deviceId';
const CODE_VERIFIER_KEY = 'oidc.codeVerifier';
/**
 * Written by versions before matrix-js-sdk 42, when the SDK kept the sign-in state in
 * sessionStorage and this store shuttled an opaque copy of it. Nothing writes them now,
 * and the blob held a PKCE code_verifier in plaintext — so {@link OidcStateStore.clear}
 * purges them rather than leaving an abandoned one on disk forever. Drop in a later release.
 */
const LEGACY_KEYS = ['oidc.ssKey', 'oidc.ssBlob'] as const;

/** OIDC round-trips are short; reject a stash older than this to limit replay. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes

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
  /** Stash the round-trip state before redirecting to the OIDC provider. */
  async save(params: OidcStateSave): Promise<void> {
    await Promise.all([
      Preferences.set({ key: STATE_KEY, value: params.state }),
      Preferences.set({ key: BASE_URL_KEY, value: params.baseUrl }),
      Preferences.set({ key: STARTED_KEY, value: String(Date.now()) }),
      Preferences.set({ key: MODE_KEY, value: params.mode }),
      Preferences.set({ key: REDIRECT_URI_KEY, value: params.redirectUri }),
      Preferences.set({ key: ISSUER_KEY, value: params.issuer }),
      Preferences.set({ key: CLIENT_ID_KEY, value: params.clientId }),
      Preferences.set({ key: DEVICE_ID_KEY, value: params.deviceId }),
      Preferences.set({ key: CODE_VERIFIER_KEY, value: params.codeVerifier }),
    ]);
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
    ] = await Promise.all([
      Preferences.get({ key: STATE_KEY }),
      Preferences.get({ key: BASE_URL_KEY }),
      Preferences.get({ key: STARTED_KEY }),
      Preferences.get({ key: MODE_KEY }),
      Preferences.get({ key: REDIRECT_URI_KEY }),
      Preferences.get({ key: ISSUER_KEY }),
      Preferences.get({ key: CLIENT_ID_KEY }),
      Preferences.get({ key: DEVICE_ID_KEY }),
      Preferences.get({ key: CODE_VERIFIER_KEY }),
    ]);

    const started = Number(startedAt.value);
    const fresh = Number.isFinite(started) && Date.now() - started <= TTL_MS;
    if (!fresh) {
      // Bin it rather than just refusing to serve it. On native/Electron the blob holds
      // the PKCE code_verifier — a secret — in app-private PLAINTEXT, and the TTL was
      // only ever enforced here at READ time, so an abandoned login left it on disk
      // until some later save() happened to overwrite it. It is spent either way; a
      // secret should not outlive its purpose. Best-effort: a failed cleanup must not
      // turn a "nothing stashed" answer into a rejection.
      //
      // This does NOT weaken the verify-before-clear contract: that exists so a forged
      // callback cannot wipe a LIVE stash, and this one is already dead.
      await this.clear().catch(() => undefined);
      return EMPTY_STASH;
    }
    return {
      state: state.value ?? null,
      baseUrl: baseUrl.value ?? null,
      mode: mode.value === 'add' ? 'add' : 'replace',
      redirectUri: redirectUri.value ?? null,
      issuer: issuer.value ?? null,
      clientId: clientId.value ?? null,
      deviceId: deviceId.value ?? null,
      codeVerifier: codeVerifier.value ?? null,
    };
  }

  /** Remove every OIDC-state key. */
  async clear(): Promise<void> {
    await Promise.all([
      Preferences.remove({ key: STATE_KEY }),
      Preferences.remove({ key: BASE_URL_KEY }),
      Preferences.remove({ key: STARTED_KEY }),
      Preferences.remove({ key: MODE_KEY }),
      Preferences.remove({ key: REDIRECT_URI_KEY }),
      Preferences.remove({ key: ISSUER_KEY }),
      Preferences.remove({ key: CLIENT_ID_KEY }),
      Preferences.remove({ key: DEVICE_ID_KEY }),
      Preferences.remove({ key: CODE_VERIFIER_KEY }),
      ...LEGACY_KEYS.map((key) => Preferences.remove({ key })),
    ]);
  }
}
