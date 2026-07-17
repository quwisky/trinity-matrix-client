import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { type LoginMode } from '@trinity/data-access-auth';

const STATE_KEY = 'oidc.state';
const BASE_URL_KEY = 'oidc.baseUrl';
const STARTED_KEY = 'oidc.startedAt';
const MODE_KEY = 'oidc.mode';
const REDIRECT_URI_KEY = 'oidc.redirectUri';
const ISSUER_KEY = 'oidc.issuer';
const SESSION_STATE_KEY_KEY = 'oidc.ssKey';
const SESSION_STATE_BLOB_KEY = 'oidc.ssBlob';

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
  /** The sessionStorage key the SDK stored the sign-in state under (`mx_oidc_<state>`). */
  sessionStateKey: string;
  /** The serialized sign-in state to re-seed before the token exchange, or null. */
  sessionStateBlob: string | null;
}

/** The single-use OIDC stash read back on the callback (each field may be absent). */
export interface OidcStateStash {
  state: string | null;
  baseUrl: string | null;
  mode: LoginMode;
  redirectUri: string | null;
  issuer: string | null;
  sessionStateKey: string | null;
  sessionStateBlob: string | null;
}

const EMPTY_STASH: OidcStateStash = {
  state: null,
  baseUrl: null,
  mode: 'replace',
  redirectUri: null,
  issuer: null,
  sessionStateKey: null,
  sessionStateBlob: null,
};

/**
 * Persists the OIDC PKCE round-trip state across the authorization redirect via Capacitor
 * Preferences (localStorage on web, native key-value on device). Unlike `sessionStorage` —
 * where matrix-js-sdk/oidc-client-ts natively keeps the sign-in state — Preferences
 * survives a native/Electron process eviction and reaches the app's WebView after a
 * system-browser round-trip, so a cold-start deep-link callback can re-seed sessionStorage
 * and complete the token exchange.
 *
 * SECURITY: unlike {@link SsoStateStore} (which holds only a non-secret nonce), the
 * `sessionStateBlob` here contains the PKCE **code_verifier** — a short-lived secret. It
 * is single-use ({@link peek} then {@link clear}, only once the callback's state matches),
 * time-boxed (10 min), and never logged. Do not extend the TTL or reuse the stash.
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
      Preferences.set({
        key: SESSION_STATE_KEY_KEY,
        value: params.sessionStateKey,
      }),
      // Set the blob, or REMOVE any residue from a prior un-consumed attempt — never
      // leave a stale code_verifier paired with this attempt's fresh state/key.
      params.sessionStateBlob !== null
        ? Preferences.set({
            key: SESSION_STATE_BLOB_KEY,
            value: params.sessionStateBlob,
          })
        : Preferences.remove({ key: SESSION_STATE_BLOB_KEY }),
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
      ssKey,
      ssBlob,
    ] = await Promise.all([
      Preferences.get({ key: STATE_KEY }),
      Preferences.get({ key: BASE_URL_KEY }),
      Preferences.get({ key: STARTED_KEY }),
      Preferences.get({ key: MODE_KEY }),
      Preferences.get({ key: REDIRECT_URI_KEY }),
      Preferences.get({ key: ISSUER_KEY }),
      Preferences.get({ key: SESSION_STATE_KEY_KEY }),
      Preferences.get({ key: SESSION_STATE_BLOB_KEY }),
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
      sessionStateKey: ssKey.value ?? null,
      sessionStateBlob: ssBlob.value ?? null,
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
      Preferences.remove({ key: SESSION_STATE_KEY_KEY }),
      Preferences.remove({ key: SESSION_STATE_BLOB_KEY }),
    ]);
  }
}
