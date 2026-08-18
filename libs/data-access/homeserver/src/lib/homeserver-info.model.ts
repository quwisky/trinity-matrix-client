/**
 * What a homeserver says about itself, projected for the Server settings section.
 *
 * These are Trinity's own types on purpose. The SDK's `IServerVersions` and `Capabilities`
 * would be the obvious things to hand out, but feature libs may not import `matrix-js-sdk`
 * at all (`eslint.config.mjs`), so an SDK type crossing this lib's barrel is a boundary
 * leak. Same reasoning as `export type { SyncState }` in `@trinity/data-access/matrix-client`.
 */

/** Which of the two probe attempts answered. */
export type SoftwareSource = 'base-url' | 'delegated';

/** The server's own account of what software it is running. */
export interface ServerSoftware {
  /** What the server calls itself — `Synapse`, `Dendrite`, `conduwuit`, … */
  readonly name: string;
  /**
   * Its version, **verbatim**. Deliberately not parsed: this is not semver, and
   * matrix.org answers `1.158.0 (b=matrix-org-hotfixes-priv,5569b9e479)` — where the build
   * suffix is the informative half for anyone checking whether a deploy landed.
   */
  readonly version: string;
  /** Where the answer came from, so the UI can say which host was reached. */
  readonly source: SoftwareSource;
  /** The origin that answered. */
  readonly host: string;
}

/** The two bits of `/_matrix/client/v3/capabilities` worth showing. */
export interface HomeserverCapabilities {
  /** The room version this server creates rooms at, or null when it does not say. */
  readonly defaultRoomVersion: string | null;
  /** Whether this server allows changing the password here; null when it does not say. */
  readonly canChangePassword: boolean | null;
}

/**
 * Everything known about one account's homeserver.
 *
 * Every remote field is nullable and every null means the same thing — **asked, no usable
 * answer** — because the probe resolves rather than throws (see `probe-homeserver.ts`).
 * "Not asked yet" is the absence of the whole record, not a null inside one.
 */
export interface HomeserverInfo {
  /** The account this describes. */
  readonly userId: string;
  /** The server name from the mxid: `example.org` for `@a:example.org`. */
  readonly serverName: string;
  /** The client base URL this account actually talks to. */
  readonly baseUrl: string;
  /**
   * Whether {@link baseUrl} is something other than `https://<serverName>` — i.e. the
   * homeserver was discovered rather than being the server name itself.
   *
   * An observation, not a claim about the mechanism. Trinity does not record whether
   * `.well-known` delegation was used (nothing in `MatrixSession` carries it, and
   * `AuthService.discoverHomeserver` returns a bare string), and a hand-typed URL that
   * happens to differ is indistinguishable from delegation. The UI therefore shows both
   * values and lets the reader draw the conclusion, rather than asserting `.well-known`.
   */
  readonly discovered: boolean;
  /** The federation endpoint's answer, or null when neither attempt produced one. */
  readonly software: ServerSoftware | null;
  /** Spec versions the server advertises, or null when the call gave nothing usable. */
  readonly specVersions: readonly string[] | null;
  /** The unstable feature flags the server advertises as **on**, or null. */
  readonly unstableFeatures: readonly string[] | null;
  /** The capabilities worth showing, or null. */
  readonly capabilities: HomeserverCapabilities | null;
}
