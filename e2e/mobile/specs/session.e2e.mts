import { browser, expect } from '@wdio/globals';
import { resetApp, webviewVersion, native } from '../support/session.mts';

describe('mobile session', () => {
  it('reaches the app WebView and records the WebView version', async () => {
    await native();
    const version = await webviewVersion();
    console.log(`[mobile] Android System WebView: ${version}`);
    await resetApp();
    const contexts = (await browser.getContexts()).map(String);
    expect(contexts).toContain('WEBVIEW_eu.qwky.trinity');
    expect(await browser.getContext()).toBe('WEBVIEW_eu.qwky.trinity');
    await expect($('label=Homeserver')).toBeDisplayed();
  });
});
