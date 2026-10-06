import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// #986 K6: the hover toolbar belongs to the row under the pointer, and only that row.
const session = homeserverSession();
const toolbars = 'trn-message-toolbar';

// Text rows only: the first `.msg` may be the collapsed system-run summary.
const textRows = (page: Page) =>
  page.locator('.scroll .msg[data-mid]', { has: page.locator('.msg__text') });

test.describe('Message toolbar tracking', () => {
  test.skip(!session.available, 'needs a homeserver (Docker)');

  test.beforeEach(async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}t`;
    const user = `toolbar-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Toolbar E2E ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const headers = { Authorization: `Bearer ${access_token}` };
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    // 40 messages, sent in order, so the list scrolls.
    for (let i = 1; i <= 40; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}${i}`,
        {
          headers,
          data: { msgtype: 'm.text', body: `toolbar line ${i} ${runId}` },
        },
      );
    }

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await channel.waitFor({ state: 'visible', timeout: 30_000 });
    await channel.click();
    await expect(
      textRows(page).filter({ hasText: `toolbar line 40 ${runId}` }),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test('scrolling under a still pointer moves the toolbar with the row under it', async ({
    page,
  }) => {
    const target = textRows(page).nth(-3);
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(toolbars)).toHaveCount(1);
    const hoveredId = await target.getAttribute('data-mid');

    await page.mouse.wheel(0, -400); // scroll; the pointer does not move
    await page.waitForTimeout(400);
    const under = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[data-mid]')
          ?.getAttribute('data-mid') ?? null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(under).not.toBe(hoveredId);
    await expect(page.locator(toolbars)).toHaveCount(1);
    await expect(page.locator(`[data-mid="${under}"] ${toolbars}`)).toHaveCount(
      1,
    );
  });

  test('a clicked row gives up its toolbar when another row is hovered', async ({
    page,
  }) => {
    const rows = textRows(page);
    await rows.nth(-2).click({ position: { x: 10, y: 10 } });
    const other = rows.nth(-5);
    await other.hover();
    await expect(page.locator(toolbars)).toHaveCount(1);
    await expect(other.locator(toolbars)).toHaveCount(1);
  });
});
