import { test, expect, type APIRequestContext } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers "Mark all as read" (data-testid="mark-all-read"): with an unread room the header
// action appears; clicking it acks every room (RoomsService.markAllRead) so it disappears.
// Another user sends a message so there's something unread. Needs Synapse (Docker).
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

test.describe('Mark as read', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('mark all as read clears the unread indicator', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}mr`;
    const me = `mr-me-${runId}`;
    const mePass = `${me}-pass`;
    const sender = `mr-sender-${runId}`;
    const senderPass = `${sender}-pass`;
    const roomName = `Unread ${runId}`;

    await registerUser(request, me, mePass);
    await registerUser(request, sender, senderPass);
    const author = await apiLogin(request, hs, me, mePass);
    const other = await apiLogin(request, hs, sender, senderPass);

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: author.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [other.userId],
        },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: other.headers },
    );
    // The other user posts a message so the room is unread for me.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-msg`,
      { headers: other.headers, data: { msgtype: 'm.text', body: 'ping' } },
    );

    await login(page, {
      available: true,
      hs,
      user: me,
      pass: mePass,
    } as SynapseSession);
    // The room is a regular (non-DM) room — switch to the Rooms view so it's listed.
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: roomName }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // With an unread room, the header "Mark all as read" appears; click it and it clears.
    const markAll = page.getByTestId('mark-all-read');
    await expect(markAll).toBeVisible({ timeout: 30_000 });
    await markAll.click();
    await expect(markAll).toBeHidden({ timeout: 20_000 });
  });
});
