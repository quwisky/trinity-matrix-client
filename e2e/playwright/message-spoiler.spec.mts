import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../fixtures.mts';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// End-to-end for spoiler reveal: a message carrying a `data-mx-spoiler` span renders
// concealed, and clicking it uncovers it. The spoiler is injected through the Matrix
// API (send-side spoiler syntax is a separate follow-up). Needs Synapse (Docker).
const session = synapseSession();

/** Register a user, create their room, and drop a spoiler message straight in. */
async function seedRoomWithSpoiler(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ user: SynapseSession; roomName: string; secret: string }> {
  const username = `spoiler-user-${runId}`;
  const password = `${username}-pass`;
  const roomName = `Spoiler E2E ${runId}`;
  const secret = `answer-${runId}`;

  await registerUser(request, username, password);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      },
    })
    .then((r) => r.json());
  const headers = { Authorization: `Bearer ${access_token}` };

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/spoiler-${runId}`,
    {
      headers,
      data: {
        msgtype: 'm.text',
        body: `the secret is ${secret}`,
        format: 'org.matrix.custom.html',
        formatted_body: `the secret is <span data-mx-spoiler>${secret}</span>`,
      },
    },
  );

  return {
    user: { available: true, hs, user: username, pass: password },
    roomName,
    secret,
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Spoiler reveal', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('conceals a spoiler and reveals it on click', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}s`;
    const { user, roomName } = await seedRoomWithSpoiler(
      request,
      session.hs as string,
      runId,
    );

    await login(page, user);
    await openRoom(page, roomName);

    // The spoiler renders as an mx-spoiler span (data-mx-spoiler doesn't survive the
    // render-leaf sanitizer), concealed until activated.
    const spoiler = page.locator('.scroll .mx-spoiler').first();
    await expect(spoiler).toBeVisible({ timeout: 20_000 });
    await expect(spoiler).not.toHaveClass(/is-revealed/);
    // Concealed text is painted transparent (the black-bar effect).
    await expect(spoiler).toHaveCSS('color', 'rgba(0, 0, 0, 0)');

    await spoiler.click();

    await expect(spoiler).toHaveClass(/is-revealed/);
    await expect(spoiler).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  });
});
