import { OidcTokenRefresher } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import type { SessionStorageService } from '@trinity/platform-native';
import type { OidcSessionBinding } from '@trinity/util/matrix';

/** The SDK's `IdTokenClaims` param type, extracted without importing oidc-client-ts. */
type SdkIdTokenClaims = ConstructorParameters<typeof OidcTokenRefresher>[4];

/**
 * Per-account OIDC token refresher. matrix-js-sdk calls the client's
 * `tokenRefreshFunction` (backed by {@link doRefreshAccessToken}) when the access token
 * nears expiry or a request 401s, and the base class persists nothing — so we override
 * {@link persistTokens} to write the rotated tokens back through {@link SessionStorageService}.
 *
 * It closes over ONLY `userId` + the storage service (never the client registry or the
 * active account): a refresh can fire on the first authenticated request during crypto
 * bootstrap, before `startClient`, when no client is registered yet. One instance per
 * account keeps a rotated token from being persisted under another account's key.
 *
 * SECURITY (accepted risk): `binding.issuer` — which decides where the refresh token is
 * POSTed — comes from the non-secret account registry (Capacitor Preferences). Tampering
 * it to redirect tokens to an attacker would need registry write access, which on web
 * (localStorage) already yields the refresh token directly, and on native/Electron is
 * app-private storage that a non-compromised device denies. So it grants no capability an
 * attacker with that access lacks; not hardened further here.
 */
export class TrinityOidcTokenRefresher extends OidcTokenRefresher {
  constructor(
    private readonly storage: SessionStorageService,
    private readonly userId: string,
    binding: OidcSessionBinding,
    deviceId: string,
  ) {
    super(
      binding.issuer,
      binding.clientId,
      binding.redirectUri,
      deviceId,
      binding.idTokenClaims as SdkIdTokenClaims,
    );
  }

  protected override async persistTokens(tokens: {
    accessToken: string;
    refreshToken?: string;
  }): Promise<void> {
    // The declared type omits `expiry`, but the SDK passes it at runtime (see the base
    // class's getNewTokens) — read it to keep the persisted access-token expiry fresh.
    const expiry = (tokens as { expiry?: Date }).expiry;
    await firstValueFrom(
      this.storage.updateTokens(
        this.userId,
        tokens.accessToken,
        tokens.refreshToken,
        expiry ? expiry.getTime() : undefined,
      ),
    );
  }
}
