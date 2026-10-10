import { describe, expect, it } from 'vitest';
import {
  chromedriverFromAppiumLog,
  isAppNotYetKnown,
  parseWebViewVersion,
  webviewSwitchError,
} from '../e2e/mobile/support/versions.mts';

const dir = '/repo/.appium/chromedriver';

describe('mobile E2E version reporting', () => {
  it('reads the active WebView provider from dumpsys', () => {
    expect(
      parseWebViewVersion(
        'Current WebView package (name, version): (com.google.android.webview, 133.0.6943.137)\n',
      ),
    ).toBe('com.google.android.webview, 133.0.6943.137');
    expect(parseWebViewVersion('no provider')).toBe('unknown');
  });

  it('reports the chromedriver Appium started, after an earlier empty-dir scan', () => {
    const log = [
      `[Chromedriver@4a75] No Chromedrivers were found in '${dir}'`,
      `[Chromedriver@4a75]     '${dir}/chromedriver-linux64_v133.0.6943.141' (version '133.0.6943.141', minimum Chrome version '133')`,
      '[Chromedriver@4a75] Chromedriver version: 133.0.6943.141',
    ].join('\n');
    expect(chromedriverFromAppiumLog(log)).toBe('133.0.6943.141');
  });

  it('names incompatible candidates, an empty directory, or an unknown driver', () => {
    expect(
      chromedriverFromAppiumLog(
        `'${dir}/chromedriver_v120' (version '120.0.6099.109', minimum Chrome version '120')`,
      ),
    ).toBe('none compatible among 120.0.6099.109');
    expect(
      chromedriverFromAppiumLog(`No Chromedrivers were found in '${dir}'`),
    ).toBe(`none found in ${dir}`);
    expect(chromedriverFromAppiumLog('')).toBe('unknown');
  });

  it('names both versions and keeps the original switch error', () => {
    const cause = new Error(
      'No Chromedriver found that can automate Chrome 133',
    );
    const error = webviewSwitchError(
      'WEBVIEW_dev.trinityproject.trinity',
      {
        webview: 'com.google.android.webview, 133.0.6943.137',
        chromedriver: `none found in ${dir}`,
      },
      cause,
    );
    expect(error.message).toBe(
      'Could not switch to WEBVIEW_dev.trinityproject.trinity (Android System WebView ' +
        `com.google.android.webview, 133.0.6943.137; chromedriver none found in ${dir}): ` +
        'No Chromedriver found that can automate Chrome 133',
    );
    expect(error.cause).toBe(cause);
  });
});

describe('iOS launch race classifier', () => {
  it('retries only FrontBoard not-found and launch-refused errors', () => {
    expect(
      isAppNotYetKnown(
        new Error(
          'FBSOpenApplicationErrorDomain Code=4 "Application "dev.trinityproject.trinity" is unknown to FrontBoard." (NotFound)',
        ),
      ),
    ).toBe(true);
    expect(
      isAppNotYetKnown(
        new Error(
          'Error Domain=FBSOpenApplicationServiceErrorDomain Code=1 "The request to open "dev.trinityproject.trinity" failed." UserInfo={BSErrorCodeDescription=RequestDenied}',
        ),
      ),
    ).toBe(true);
    // The iOS 26.5 nightly on 2026-10-10 reported the same just-installed race this way.
    expect(
      isAppNotYetKnown(
        new Error(
          'Error Domain=FBSOpenApplicationServiceErrorDomain Code=4 "The request to open "dev.trinityproject.trinity" failed." UserInfo={BSErrorCodeDescription=InvalidRequest, NSUnderlyingError=0x1 {Error Domain=FBSOpenApplicationErrorDomain Code=4 "Application info provider (FBSApplicationLibrary) returned nil for "dev.trinityproject.trinity"" UserInfo={BSErrorCodeDescription=NotFound}}}',
        ),
      ),
    ).toBe(true);
    expect(
      isAppNotYetKnown(
        new Error(
          'Error Domain=FBSOpenApplicationServiceErrorDomain Code=4 "The request to open "dev.trinityproject.trinity" failed." UserInfo={BSErrorCodeDescription=InvalidRequest}',
        ),
      ),
    ).toBe(false);
    expect(isAppNotYetKnown(new Error('RequestDenied by the proxy'))).toBe(
      false,
    );
    expect(isAppNotYetKnown(new Error('socket hang up'))).toBe(false);
    expect(isAppNotYetKnown('is unknown to FrontBoard')).toBe(true);
  });
});
