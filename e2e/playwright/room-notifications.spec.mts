import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for the per-room notification level: the room's ⋮ menu in the channel list
// has a Notifications submenu (All / Mentions / Mute); picking one writes push rules, and
// reopening the submenu shows the persisted selection. Needs a Synapse homeserver (Docker).
const session = synapseSession();

async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  user: SynapseSession;
  roomName: string;
  roomId: string;
  accessToken: string;
}> {
  const username = `notif-user-${runId}`;
  const password = `${username}-pass`;
  const roomName = `Notify E2E ${runId}`;

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
  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName },
    })
    .then((r) => r.json());

  return {
    user: { available: true, hs, user: username, pass: password },
    roomName,
    roomId: room_id,
    accessToken: access_token,
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

const LEVELS = ['all', 'mentions', 'mute'] as const;
type Level = (typeof LEVELS)[number];

// Open the room row's ⋮ menu in the channel list, then its Notifications submenu.
async function openNotifyMenu(page: Page, roomName: string): Promise<void> {
  const row = page.locator('.channel-row', { hasText: roomName }).first();
  const notifyEntry = page.getByTestId('room-notify');
  // Escape closes one overlay layer at a time. Reuse a parent room menu that is already
  // open instead of toggling its kebab and accidentally closing it.
  if (!(await notifyEntry.isVisible())) {
    await row.hover();
    await row.getByRole('button', { name: `Options for ${roomName}` }).click();
  }
  await notifyEntry.click(); // reveal the Notifications submenu
  await expect(page.getByTestId('room-notify-all')).toBeVisible({
    timeout: 10_000,
  });
}

// Pick a level radio and wait for both push-rule reads: the fresh pre-write snapshot and
// the postcondition refresh. The reopened menu then reflects the verified server state
// deterministically for every transition. Selecting a radio also closes the menu.
async function pickLevel(page: Page, level: Level): Promise<void> {
  let refreshes = 0;
  await Promise.all([
    page.waitForResponse(
      (r) =>
        /\/pushrules\/?$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'GET' &&
        ++refreshes === 2,
      { timeout: 15_000 },
    ),
    page.getByTestId(`room-notify-${level}`).click(),
  ]);
}

// With the Notifications submenu open, assert exactly `level` is the checked radio.
async function expectChecked(page: Page, level: Level): Promise<void> {
  for (const l of LEVELS) {
    await expect(page.getByTestId(`room-notify-${l}`)).toHaveAttribute(
      'aria-checked',
      l === level ? 'true' : 'false',
      { timeout: 15_000 },
    );
  }
}

async function setRemoteMentions(
  request: APIRequestContext,
  hs: string,
  accessToken: string,
  roomId: string,
): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const ruleId = encodeURIComponent(roomId);
  const added = await request.put(
    `${hs}/_matrix/client/v3/pushrules/global/room/${ruleId}`,
    // FluffyChat 2.7.2 uses matrix-dart 10.2.2, whose mentions-only/muted
    // room rule is the Matrix v1.7+ canonical empty effective action list.
    { headers, data: { actions: [] } },
  );
  expect(added.ok()).toBe(true);
}

/** Wait for the app's sync loop to consume the remotely-written room rule. */
async function waitForRemoteMentions(
  page: Page,
  roomId: string,
): Promise<void> {
  await page.waitForResponse(
    async (response) => {
      if (
        response.request().method() !== 'GET' ||
        !/\/_matrix\/client\/(?:v3|r0)\/sync$/.test(
          new URL(response.url()).pathname,
        ) ||
        !response.ok()
      ) {
        return false;
      }
      const body = (await response.json().catch(() => null)) as {
        account_data?: {
          events?: Array<{
            type?: string;
            content?: { global?: { room?: Array<{ rule_id?: string }> } };
          }>;
        };
      } | null;
      return !!body?.account_data?.events?.some(
        (event) =>
          event.type === 'm.push_rules' &&
          event.content?.global?.room?.some((rule) => rule.rule_id === roomId),
      );
    },
    { timeout: 30_000 },
  );
}

test.describe('Per-room notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('persists, syncs, and restores per-room notification levels', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}n`;
    const { user, roomName, roomId, accessToken } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, user);
    await openRoom(page, roomName);

    // A fresh room defaults to "All messages".
    await openNotifyMenu(page, roomName);
    await expectChecked(page, 'all');
    const roomRow = page.locator('.channel-row', { hasText: roomName }).first();
    await expect(roomRow.getByTestId('room-muted')).toHaveCount(0);

    // Reproduce FluffyChat's quick Mute action from another device. Its current Matrix
    // SDK writes a room rule with `actions: []`; the already-open Trinity client must
    // consume m.push_rules through /sync and show it without a reload.
    await page.keyboard.press('Escape');
    const remoteSync = waitForRemoteMentions(page, roomId);
    await setRemoteMentions(request, session.hs as string, accessToken, roomId);
    await remoteSync;
    await expect(roomRow.getByTestId('room-muted')).toHaveAttribute(
      'aria-label',
      'Room muted; mentions and keywords still notify',
    );
    await openNotifyMenu(page, roomName);
    await expectChecked(page, 'mentions');

    // Fail the second endpoint in mentions → mute after the room rule was removed. Trinity
    // compensates back to mentions and explains the rollback instead of leaving stale UI.
    let failedOverride = false;
    await page.route('**/pushrules/global/override/**', async (route) => {
      if (!failedOverride && route.request().method() === 'PUT') {
        failedOverride = true;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            errcode: 'M_UNKNOWN',
            error: 'Injected notification-rule failure',
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByTestId('room-notify-mute').click();
    await expect(page.getByText(/previous setting was restored/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.unroute('**/pushrules/global/override/**');
    await openNotifyMenu(page, roomName);
    await expectChecked(page, 'mentions');

    // A successful Trinity full-mute write survives a reload because initialization
    // reads the homeserver rules instead of relying on browser-only state.
    await pickLevel(page, 'mute');
    await page.reload();
    await openRoom(page, roomName);
    await openNotifyMenu(page, roomName);
    await expectChecked(page, 'mute');

    // Clear both server rules and prove the final transition back to the default.
    await pickLevel(page, 'all');
    const serverRules = (await request
      .get(`${session.hs}/_matrix/client/v3/pushrules/`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .then((response) => response.json())) as {
      global?: {
        room?: Array<{
          rule_id?: string;
          enabled?: boolean;
          actions?: unknown[];
        }>;
      };
    };
    expect(
      serverRules.global?.room?.find((rule) => rule.rule_id === roomId),
    ).toMatchObject({ enabled: false, actions: [] });

    await page.reload();
    await openRoom(page, roomName);
    await openNotifyMenu(page, roomName);
    await expectChecked(page, 'all');
  });
});
