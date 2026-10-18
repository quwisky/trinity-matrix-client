import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  passwordLogin,
  registerUser,
  type AccountSession,
} from '../../../support/account.mts';

// Covers reporting to the reporter's own server admins (ReportService):
// - a message, from its ⋯ menu (RoomModerationService.reportMessage → reportEvent);
// - a room, from the room header's ⋮ menu (ContentReportingService.reportRoom), whose
//   confirmation offers "Leave room";
// - a user, from their member card (ContentReportingService.reportUser), whose
//   confirmation offers "Block {name}".
//   Unblocking them from the card shows what they sent while blocked, with no reload.
const session = homeserverSession();

const auth = (account: AccountSession) => ({
  Authorization: `Bearer ${account.accessToken}`,
});

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

async function setUp(
  request: APIRequestContext,
  suffix: string,
  withOther = false,
) {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${suffix}`;
  const user = `report-user-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Report E2E ${runId}`;
  await registerUser(request, user, pass);
  const me = await passwordLogin(request, hs, user, pass);
  let other: AccountSession | null = null;
  const otherName = `Reported ${runId}`;
  if (withOther) {
    const otherUser = `report-other-${runId}`;
    await registerUser(request, otherUser, `${otherUser}-pass`);
    other = await passwordLogin(request, hs, otherUser, `${otherUser}-pass`);
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(other.userId)}/displayname`,
      { headers: auth(other), data: { displayname: otherName } },
    );
  }
  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: auth(me),
      data: {
        name: roomName,
        preset: 'private_chat',
        ...(other ? { invite: [other.userId] } : {}),
      },
    })
    .then((r) => r.json());
  if (other) {
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: auth(other) },
    );
  }
  return { hs, runId, user, pass, me, other, otherName, roomName, room_id };
}

test.describe('Report to your server admins', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('reports a message', async ({ page, request }) => {
    const { hs, runId, user, pass, me, roomName, room_id } = await setUp(
      request,
      'm',
    );
    const body = `report me ${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}1`,
      { headers: auth(me), data: { msgtype: 'm.text', body } },
    );

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    const row = page.locator('.scroll .msg[data-mid]', { hasText: body });
    await row.first().waitFor({ state: 'visible', timeout: 20_000 });

    await clickRowMenuItem(row.first(), page.getByTestId('msg-report'));
    await page.getByTestId('alert-confirm').click();

    await expect(
      page.getByText("Reported to your server's admins."),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('reports a room, then leaves it from the confirmation', async ({
    page,
    request,
  }) => {
    const { hs, user, pass, roomName } = await setUp(request, 'r');

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-report-room').click();

    const prompt = page.getByRole('dialog', { name: 'Report room' });
    await expect(prompt.getByPlaceholder('Reason (optional)')).toBeVisible();
    await prompt.getByLabel('Reason (optional)').fill('Spam links');
    await prompt.getByRole('button', { name: 'Report', exact: true }).click();

    const sent = page.getByRole('dialog', { name: 'Report sent' });
    await expect(sent).toBeVisible({ timeout: 30_000 });
    await sent.getByRole('button', { name: 'Leave room' }).click();

    await expect(page.locator('.channel', { hasText: roomName })).toHaveCount(
      0,
      { timeout: 30_000 },
    );
  });

  test('reports a user from their card, then blocks them from the confirmation', async ({
    page,
    request,
  }) => {
    const { hs, runId, user, pass, other, roomName, otherName, room_id } =
      await setUp(request, 'u', true);

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('toggle-members').click();
    const memberRow = page.locator('[data-testid="member-row"]', {
      hasText: otherName,
    });
    await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
    await memberRow.first().click();
    const card = page.getByTestId('member-info');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByRole('button', { name: `Report ${otherName}` }).click();
    const prompt = page.getByRole('dialog', { name: `Report ${otherName}` });
    await prompt.getByRole('button', { name: 'Report', exact: true }).click();

    const sent = page.getByRole('dialog', { name: 'Report sent' });
    await expect(sent).toBeVisible({ timeout: 30_000 });
    await sent.getByRole('button', { name: `Block ${otherName}` }).click();

    await expect(card.getByTestId('member-info-ignore')).toHaveText('Unblock', {
      timeout: 30_000,
    });

    // A message sent while blocked shows once they are unblocked from the card, with no reload.
    const whileBlocked = `while blocked ${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}wb`,
      {
        headers: auth(other!),
        data: { msgtype: 'm.text', body: whileBlocked },
      },
    );
    await card.getByTestId('member-info-ignore').click();
    await expect(page.getByTestId('member-info-block-notice')).toHaveText(
      'Unblocked.',
      { timeout: 30_000 },
    );
    await expect(
      page.locator('.scroll .msg[data-mid]', { hasText: whileBlocked }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("says when the server doesn't take room reports, and stops offering them", async ({
    page,
    request,
  }) => {
    const { hs, user, pass, roomName } = await setUp(request, 'x');
    await page.route('**/_matrix/client/*/rooms/*/report', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ errcode: 'M_UNRECOGNIZED', error: 'nope' }),
      }),
    );

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-report-room').click();
    await page
      .getByRole('dialog', { name: 'Report room' })
      .getByRole('button', { name: 'Report', exact: true })
      .click();

    await expect(
      page.getByText("Your server doesn't accept room reports."),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('room-actions-overflow').click();
    await expect(page.getByTestId('overflow-jump-to-date')).toBeVisible();
    await expect(page.getByTestId('overflow-report-room')).toHaveCount(0);
  });
});
