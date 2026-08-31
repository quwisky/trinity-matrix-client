import { test, expect, type Page } from './support/fixtures.mts';
import {
  clickRowMenuItem,
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers reporting a message: a message's ⋯ menu (data-testid="msg-more") offers
// "Report message" (data-testid="msg-report"), which prompts for a reason
// (data-testid="alert-confirm") and reports it to the room's server admins
// (ReportService → RoomModerationService.reportMessage → client.reportEvent),
// surfacing a success toast. Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

test.describe('Report a message', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('reports a message to the server admins', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}r`;
    const user = `report-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Report E2E ${runId}`;
    const body = `report me ${runId}`;

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
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${access_token}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}1`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
        data: { msgtype: 'm.text', body },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const row = page.locator('.scroll .msg[data-mid]', { hasText: body });
    await row.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Hover → ⋯ → Report message → confirm the reason prompt.
    if (isAndroidE2E) {
      const sheet = await openMessageActionSheet(page, row.first());
      await sheet.getByTestId('sheet-report').click();
    } else {
      await clickRowMenuItem(row.first(), page.getByTestId('msg-report'));
    }
    await page.getByTestId('alert-confirm').click();

    await expect(page.getByText('Reported to the server admins.')).toBeVisible({
      timeout: 30_000,
    });
  });
});
