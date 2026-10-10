/** Pure parsers for the WebView and chromedriver versions every mobile run reports. */

export function parseWebViewVersion(dumpsys: string): string {
  return (
    /Current WebView package \(name, version\): \(([^)]+)\)/.exec(
      dumpsys,
    )?.[1] ?? 'unknown'
  );
}

/** The chromedriver Appium started, or why it found none, from Appium's server log. */
export function chromedriverFromAppiumLog(log: string): string {
  const started = [...log.matchAll(/Chromedriver version: (\S+)/g)].at(-1);
  if (started) return started[1]!;
  const candidates = [
    ...log.matchAll(/\(version '([^']+)', minimum Chrome version/g),
  ].map((match) => match[1]);
  if (candidates.length > 0) {
    return `none compatible among ${[...new Set(candidates)].join(', ')}`;
  }
  const missing = [
    ...log.matchAll(/No Chromedrivers were found in '([^']+)'/g),
  ].at(-1);
  return missing ? `none found in ${missing[1]}` : 'unknown';
}

/** Name both versions on a failed WebView switch, keeping the original error as the cause. */
export function webviewSwitchError(
  context: string,
  versions: { readonly webview: string; readonly chromedriver: string },
  cause: unknown,
): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Could not switch to ${context} (Android System WebView ${versions.webview}; ` +
      `chromedriver ${versions.chromedriver}): ${message}`,
    { cause },
  );
}

/**
 * iOS launch race after a reinstall: FrontBoard has not registered the app yet (NotFound),
 * or still refuses to open it (RequestDenied), seen on iOS 27 right after a kill and relaunch.
 * iOS 26.5 can also report the NotFound lookup wrapped in InvalidRequest.
 */
export function isAppNotYetKnown(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('is unknown to FrontBoard') ||
    // iOS 26.5 can wrap the same race as InvalidRequest over a NotFound application lookup.
    message.includes('(FBSApplicationLibrary) returned nil') ||
    (message.includes('FBSOpenApplicationServiceErrorDomain') &&
      message.includes('RequestDenied'))
  );
}
