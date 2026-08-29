import { expect, test, type Page } from '@playwright/test';

import {
  login,
  synapseSession,
  type Navigate,
} from '../playwright/support/app.mts';
import { passwordLogin, registerUser } from '../playwright/support/account.mts';
import { launchApp } from './support/launch.mts';

const session = synapseSession();

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

test.describe('Electron member clipboard', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('copies the exact full user ID through the real member action', async ({
    request,
  }) => {
    const hs = session.hs as string;
    const runId = Date.now().toString(36);
    const username = `clipboard-user-${runId}-${'long'.repeat(20)}`;
    const password = `${username}-pass`;
    const displayName = `Clipboard display ${runId}`;
    const roomName = `Clipboard room ${runId}`;

    await registerUser(request, username, password);
    const account = await passwordLogin(request, hs, username, password);
    const headers = {
      Authorization: `Bearer ${account.accessToken}`,
    };
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(account.userId)}/displayname`,
      { headers, data: { displayname: displayName } },
    );
    const roomResponse = await request.post(
      `${hs}/_matrix/client/v3/createRoom`,
      {
        headers,
        data: {
          name: roomName,
          preset: 'private_chat',
        },
      },
    );
    expect(roomResponse.ok()).toBe(true);

    const app = await launchApp();
    try {
      await app.evaluate(({ clipboard }) => clipboard.clear());
      const page = await app.firstWindow();
      await login(
        page,
        { available: true, hs, user: username, pass: password },
        electronNavigate,
      );
      await page.getByTestId('rail-rooms').click();
      const room = page
        .locator('button.channel', { hasText: roomName })
        .first();
      await room.waitFor({ state: 'visible', timeout: 30_000 });
      await room.click();

      const members = page.locator('.members');
      if (!(await members.isVisible().catch(() => false))) {
        await page.getByTestId('toggle-members').click();
      }
      // Opening the panel intentionally replaces the member list, detaching this row
      // during Playwright's post-click stability check. Click the live row synchronously;
      // the Copy action below remains a real user click, which is the behavior this journey
      // exists to verify.
      await expect
        .poll(
          () =>
            page.evaluate((name) => {
              const row = [
                ...document.querySelectorAll<HTMLElement>(
                  '[data-testid=member-row]',
                ),
              ].find((candidate) => candidate.textContent?.includes(name));
              row?.click();
              return Boolean(row);
            }, displayName),
          { timeout: 20_000 },
        )
        .toBe(true);

      const handle = page.getByTestId('member-info-handle');
      await expect(handle).toHaveText(account.userId);
      const handleLayout = await handle.evaluate((node) => ({
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }));
      expect(handleLayout.scrollWidth).toBeLessThanOrEqual(
        handleLayout.clientWidth + 1,
      );
      await expect
        .poll(() =>
          handle.evaluate((node) => getComputedStyle(node).userSelect),
        )
        .toBe('text');
      await handle.focus();
      await expect
        .poll(() => page.evaluate(() => getSelection()?.toString()))
        .toBe(account.userId);
      await page.getByTestId('member-info-copy').click();
      await expect(
        page.getByText('User ID copied.', { exact: true }),
      ).toBeVisible();

      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(account.userId);
    } finally {
      await app.evaluate(({ clipboard }) => clipboard.clear()).catch(() => {});
      await app.close();
    }
  });
});
