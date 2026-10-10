const MEGABYTE = 1_048_576;

/**
 * The largest file the composer takes on a phone app when the homeserver states no limit. A
 * file is read whole into the WebView before it uploads, and an encrypted room holds about two
 * copies at peak; the Android and iOS WebViews have the least memory to hold them in.
 */
const NATIVE_MOBILE_FALLBACK_BYTES = 256 * MEGABYTE;
/** The same ceiling for browsers and the desktop app, which have more memory to spare. */
const DEFAULT_FALLBACK_BYTES = 512 * MEGABYTE;

/** What a file sent from this composer may weigh, and who decided it. */
export type UploadLimit =
  /** The homeserver stated `m.upload.size`; it governs even above the device ceiling. */
  | { readonly source: 'homeserver'; readonly bytes: number }
  /** The homeserver stated nothing, or could not be asked in time: this device's ceiling. */
  | { readonly source: 'device'; readonly bytes: number };

/** What the composer refuses to read into memory when the homeserver gives no limit. */
export function fallbackUploadBytes(nativeMobile: boolean): number {
  return nativeMobile ? NATIVE_MOBILE_FALLBACK_BYTES : DEFAULT_FALLBACK_BYTES;
}

/** The homeserver's limit when it states one, else this device's ceiling. */
export function effectiveUploadLimit(
  homeserverBytes: number | null,
  nativeMobile: boolean,
): UploadLimit {
  return homeserverBytes === null
    ? { source: 'device', bytes: fallbackUploadBytes(nativeMobile) }
    : { source: 'homeserver', bytes: homeserverBytes };
}

/**
 * The refusal for `count` files over `limit`. Names the homeserver only when its limit applied,
 * so a device ceiling is never passed off as the server's.
 */
export function tooLargeMessage(
  kind: 'photo' | 'video' | 'file',
  limit: UploadLimit,
  count = 1,
): string {
  const subject = count === 1 ? `That ${kind} is` : `${count} ${kind}s are`;
  const size = formatMegabytes(limit.bytes);
  const reason =
    limit.source === 'homeserver'
      ? `Your homeserver accepts files up to ${size}.`
      : `Trinity can send files up to ${size} on this device.`;
  return `${subject} too large to send. ${reason}`;
}

/** A byte limit as whole megabytes for copy ("100 MB"); never "0 MB". */
function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MEGABYTE))} MB`;
}
