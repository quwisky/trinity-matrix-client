import { browser, expect } from '@wdio/globals';
import { HS_TLS } from '../../support/synapse/start.mjs';
import { APP_PACKAGE, native, webview } from './session.mts';

/** Fill an input through its `<label for>`, like the browser suite's fillLabeledInput. */
export async function fillByLabel(label: string, value: string): Promise<void> {
  const id = await browser.waitUntil(
    async () =>
      browser.execute((text: string) => {
        const match = [...document.querySelectorAll('label')].find(
          (l) => l.textContent?.trim() === text,
        );
        return match?.htmlFor || false;
      }, label),
    { timeout: 30_000, timeoutMsg: `no label "${label}"` },
  );
  const input = $(`#${id}`);
  await input.click();
  await input.setValue(value);
}

/** Wait for the stable, account-qualified Rooms destination (mirrors the browser suite). */
export async function waitForRooms(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const url = new URL(await browser.getUrl());
      return (
        url.pathname === '/rooms' &&
        (url.searchParams.get('account')?.length ?? 0) > 0
      );
    },
    { timeout: 30_000, timeoutMsg: 'never reached /rooms?account=…' },
  );
}

export async function login(user: string, pass: string): Promise<void> {
  await fillByLabel('Homeserver', HS_TLS);
  const next = $('//button[normalize-space()="Continue"]');
  await expect(next).toBeDisplayed({ wait: 30_000 });
  await next.click();
  const signIn = $('//button[normalize-space()="Sign in"]');
  await expect(signIn).toBeDisplayed({ wait: 30_000 });
  await fillByLabel('Username', user);
  await fillByLabel('Password', pass);
  await signIn.click();
  await waitForRooms();
}

/** One W3C touch tap, which reaches the WebView as a gesture (a plain click does not raise the IME). */
export async function tap(selector: string): Promise<void> {
  const target = $(selector);
  await target.scrollIntoView({ block: 'center' });
  await browser
    .action('pointer', { parameters: { pointerType: 'touch' } })
    .move({ origin: target })
    .down()
    .up()
    .perform();
}

/**
 * Capacitor Preferences resolves after SharedPreferences.apply(), whose disk write is
 * asynchronous. Observe the on-disk Active Account before a process kill so a restart test
 * proves restoration, not a race with Android persistence.
 */
export async function waitForDurableActiveAccount(
  accountId: string,
): Promise<void> {
  const expected = `activeUserId&quot;:&quot;${accountId}`;
  await native();
  try {
    let registry = '';
    await browser.waitUntil(
      async () => {
        registry = String(
          await browser.execute('mobile: shell', {
            command: 'run-as',
            args: [APP_PACKAGE, 'cat', 'shared_prefs/CapacitorStorage.xml'],
          }),
        );
        return registry.includes(expected);
      },
      {
        timeout: 10_000,
        interval: 50,
        timeoutMsg: `Active Account ${accountId} was not durable before process restart`,
      },
    );
  } finally {
    await webview();
  }
}
