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

/**
 * Why FrontBoard refused a launch: its error codes, outermost first, and its outer failure
 * reason, e.g. `RequestDenied > NotFound: The request was denied … unknown to FrontBoard`.
 */
export function frontBoardReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const codes = [...message.matchAll(/BSErrorCodeDescription=(\w+)/g)].map(
    (match) => match[1],
  );
  // The outer reason follows its nested error in the text, so it is the last one.
  const reason = [
    ...message.matchAll(/NSLocalizedFailureReason=(.*?)(?=, NS|, FBS|\}|$)/gm),
  ].at(-1)?.[1];
  if (codes.length === 0 && !reason)
    return message.split('\n')[0]!.slice(0, 160);
  return [codes.join(' > '), reason].filter(Boolean).join(': ');
}

/**
 * `defaults delete` refused a domain cfprefsd does not hold: iOS 26.5 prints
 * `Domain (…) not found.`, older releases `Domain … does not exist`. Nothing is cached to
 * flush, so the reset can go on.
 */
export function isAbsentDefaultsDomain(error: unknown): boolean {
  const { stderr = '', message = String(error) } = (error ?? {}) as {
    stderr?: string;
    message?: string;
  };
  return /Domain .* (?:not found|does not exist)/u.test(
    `${stderr}\n${message}`,
  );
}
