import { browser, expect } from '@wdio/globals';
import { HS_TLS } from '../../support/homeserver/start.mjs';
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
  // Every mobile journey signs in a freshly registered account, whose crypto state
  // resolves after the Rooms shell renders and mounts this banner above it. Its arrival
  // pushes the rail and lists down, so wait for it before any tap is aimed: a tap that
  // only checked stability before the banner existed lands on whatever slid under it.
  await expect(
    $('//trn-banner[contains(normalize-space(.),"Set up encryption")]'),
  ).toBeDisplayed({ wait: 30_000 });
}

/**
 * Wait until `element` holds still and is what a tap at its centre would hit: the same
 * client rect across two animation frames, and its centre hit-tests to itself or a
 * descendant. This is Playwright's "stable" and "receives events" actionability. Banners
 * that arrive after sign-in push the whole layout down, so a tap aimed at a row's old
 * position otherwise lands on whatever moved there.
 */
async function waitUntilTappable(
  element: WebdriverIO.Element,
  selector: string,
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (target: HTMLElement) =>
          new Promise<boolean>((resolve) => {
            const first = target.getBoundingClientRect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const second = target.getBoundingClientRect();
                const still =
                  first.x === second.x &&
                  first.y === second.y &&
                  first.width === second.width &&
                  first.height === second.height;
                const hit = document.elementFromPoint(
                  second.x + second.width / 2,
                  second.y + second.height / 2,
                );
                resolve(
                  still && second.width > 0 && !!hit && target.contains(hit),
                );
              }),
            );
          }),
        element as unknown as HTMLElement,
      ),
    {
      timeout: 20_000,
      timeoutMsg: `${selector} never held still under its own tap point`,
    },
  );
}

/**
 * One W3C touch tap, which reaches the WebView as a gesture (a plain click does not
 * raise the IME). It waits for the target to be tappable first (see
 * {@link waitUntilTappable}). Lists re-render as sync updates arrive, so an element
 * found by `selector` can go stale before the pointer action lands; re-query and
 * retry then.
 */
export async function tap(selector: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const target = $(selector);
      await target.scrollIntoView({ block: 'center' });
      await waitUntilTappable(await target.getElement(), selector);
      await browser
        .action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ origin: target })
        .down()
        .up()
        .perform();
      return;
    } catch (error) {
      if (attempt >= 3 || !/stale element/i.test(String(error))) throw error;
    }
  }
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
