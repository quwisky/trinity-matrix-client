import { browser, expect } from '@wdio/globals';
import { native, resetApp, webviewVersion } from '../support/session.mts';

describe('mobile session', () => {
  it('reaches the app WebView and records the WebView version', async () => {
    await native();
    const version = await webviewVersion();
    console.log(
      `[mobile] ${browser.isIOS ? 'WKWebView' : 'Android System WebView'}: ${version}`,
    );
    await resetApp();
    const context = String(await browser.getContext());
    if (browser.isIOS) {
      // WKWebView ships with the OS, and Web Inspector names contexts by pid and page.
      expect(version).toMatch(/^iOS \d+\.\d+/u);
      expect(context).toMatch(/^WEBVIEW_\d+\.\d+$/u);
      // iOS 27 reports the root page without the trailing slash iOS 26 includes.
      expect(await browser.getUrl()).toMatch(/^capacitor:\/\/localhost(\/|$)/u);
    } else {
      expect((await browser.getContexts()).map(String)).toContain(
        'WEBVIEW_eu.qwky.trinity',
      );
      expect(context).toBe('WEBVIEW_eu.qwky.trinity');
    }
    await expect($('label=Homeserver')).toBeDisplayed();
  });
});
