import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  homeserverSession,
  login,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';

// Covers deleting a message in an encrypted room: once redacted, the event's only type is the
// wire type m.room.encrypted, and its row must read "(message deleted)" both live and when it
// comes back already redacted after a reload. Needs a Synapse homeserver; self-skips.
const session = homeserverSession();

test.describe('Deleting a message in an encrypted room', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test('keeps a deleted row, live and after a reload', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ed`;
    const user = `encrypted-delete-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Encrypted delete ${runId}`;
    const body = `a message to delete ${runId}`;
    const kept = `a message to keep ${runId}`;

    await registerUser(request, user, pass);
    const { accessToken } = await passwordLogin(request, hs, user, pass);
    const headers = { Authorization: `Bearer ${accessToken}` };
    const { room_id: roomId } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          initial_state: [
            {
              type: 'm.room.encryption',
              state_key: '',
              content: { algorithm: 'm.megolm.v1.aes-sha2' },
            },
          ],
        },
      })
      .then((r) => r.json());
    expect(roomId).toBeTruthy();

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    const composer = page.locator('textarea.composer__input').first();
    for (const text of [body, kept]) {
      await composer.click();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      await expect(
        page.locator('.scroll .msg[data-mid^="$"]', { hasText: text }),
      ).toBeVisible({ timeout: 30_000 });
    }

    const row = page.locator('.scroll .msg[data-mid]', { hasText: body });
    const eventId = await row.getAttribute('data-mid');
    await clickRowMenuItem(row, page.getByTestId('msg-delete'));
    await page.getByTestId('alert-confirm').click();

    const deleted = page.locator(`.scroll .msg[data-mid="${eventId}"]`);
    await expect(deleted).toContainText('(message deleted)', {
      timeout: 30_000,
    });
    await expect(page.locator('.scroll .msg', { hasText: body })).toHaveCount(
      0,
    );

    // The server holds it as a redacted encrypted event, so the row isn't a plain-room case.
    const stored = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId as string)}`,
        { headers },
      )
      .then((r) => r.json());
    expect(stored.type).toBe('m.room.encrypted');
    expect(stored.unsigned.redacted_because).toBeTruthy();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(deleted).toContainText('(message deleted)', {
      timeout: 60_000,
    });
    await expect(page.locator('.scroll .msg', { hasText: kept })).toBeVisible();
    await expect(page.locator('.scroll .msg', { hasText: body })).toHaveCount(
      0,
    );
  });
});
