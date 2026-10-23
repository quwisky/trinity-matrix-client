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
