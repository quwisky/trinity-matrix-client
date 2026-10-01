import { browser, expect } from '@wdio/globals';
import { resetApp } from '../support/session.mts';

/** In-app navigation like the Android Playwright layer: pushState plus popstate, no reload. */
async function navigate(path: string): Promise<void> {
  const target = new URL(path, await browser.getUrl()).href;
  await browser.execute((url: string) => {
    const state = {
      ...window.history.state,
      navigationId:
        typeof window.history.state?.navigationId === 'number'
          ? window.history.state.navigationId + 1
          : 1,
    };
    window.history.pushState(state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  }, target);
}

describe('Android app shell', () => {
  beforeEach(resetApp);

  it('renders login and protects authenticated routes in the installed app', async () => {
    await navigate('/login');
    await expect(
      $('//input[@id=//label[normalize-space()="Homeserver"]/@for]'),
    ).toBeDisplayed({
      wait: 20_000,
    });
    await expect($('//*[normalize-space(text())="Continue"]')).toBeDisplayed();

    await navigate('/settings');
    await browser.waitUntil(
      async () => new URL(await browser.getUrl()).pathname.endsWith('/login'),
      { timeout: 20_000, timeoutMsg: 'never redirected to /login' },
    );
    await expect(browser).toHaveUrl(expect.stringMatching(/\/login/u));
  });
});
