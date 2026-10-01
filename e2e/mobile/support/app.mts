import { browser, expect } from '@wdio/globals';
import { HS_TLS } from '../../support/synapse/start.mjs';

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
