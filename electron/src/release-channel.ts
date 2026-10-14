/**
 * Release channels of the desktop app and the identity each one installs under.
 *
 * Shared by the main process (compiled with the rest of src/) and by
 * electron-builder.config.ts (loaded by electron-builder's TypeScript loader), so
 * packaging and runtime cannot disagree about which app a version is. preload.ts mirrors
 * the renderer-facing fields by value, because a sandboxed preload cannot import it.
 */
export type ReleaseChannel = 'stable' | 'next';

export interface ChannelIdentity {
  /** macOS bundle ID, Windows AppUserModelID and the seed of the NSIS uninstall GUID. */
  readonly appId: string;
  /** App name: the .app, Start menu entry, launcher entry and the user-data folder. */
  readonly productName: string;
  /** OS URL scheme of the SSO/OIDC callback and app links. */
  readonly deepLinkScheme: string;
  /** Display name of a Matrix device this app signs in. */
  readonly displayName: string;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NEXT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-next\.(0|[1-9]\d*)$/;

/**
 * `stable` for a plain X.Y.Z version, `next` for X.Y.Z-next.N. Any other shape throws,
 * so a mistyped version can never package or run under the stable identity.
 */
export function releaseChannel(version: string): ReleaseChannel {
  if (STABLE_VERSION.test(version)) return 'stable';
  if (NEXT_VERSION.test(version)) return 'next';
  throw new Error(
    `Unknown release channel for version "${version}": expected X.Y.Z or X.Y.Z-next.N.`,
  );
}

export const CHANNEL_IDENTITY: Readonly<
  Record<ReleaseChannel, ChannelIdentity>
> = {
  stable: {
    appId: 'dev.trinityproject.trinity',
    productName: 'Trinity',
    deepLinkScheme: 'dev.trinityproject.trinity',
    displayName: 'Trinity',
  },
  next: {
    appId: 'dev.trinityproject.trinity.next',
    productName: 'Trinity Next',
    deepLinkScheme: 'dev.trinityproject.trinity.next',
    displayName: 'Trinity Next',
  },
};
