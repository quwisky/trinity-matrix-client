import { describe, expect, it } from 'vitest';
import { describePlatform } from './platform-description';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  firefoxLinux:
    'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  iosWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36',
  electronMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Trinity/0.4.0 Chrome/140.0.0.0 Electron/38.2.1 Safari/537.36',
};

describe('describePlatform', () => {
  it.each([
    [UA.chromeMac, 'Web, Chrome 141 on macOS'],
    [UA.firefoxLinux, 'Web, Firefox 141 on Linux'],
    [UA.safariIphone, 'Web, Safari 18.5 on iOS 18.5'],
    [UA.edgeWindows, 'Web, Edge 141 on Windows'],
  ])('names the browser and OS on the web', (userAgent, expected) => {
    expect(
      describePlatform({ host: 'web', userAgent, desktopPlatform: null }),
    ).toBe(expected);
  });

  it('names the installed app and its OS version on iOS and Android', () => {
    expect(
      describePlatform({
        host: 'ios',
        userAgent: UA.iosWebView,
        desktopPlatform: null,
      }),
    ).toBe('iOS app, iOS 26.5');
    expect(
      describePlatform({
        host: 'android',
        userAgent: UA.androidWebView,
        desktopPlatform: null,
      }),
    ).toBe('Android app, Android 15');
  });

  it('names Electron and the host OS on desktop', () => {
    expect(
      describePlatform({
        host: 'desktop',
        userAgent: UA.electronMac,
        desktopPlatform: 'darwin',
      }),
    ).toBe('Desktop (Electron 38.2.1), macOS');
  });
});
