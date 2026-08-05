import {
  OAuth2,
  TokenRefresher,
  createClient,
  type TokenRefreshFunction,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import type { SessionStorageService } from '@trinity/platform-native';
import type { OidcSessionBinding } from '@trinity/util/matrix';

/** What one account's {@link TrinityOidcTokenRefresher} needs to rebuild its OAuth2 client. */
export interface TrinityOidcTokenRefresherOptions {
  storage: SessionStorageService;
  /** The account whose rotated tokens get persisted. */
  userId: string;
  /** The account's homeserver — auth metadata is discovered through it, not the issuer. */
  baseUrl: string;
  binding: OidcSessionBinding;
  deviceId: string;
}

/**
 * Per-account OIDC token refresher. matrix-js-sdk calls the client's
 * `tokenRefreshFunction` when the access token nears expiry or a request 401s; the SDK's
 * {@link TokenRefresher} performs the refresh-token grant and hands the new tokens to the
 * `onRefresh` callback, which is where they get written back through
 * {@link SessionStorageService}.
 *
 * Composition, not inheritance — matrix-js-sdk 42 replaced the subclassable
 * `OidcTokenRefresher` (whose `persistTokens` we overrode) with a class that takes an
 * {@link OAuth2} and a callback. That removes two hazards the old shape carried: a
 * positional 5-argument `super(...)` reached through
 * `ConstructorParameters<typeof OidcTokenRefresher>[4]`, and an `expiry` field the base
 * passed at runtime but omitted from the declared parameter type, read back through a
 * cast. `AccessTokens.expiry` is now declared, so it cannot silently go missing.
 *
 * The metadata is resolved LAZILY and memoized, because the client is constructed
 * synchronously (see MatrixClientService.start) while discovery is a network call. The
 * promise is memoized rather than the result so two concurrent 401s do one discovery —
 * and a rejection clears it, so a transient discovery failure does not wedge refresh for
 * the lifetime of the session.
 *
 * It closes over ONLY `userId` + the storage service (never the client registry or the
 * active account): a refresh can fire on the first authenticated request during crypto
 * bootstrap, before `startClient`, when no client is registered yet. One instance per
 * account keeps a rotated token from being persisted under another account's key.
 *
 * SECURITY (accepted risk): `binding.clientId` / `binding.redirectUri` come from the
 * non-secret account registry (Capacitor Preferences), and discovery goes through the
 * account's own homeserver. Tampering with that registry would need write access, which
 * on web (localStorage) already yields the refresh token directly, and on native/Electron
 * is app-private storage that a non-compromised device denies. So it grants no capability
 * an attacker with that access lacks; not hardened further here.
 */
export class TrinityOidcTokenRefresher {
  private pending?: Promise<TokenRefresher>;

  // Named, not positional: `userId`, `baseUrl` and `deviceId` are all plain strings, so a
  // positional list let any two of them be transposed with the type checker none the wiser
  // — and swapping the first two would point discovery at a user id, breaking refresh for
  // every OIDC account until the account soft-logged out.
  constructor(private readonly options: TrinityOidcTokenRefresherOptions) {}

  /** Pass straight to `createClient({ tokenRefreshFunction })`. */
  readonly tokenRefreshFunction: TokenRefreshFunction = async (
    refreshToken: string,
  ) => {
    const refresher = await (this.pending ??= this.build().catch(
      (err: unknown) => {
        this.pending = undefined;
        throw err;
      },
    ));
    const tokens = await refresher.tokenRefreshFunction(refreshToken);
    // Rotating the refresh token is a SHOULD, not a MUST (RFC 6749 §6, and the Matrix
    // refresh-token grant), so a spec-legal provider may return only a new access token.
    // The SDK passes that through as `refreshToken: undefined`, and FetchHttpApi then
    // does `opts.refreshToken = refreshToken` UNCONDITIONALLY — leaving the live client
    // with none, so the next expiry logs the account out and the soft-logout handler
    // deletes the still-valid token from disk. Carry the current one forward instead.
    // (Storage needs no such guard: updateTokens already skips an undefined.)
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  };

  private async build(): Promise<TokenRefresher> {
    const { storage, userId, baseUrl, binding, deviceId } = this.options;
    // Discovery goes through the homeserver, not the issuer: matrix-js-sdk 42 dropped the
    // issuer well-known probe along with the `/auth_issuer` fallback.
    const metadata = await createClient({ baseUrl }).getAuthMetadata();
    const auth = new OAuth2(metadata, {
      clientId: binding.clientId,
      redirectUri: binding.redirectUri,
      deviceId,
    });
    return new TokenRefresher(auth, (tokens) =>
      firstValueFrom(
        storage.updateTokens(
          userId,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiry?.getTime(),
        ),
      ),
    );
  }
}
