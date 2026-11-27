import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  apiLogin,
  registerUser,
  type ApiUser,
} from '../../../support/account.mts';
import { settleOpenedRoom } from '../../../support/message-composer.mts';
import { resolveCallsEnabled } from '../../../support/homeserver/kind.mts';

// A real two-party MatrixRTC call: two browser contexts, a direct chat, the bundled Element
// Call widget, LiveKit and lk-jwt-service. A starts a video call, B gets the ring prompt
// and joins, both see two participants, and when A hangs up the call ends for both.
//
// Opt-in: TRINITY_E2E_CALLS=1 with TRINITY_E2E_HOMESERVER=synapse adds the stack
// (e2e/support/homeserver/calls/); without it the test skips. With it, a session that
// does not report the stack fails the test: a skip would turn the CI job green unrun.
const session = homeserverSession();

const CALL_FRAME = 'iframe.call-host__frame';

// Fake camera and microphone, granted without a prompt, for both contexts.
const MEDIA_PERMISSIONS = ['camera', 'microphone'];
test.use({
  permissions: MEDIA_PERMISSIONS,
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

async function setDisplayName(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  name: string,
): Promise<void> {
  const res = await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(user.userId)}/displayname`,
    { headers: user.headers, data: { displayname: name } },
  );
  expect(res.ok()).toBe(true);
}

/** An encrypted direct chat from `a` with `b`, joined by both and marked direct for both. */
async function createDirectChat(
  request: APIRequestContext,
  hs: string,
  a: ApiUser,
  b: ApiUser,
): Promise<void> {
  const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: a.headers,
    data: {
      preset: 'trusted_private_chat',
      is_direct: true,
      invite: [b.userId],
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);
  const { room_id: roomId } = (await created.json()) as { room_id: string };
  const joined = await request.post(
    `${hs}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    { headers: b.headers, data: {} },
  );
  expect(joined.ok()).toBe(true);
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const direct = await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(self.userId)}/account_data/m.direct`,
      { headers: self.headers, data: { [other.userId]: [roomId] } },
    );
    expect(direct.ok()).toBe(true);
  }
}

const callFrame = (page: Page) => page.frameLocator(CALL_FRAME);

/** Element Call shows one video tile per participant, its own included. */
async function expectParticipants(page: Page, count: number): Promise<void> {
  await expect(
    callFrame(page).locator('[data-testid="videoTile"]'),
  ).toHaveCount(count, { timeout: 45_000 });
}

const roomRow = (page: Page, name: string) =>
  page.locator('.channel-row', {
    has: page.locator('.channel__name', { hasText: name }),
  });

/** Show the direct chats in the room list, where the chat with `name` must appear. */
async function showDirectChat(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^Direct messages/ }).click();
  await expect(roomRow(page, name)).toBeVisible({ timeout: 30_000 });
}

test.describe('Calls', () => {
  test.skip(
    !resolveCallsEnabled(),
    'needs the opt-in call stack (TRINITY_E2E_CALLS=1, TRINITY_E2E_HOMESERVER=synapse)',
  );

  test('rings, joins and ends a two-party video call in a direct chat', async ({
    page,
    browser,
    request,
  }) => {
    // Two cold sign-ins and an SFU join on top of the usual budget.
    test.setTimeout(240_000);
    expect(session.calls, 'TRINITY_E2E_CALLS=1, but no call stack').toBe(true);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}call`;
    const callerName = `Caller ${runId}`;
    const calleeName = `Callee ${runId}`;
    const accounts = ['caller', 'callee'].map((role) => ({
      user: `${role}-${runId}`,
      pass: `${role}-${runId}-pass`,
    }));
    for (const { user, pass } of accounts) {
      await registerUser(request, user, pass);
    }
    const [caller, callee] = await Promise.all(
      accounts.map(({ user, pass }) => apiLogin(request, hs, user, pass)),
    );
    await setDisplayName(request, hs, caller, callerName);
    await setDisplayName(request, hs, callee, calleeName);
    await createDirectChat(request, hs, caller, callee);

    const calleeContext = await browser.newContext({
      permissions: MEDIA_PERMISSIONS,
    });
    try {
      const callerPage = page;
      const calleePage = await calleeContext.newPage();
      await Promise.all(
        [callerPage, calleePage].map((target, index) =>
          login(target, {
            available: true,
            hs,
            ...accounts[index],
          } as HomeserverSession),
        ),
      );
      await showDirectChat(callerPage, calleeName);
      await roomRow(callerPage, calleeName).locator('.channel').click();
      await expect(callerPage.getByTestId('composer-input')).toBeVisible();
      await settleOpenedRoom(callerPage);
      // The callee waits on the room list, where the direct chat's row shows the call.
      await showDirectChat(calleePage, callerName);

      await callerPage.getByTestId('start-call').click();
      await callerPage.getByTestId('start-video-call').click();
      // A direct-chat call skips Element Call's lobby: the caller is in the call at once.
      await expect(
        callFrame(callerPage).locator('[data-testid="incall_leave"]'),
      ).toBeVisible({ timeout: 45_000 });

      const ring = calleePage.getByRole('alertdialog', {
        name: 'Incoming call',
      });
      await expect(ring).toBeVisible({ timeout: 30_000 });
      await expect(ring).toContainText(`${callerName} is calling`);
      await expect(
        roomRow(calleePage, callerName).getByTestId('room-call'),
      ).toBeVisible();

      await ring.getByRole('button', { name: 'Join' }).click();
      await expect(ring).toBeHidden();
      await Promise.all([
        expectParticipants(callerPage, 2),
        expectParticipants(calleePage, 2),
      ]);

      await callFrame(callerPage)
        .locator('[data-testid="incall_leave"]')
        .click();
      // In a two-party direct chat the other side's call ends when one leaves.
      for (const target of [callerPage, calleePage]) {
        await expect(target.locator(CALL_FRAME)).toHaveCount(0, {
          timeout: 30_000,
        });
        await expect(target.locator('.call-host__strip')).toHaveCount(0);
      }
      await expect(
        roomRow(calleePage, callerName).getByTestId('room-call'),
      ).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await calleeContext.close();
    }
  });
});
