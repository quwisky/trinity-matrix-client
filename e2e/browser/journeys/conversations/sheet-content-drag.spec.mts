import {
  testResourceId,
  test,
  expect,
  devices,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  sheetAtRest,
  touchLongPress,
} from '../../../support/touch-platform.mts';
import { createRoom } from '../../support/space-journey.mts';

const session = homeserverSession();

/** Open a seeded room and hand back the newest row's stable selector. */
async function openRoomWithMessage(
  page: Page,
  request: APIRequestContext,
  tag: string,
  messageCount = 1,
): Promise<string> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
  const user = `sheet-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Sheet ${runId}`;

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
  const room_id = await createRoom(
    request,
    hs,
    { accessToken: access_token },
    roomName,
  );
  for (let i = 0; i < messageCount - 1; i++) {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/s-${runId}-${i}`,
      {
        headers,
        data: { msgtype: 'm.text', body: `sheet filler ${tag} ${i}` },
      },
    );
  }
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/s-${runId}`,
    { headers, data: { msgtype: 'm.text', body: `act on me ${runId}` } },
  );

  await login(page, { available: true, hs, user, pass } as HomeserverSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });

  const row = page.locator('.msg[data-mid]').last();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  return `.msg[data-mid="${await row.getAttribute('data-mid')}"]`;
}

test.use({ ...devices['Pixel 5'] });

test.describe('Drag a sheet by its content to close it', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 90_000 });

  async function openSheet(
    page: Page,
    request: APIRequestContext,
    tag: string,
  ): Promise<Locator> {
    const rowSel = await openRoomWithMessage(page, request, tag);
    await touchLongPress(page, page.locator(rowSel).first());
    const sheet = page.getByTestId('action-sheet-surface');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheetAtRest(sheet);
    return sheet;
  }

  async function centre(target: Locator): Promise<{ x: number; y: number }> {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  }

  test('a downward drag on content at the top closes the sheet', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const sheet = await openSheet(page, request, 'cd');
    const from = await centre(page.getByTestId('sheet-reply'));

    await touchPlatform.swipe(page, from, { x: from.x, y: from.y + 300 });

    await expect(sheet).toBeHidden({ timeout: 10_000 });
  });

  test('a small drag springs back and the sheet stays open', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const sheet = await openSheet(page, request, 'cs');
    const restingTop = (await sheet.boundingBox())!.y;
    const from = await centre(page.getByTestId('sheet-reply'));

    await touchPlatform.swipe(page, from, { x: from.x, y: from.y + 40 });

    await expect(sheet).toBeVisible();
    await expect
      .poll(async () => (await sheet.boundingBox())!.y, { timeout: 5_000 })
      .toBeCloseTo(restingTop, 0);
  });

  test('content scrolled down scrolls instead of closing the sheet', async ({
    page,
    request,
    touchPlatform,
  }) => {
    await page.setViewportSize({ width: 393, height: 380 });
    const sheet = await openSheet(page, request, 'cc');
    const scroller = sheet.locator('.overflow-y-auto');
    const scrollable = await scroller.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    expect(scrollable).toBeGreaterThan(40);
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const before = await scroller.evaluate((el) => el.scrollTop);
    const from = await centre(scroller);

    await touchPlatform.swipe(page, from, { x: from.x, y: from.y + 120 });

    await expect(sheet).toBeVisible();
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(before);
  });

  test('a tap on an action still acts at once', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const sheet = await openSheet(page, request, 'ct');

    await touchPlatform.tap(page, page.getByTestId('sheet-reply'));

    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      { timeout: 10_000 },
    );
  });
});
