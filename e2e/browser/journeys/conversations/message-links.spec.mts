import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// End-to-end for matrix.to user links on the web: a message mentioning a user opens an
// anchored user card instead of navigating to an empty room. The room-link preview,
// federation and portrait-sheet journeys run through android.message-links (#747).
// Needs Synapse (Docker).
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Matrix room links', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.skip(
    !session.secondary,
    'needs the federated secondary Synapse from the current harness',
  );

  test('clicking a mention shows a user card, not an empty room', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'Android runs this through android.message-links (#747).',
    );
    const runId = `${testResourceId('run')}u`;
    const hs = session.hs as string;
    const user = `mention-user-${runId}`;
    const pass = `${user}-pass`;
    const bob = `mention-bob-${runId}`;
    await registerUser(request, user, pass);
    await registerUser(request, bob, `${bob}-pass`);

    const token = (u: string, p: string) =>
      request
        .post(`${hs}/_matrix/client/v3/login`, {
          data: {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: u },
            password: p,
          },
        })
        .then((r) => r.json());
    const owner = await token(user, pass);
    const bobLogin = await token(bob, `${bob}-pass`);
    const bobId = bobLogin.user_id as string;
    const bobName = `Bobby${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(bobId)}/displayname`,
      {
        headers: { Authorization: `Bearer ${bobLogin.access_token}` },
        data: { displayname: bobName },
      },
    );

    const headers = { Authorization: `Bearer ${owner.access_token}` };
    const roomName = `Mention Room ${runId}`;
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    // A message mentioning Bob (a matrix.to user permalink, as a pill does).
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/mention-${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: `hey ${bobName}`,
          format: 'org.matrix.custom.html',
          formatted_body: `hey <a href="https://matrix.to/#/${bobId}">${bobName}</a>`,
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // Clicking the mention opens a user card — it does not navigate anywhere.
    const mention = page.locator('.scroll a', { hasText: bobName }).first();
    const mentionBox = await mention.boundingBox();
    await mention.click();
    const card = page.getByTestId('user-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('user-card-name')).toHaveText(bobName);

    // On web it is a POPOVER pinned to the mention, not a centred modal.
    await expect(
      page.locator('.cdk-overlay-connected-position-bounding-box'),
    ).toBeVisible();
    const cardBox = await card.boundingBox();
    expect(mentionBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.y).toBeGreaterThanOrEqual(mentionBox!.y);
    expect(Math.abs(cardBox!.x - mentionBox!.x)).toBeLessThan(120);
    // Still in the same room (no empty room opened behind the card).
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      new RegExp(roomName),
    );
  });
});
