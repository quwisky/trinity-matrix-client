import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'webdriverio';

/** The smoke assertion crosses the actual login UI and Matrix session boundary. */
export async function signInRunnerSmoke(
  browser: Browser,
  account: {
    readonly username: string;
    readonly password: string;
    readonly homeserver: string;
  },
  artifactDirectory: string,
): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  try {
    await browser.$('#homeserver').waitForDisplayed({ timeout: 60_000 });
    await browser.$('#homeserver').setValue(account.homeserver);
    await browser.$('button=Continue').click();
    await browser.$('#username').waitForDisplayed({ timeout: 30_000 });
    await browser.$('#username').setValue(account.username);
    await browser.$('#password').setValue(account.password);
    await browser.$('button=Sign in').click();
    await browser.waitUntil(
      async () =>
        (await browser.getUrl()).includes('/rooms') &&
        (await browser.$('body').getText()).includes('Recent activity'),
      { timeout: 60_000, timeoutMsg: 'Authenticated Rooms did not appear' },
    );
    assert(
      (await browser.$('body').getText()).includes(account.username),
      'Rooms exposes the registered account',
    );
    await browser.saveScreenshot(join(artifactDirectory, 'rooms.png'));
  } catch (error) {
    await browser
      .saveScreenshot(join(artifactDirectory, 'failure.png'))
      .catch(() => undefined);
    await browser
      .getPageSource()
      .then((source) =>
        writeFile(join(artifactDirectory, 'failure.html'), source),
      )
      .catch(() => undefined);
    throw error;
  }
}
