import {
  testResourceId,
  expect,
  test,
  type APIResponse,
  type Page,
} from './fixtures.mts';

import { passwordLogin } from '../support/account.mts';
import { login, synapseSession, type Navigate } from '../support/app.mts';
import { launchApp } from './support/launch.mts';

const session = synapseSession();

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

/**
 * Fail with the server's answer only when a request failed. A custom `expect`
 * message is the report step title even when the assertion passes, so a
 * successful login response, access token included, never becomes one.
 */
async function requireOk(
  response: APIResponse,
  operation: string,
): Promise<void> {
  if (!response.ok())
    throw new Error(
      `${operation} → ${response.status()} ${await response.text()}`,
    );
}

test.describe('Electron room-link preview', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('opens room information as a centered desktop dialog', async ({
    request,
  }) => {
    test.slow();
    const runId = testResourceId('run');
    const { accessToken } = await passwordLogin(
      request,
      session.hs as string,
      session.user as string,
      session.pass as string,
    );
    const headers = { Authorization: `Bearer ${accessToken}` };
    const createRoom = async (name: string): Promise<string> => {
      const response = await request.post(
        `${session.hs}/_matrix/client/v3/createRoom`,
        { headers, data: { name } },
      );
      await requireOk(response, `create room ${name}`);
      return ((await response.json()) as { room_id: string }).room_id;
    };
    const sourceName = `Electron link source ${runId}`;
    const targetName = `Electron link target ${runId}`;
    const sourceId = await createRoom(sourceName);
    const targetId = await createRoom(targetName);
    const send = await request.put(
      `${session.hs}/_matrix/client/v3/rooms/${encodeURIComponent(sourceId)}/send/m.room.message/link-${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: `Open ${targetName}`,
          format: 'org.matrix.custom.html',
          formatted_body: `<a href="https://matrix.to/#/${targetId}">Open ${targetName}</a>`,
        },
      },
    );
    await requireOk(send, 'send the room link');

    const app = await launchApp();
    try {
      const page = await app.firstWindow();
      await login(page, session, electronNavigate);
      await page.getByTestId('rail-rooms').click();
      const source = page.locator('.channel', { hasText: sourceName }).first();
      await source.waitFor({ state: 'visible', timeout: 30_000 });
      await source.click();
      await page.getByRole('link', { name: `Open ${targetName}` }).click();

      const preview = page.getByTestId('room-link-preview');
      await expect(preview).toBeVisible({ timeout: 20_000 });
      await expect(preview.getByTestId('room-link-name')).toHaveText(
        targetName,
      );
      await expect(preview.getByTestId('room-link-primary')).toHaveText(
        'Open room',
      );
      await expect(page.getByTestId('composer-input')).toHaveAttribute(
        'placeholder',
        new RegExp(sourceName),
      );
      await expect(page.locator('trn-room-link-preview')).not.toHaveClass(
        /room-link-preview--sheet/,
      );

      const box = await preview.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(box).not.toBeNull();
      expect(
        Math.abs(box!.x + box!.width / 2 - viewport.width / 2),
      ).toBeLessThan(3);
      expect(
        Math.abs(box!.y + box!.height / 2 - viewport.height / 2),
      ).toBeLessThan(3);
    } finally {
      await app.close();
    }
  });
});
