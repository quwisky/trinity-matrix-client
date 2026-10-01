import { browser, expect } from '@wdio/globals';
import { resetApp } from '../support/session.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import { login } from '../support/app.mts';

describe('mobile smoke', () => {
  beforeEach(resetApp);

  it('logs in, opens a room, sends a message and sees it arrive', async () => {
    const user = uniqueId('smoke');
    const pass = 'smoke-pass-123';
    await registerUser(user, pass);
    const roomName = `Smoke ${user}`;
    await createRoom(await accessToken(user, pass), roomName);

    await login(user, pass);
    await $('[data-testid="rail-rooms"]').click();
    await $(
      `//*[contains(@class,"channel")][contains(.,"${roomName}")]`,
    ).click();
    const composer = $('[data-testid="composer-input"]');
    await expect(composer).toBeDisplayed();
    const body = `hello from ${user}`;
    await composer.click();
    await browser.keys(body);
    await browser.keys('Enter');
    const row = $(
      `//*[contains(@class,"scroll")]//*[contains(@class,"msg")][contains(.,"${body}")]`,
    );
    await expect(row).toBeDisplayed({ wait: 20_000 });
    // Mirrors waitForSent: the local echo's `~` id is replaced by the server's `$` id.
    await browser.waitUntil(
      async () => ((await row.getAttribute('data-mid')) ?? '').startsWith('$'),
      { timeout: 20_000, timeoutMsg: 'message never reached the homeserver' },
    );
  });
});
