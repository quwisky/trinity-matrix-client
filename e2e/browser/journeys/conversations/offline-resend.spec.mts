import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { apiLogin, registerUser } from '../../../support/account.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';
import { createRoom } from '../../support/space-journey.mts';

// A message sent while offline waits in the timeline and goes out by itself, exactly once
// and in order, when the connection returns. Needs a Synapse homeserver.
const session = homeserverSession();

async function seed(request: APIRequestContext, hs: string, runId: string) {
  const user = `offline-${runId}`;
  const pass = `offline-${runId}-pass`;
  const roomName = `Offline ${runId}`;
  await registerUser(request, user, pass);
  const api = await apiLogin(request, hs, user, pass);
  const roomId = await createRoom(
    request,
    hs,
    { accessToken: api.accessToken },
    roomName,
  );
  return {
    reader: { available: true as const, hs, user, pass },
    roomName,
    /** Bodies of the room's messages, oldest first, as the homeserver has them. */
    async bodies(): Promise<string[]> {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=f&limit=50`,
        { headers: api.headers },
      );
      const { chunk } = (await res.json()) as {
        chunk: { type: string; content: { body?: string } }[];
      };
      return chunk
        .filter((e) => e.type === 'm.room.message')
        .map((e) => e.content.body ?? '');
    },
  };
}

async function sendOffline(page: Page, texts: readonly string[]) {
  await page.context().setOffline(true);
  for (const text of texts) {
    await sendComposerLines(page, [text]);
    await expect(
      page.locator('.msg', { hasText: text }).getByText('Waiting to send'),
    ).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByTestId('composer-input')).toHaveValue('');
}

test.describe('Offline resend', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test('messages sent offline go out once, in order, on reconnect', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}o`;
    const room = await seed(request, session.hs as string, runId);
    const first = `first ${runId}`;
    const second = `second ${runId}`;

    await login(page, room.reader);
    await openNamedRoom(page, room.roomName);

    await sendOffline(page, [first, second]);
    await expect(
      page.locator('.banner__text', { hasText: '2 messages waiting to send' }),
    ).toBeVisible();

    await page.context().setOffline(false);

    await expect(page.getByText('Waiting to send')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(
      page.locator('.banner__text', { hasText: /waiting to send/ }),
    ).toHaveCount(0);
    await expect(page.locator('.msg', { hasText: first })).toHaveCount(1);
    await expect(page.locator('.msg', { hasText: second })).toHaveCount(1);

    await expect
      .poll(room.bodies, { timeout: 60_000 })
      .toEqual([first, second]);
    expect(await room.bodies()).toEqual([first, second]);
  });

  test('a refused message stays out of the box and survives a reload, then Retry sends it once, Delete asks first and Edit takes it back', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}r`;
    const room = await seed(request, session.hs as string, runId);
    const refused = `refused ${runId}`;
    const deleted = `deleted ${runId}`;
    const edited = `edited ${runId}`;
    const composer = page.getByTestId('composer-input');
    const sendRoute = '**/_matrix/client/v3/rooms/*/send/**';

    await login(page, room.reader);
    await openNamedRoom(page, room.roomName);
    await page.route(sendRoute, (route) =>
      route.fulfill({
        status: 403,
        json: { errcode: 'M_FORBIDDEN', error: 'refused for the test' },
      }),
    );
    for (const text of [refused, deleted, edited]) {
      await sendComposerLines(page, [text]);
      await expect(
        page.locator('.msg', { hasText: text }).getByText(/Failed to send/),
      ).toBeVisible({ timeout: 30_000 });
    }
    await expect(composer).toHaveValue('');
    await page.unroute(sendRoute);

    await page.reload();
    await openNamedRoom(page, room.roomName);
    await expect(composer).toHaveValue('');
    const failed = page.locator('.msg', { hasText: refused });
    await expect(failed.getByText(/Failed to send/)).toBeVisible({
      timeout: 30_000,
    });
    await page
      .locator('.msg', { hasText: deleted })
      .getByTestId('msg-delete-unsent')
      .click();
    // Its text exists nowhere else, so Delete asks first.
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ hasText: 'Delete unsent message' });
    await expect(confirm).toContainText('its text will be lost');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.msg', { hasText: deleted })).toHaveCount(0);
    await failed.getByText(/Failed to send/).click();

    await expect.poll(room.bodies, { timeout: 60_000 }).toEqual([refused]);
    await expect(page.locator('.msg', { hasText: refused })).toHaveCount(1);
    await expect(composer).toHaveValue('');
    expect(await room.bodies()).toEqual([refused]);

    // Edit takes the last one out of the timeline and back into the box, to change it.
    await page
      .locator('.msg', { hasText: edited })
      .getByTestId('msg-edit-unsent')
      .click();
    await expect(composer).toHaveValue(edited);
    await expect(page.locator('.msg', { hasText: edited })).toHaveCount(0);
    await expect(page.getByText(/Failed to send/)).toHaveCount(0);
    expect(await room.bodies()).toEqual([refused]);
  });

  test('a cancelled offline message is never sent', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}c`;
    const room = await seed(request, session.hs as string, runId);
    const cancelled = `cancelled ${runId}`;
    const kept = `kept ${runId}`;

    await login(page, room.reader);
    await openNamedRoom(page, room.roomName);

    await sendOffline(page, [cancelled, kept]);
    await page
      .locator('.msg', { hasText: cancelled })
      .getByRole('button', { name: /^Cancel sending/ })
      .click();
    await expect(page.locator('.msg', { hasText: cancelled })).toHaveCount(0);

    await page.context().setOffline(false);
    // Only the resend pass can deliver `kept`, and it would send `cancelled` first.
    await expect.poll(room.bodies, { timeout: 60_000 }).toEqual([kept]);
    expect(await room.bodies()).toEqual([kept]);
  });
});
