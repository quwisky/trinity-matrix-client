import { describe, expect, it } from 'vitest';
import { pickAppWebview } from './appium-contexts.mts';

const app = {
  origin: 'capacitor://localhost',
  bundleId: 'dev.trinityproject.trinity',
};

describe('pickAppWebview', () => {
  it('picks the app’s own page among Safari’s, without switching into any', () => {
    expect(
      pickAppWebview(
        [
          { id: 'NATIVE_APP' },
          {
            id: 'WEBVIEW_201.3',
            url: 'https://matrix.to/#/!room:hs',
            bundleId: 'com.apple.mobilesafari',
          },
          {
            id: 'WEBVIEW_77.1',
            url: 'capacitor://localhost/rooms',
            bundleId: 'dev.trinityproject.trinity',
          },
        ],
        app,
      )?.id,
    ).toBe('WEBVIEW_77.1');
  });

  it('skips the app’s page while it is still blank', () => {
    expect(
      pickAppWebview(
        [{ id: 'WEBVIEW_77.1', url: 'about:blank', bundleId: app.bundleId }],
        app,
      ),
    ).toBeNull();
  });

  it('never takes another app’s page, even one showing the app’s origin', () => {
    expect(
      pickAppWebview(
        [
          {
            id: 'WEBVIEW_201.3',
            url: 'capacitor://localhost/',
            bundleId: 'com.apple.mobilesafari',
          },
        ],
        app,
      ),
    ).toBeNull();
  });

  it('judges a context with no bundle id by its URL', () => {
    expect(
      pickAppWebview(
        [{ id: 'WEBVIEW_77.1', url: 'capacitor://localhost/login' }],
        app,
      )?.id,
    ).toBe('WEBVIEW_77.1');
  });
});
