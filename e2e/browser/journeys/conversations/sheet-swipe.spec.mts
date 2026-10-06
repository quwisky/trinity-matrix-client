import {
  testResourceId,
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { touchLongPress } from '../../../support/touch-platform.mts';

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
  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json());
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

test.describe('Swipe a sheet to close it', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 90_000 });

  // The refused-dismissGuard snap-back has no journey: the only guarded dialogs (room and
  // space settings, room upgrade) are not shell sheets or need a run in flight. The shell
  // and directive specs cover it against the real close path.
  test('dragging the handle down closes the message action sheet', async ({
    page,
    request,
  }) => {
    const rowSel = await openRoomWithMessage(page, request, 'swipe');
    await touchLongPress(page, page.locator(rowSel).first());

    const sheet = page.getByTestId('action-sheet-surface');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    const box = await page.getByTestId('sheet-handle').boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 150, { steps: 5 });
    await page.mouse.move(x, y + 300, { steps: 5 });
    await page.mouse.up();

    await expect(sheet).toBeHidden({ timeout: 10_000 });
  });
});
