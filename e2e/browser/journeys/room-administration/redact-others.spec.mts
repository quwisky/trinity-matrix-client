import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers moderator redaction: a room admin (power 100, the creator) can delete
// ANOTHER user's message. TimelineService.canRedactOthers compares the user's
// power level to the room's `redact` requirement; when sufficient, the message
// toolbar's ⋯ menu exposes "Delete message" (data-testid="msg-delete") on other
// people's rows (MessageListBase widens `deletable` beyond own messages). Deleting
// redacts the event, so the row renders "(message deleted)".
//
// Two users: an admin (creates the room) and a member (posts a message the admin
// then redacts). The member posts over the API so the flow under test is purely
// the admin's UI redaction. Unencrypted room so the member can post via the API
// and the admin reads plaintext. Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

test.describe('Moderator redaction', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a room admin can delete another member’s message', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}m`;

    const adminUser = `mod-admin-${runId}`;
    const adminPass = `${adminUser}-pass`;
    const memberUser = `mod-member-${runId}`;
    const memberPass = `${memberUser}-pass`;
    const roomName = `Redact E2E ${runId}`;
    const memberBody = `msg from member ${runId}`;

    await registerUser(request, adminUser, adminPass);
    await registerUser(request, memberUser, memberPass);
    const admin = await apiLogin(request, hs, adminUser, adminPass);
    const member = await apiLogin(request, hs, memberUser, memberPass);

    // Admin creates an unencrypted room and invites the member.
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: admin.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [member.userId],
        },
      })
      .then((r) => r.json());

    // Member joins and posts a message over the API.
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: member.headers },
    );
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}1`,
      {
        headers: member.headers,
        data: { msgtype: 'm.text', body: memberBody },
      },
    );

    // Admin signs in and opens the room.
    await login(page, {
      available: true,
      hs,
      user: adminUser,
      pass: adminPass,
    } as SynapseSession);
    await openRoom(page, roomName);

    // The member's message is present.
    const row = page.locator('.scroll .msg[data-mid]', { hasText: memberBody });
    await row.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Reveal the hover toolbar → ⋯ menu → "Delete message" (offered because the
    // admin has redact power over others), then confirm the destructive dialog.
    if (isAndroidE2E) {
      const sheet = await openMessageActionSheet(page, row.first());
      await sheet.getByTestId('sheet-delete').click();
    } else {
      await clickRowMenuItem(row.first(), page.getByTestId('msg-delete'));
    }
    await page.getByTestId('alert-confirm').click();

    // The message is redacted: the row now reads "(message deleted)" and the
    // original body is gone.
    await expect(
      page.locator('.scroll .msg', { hasText: '(message deleted)' }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('.scroll .msg', { hasText: memberBody }),
    ).toHaveCount(0);
  });
});
