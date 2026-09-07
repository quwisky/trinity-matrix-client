import { captureScreenshot } from '../../../support/screenshot.mts';
import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { login, type SynapseSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  addAccountViaUi,
  apiLogin,
  expectWorkspaceAccount,
  mixInAccount,
  type ApiUser,
} from '../../support/multi-account-journey.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';

interface SharedRoom {
  readonly accountA: ApiUser & { user: string; pass: string };
  readonly accountB: ApiUser & { user: string; pass: string };
  readonly roomId: string;
  readonly roomName: string;
}

async function seedSharedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<SharedRoom> {
  const userA = `for-you-a-${runId}`;
  const passA = `${userA}-pass`;
  const userB = `for-you-b-${runId}`;
  const passB = `${userB}-pass`;
  const roomName = `For you ${runId}`;
  await registerUser(request, userA, passA);
  await registerUser(request, userB, passB);
  const a = await apiLogin(request, hs, userA, passA);
  const b = await apiLogin(request, hs, userB, passB);
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: a.headers,
      data: {
        name: roomName,
        preset: 'private_chat',
        invite: [b.userId],
      },
    })
    .then((response) => response.json())
    .then((body) => body.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: b.headers },
  );

  // Give B deliberately different preferences before either SDK starts. Initial sync is
  // then a trustworthy authoritative source for both the push rule and Room tags.
  await request.put(
    `${hs}/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(roomId)}`,
    { headers: b.headers, data: { actions: [] } },
  );
  await request.put(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(b.userId)}/rooms/${encodeURIComponent(roomId)}/tags/m.favourite`,
    { headers: b.headers, data: {} },
  );

  return {
    accountA: { ...a, user: userA, pass: passA },
    accountB: { ...b, user: userB, pass: passB },
    roomId,
    roomName,
  };
}

async function openForYou(page: Page): Promise<void> {
  await page.getByTestId('open-room-settings').click();
  await expect(page.getByTestId('room-settings')).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId('room-settings-tab-for-you').click();
  await expect(page.getByTestId('room-settings-for-you-form')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('room-settings-section-heading')).toBeFocused();
}

async function expectMode(
  page: Page,
  expected: 'all' | 'mentions' | 'mute',
): Promise<void> {
  for (const mode of ['all', 'mentions', 'mute'] as const) {
    const radio = page
      .getByTestId(`room-settings-notify-${mode}`)
      .getByRole('radio');
    if (mode === expected) await expect(radio).toBeChecked();
    else await expect(radio).not.toBeChecked();
  }
}

async function serverMode(
  request: APIRequestContext,
  hs: string,
  account: ApiUser,
  roomId: string,
): Promise<'all' | 'mentions' | 'mute'> {
  const rules = (await request
    .get(`${hs}/_matrix/client/v3/pushrules/`, { headers: account.headers })
    .then((response) => response.json())) as {
    global?: {
      room?: Array<{ rule_id?: string; enabled?: boolean }>;
      override?: Array<{ rule_id?: string; enabled?: boolean }>;
    };
  };
  if (
    rules.global?.override?.some(
      (rule) => rule.rule_id === roomId && rule.enabled,
    )
  ) {
    return 'mute';
  }
  return rules.global?.room?.some(
    (rule) => rule.rule_id === roomId && rule.enabled,
  )
    ? 'mentions'
    : 'all';
}

async function serverTags(
  request: APIRequestContext,
  hs: string,
  account: ApiUser,
  roomId: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(account.userId)}/rooms/${encodeURIComponent(roomId)}/tags`,
    { headers: account.headers },
  );
  const body = (await response.json()) as { tags?: Record<string, unknown> };
  return body.tags ?? {};
}

test.describe('Room settings · For you', () => {
  configureRoomSettingsSuite();

  test('isolates staged preferences to the opening Account and retries only a failed field', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const hs = session.hs as string;
    const shared = await seedSharedRoom(
      request,
      hs,
      `${testResourceId('run')}prefs`,
    );
    await login(page, {
      available: true,
      hs,
      user: shared.accountA.user,
      pass: shared.accountA.pass,
    } as SynapseSession);
    await addAccountViaUi(page, hs, shared.accountB.user, shared.accountB.pass);
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: shared.accountA.userId })
      .click();
    await expectWorkspaceAccount(page, shared.accountA.user);
    await mixInAccount(page, shared.accountB.user);
    await openRoom(page, shared.roomName);
    await openForYou(page);

    await expect(page.getByTestId('room-settings-account')).toContainText(
      shared.accountA.user,
    );
    await expectMode(page, 'all');
    await expect(
      page.getByTestId('room-settings-favourite').getByRole('checkbox'),
    ).not.toBeChecked();

    // Native radio keyboard behavior reaches the component output; staged checkboxes use
    // Space. This covers the section without bypassing user events through evaluate().
    const all = page.getByTestId('room-settings-notify-all').getByRole('radio');
    await all.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expectMode(page, 'mute');
    const favourite = page
      .getByTestId('room-settings-favourite')
      .getByRole('checkbox');
    await favourite.focus();
    await page.keyboard.press('Space');
    await page.getByTestId('room-settings-low-priority').click();

    let lowPriorityWrites = 0;
    let favouriteWrites = 0;
    let notificationWrites = 0;
    page.on('request', (outgoing) => {
      if (!['PUT', 'DELETE'].includes(outgoing.method())) return;
      const path = new URL(outgoing.url()).pathname;
      if (path.includes('/pushrules/')) notificationWrites++;
      if (path.endsWith('/tags/m.favourite')) favouriteWrites++;
      if (path.endsWith('/tags/m.lowpriority')) lowPriorityWrites++;
    });
    await page.route('**/tags/m.lowpriority', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ errcode: 'M_UNKNOWN', error: 'retry me' }),
      });
    });
    await page.getByTestId('room-settings-for-you-save').click();
    const feedback = page.getByTestId('room-settings-for-you-feedback');
    await expect(feedback).toContainText('still unsaved', { timeout: 30_000 });
    const successfulNotificationWrites = notificationWrites;
    const successfulFavouriteWrites = favouriteWrites;
    expect(successfulNotificationWrites).toBeGreaterThan(0);
    expect(successfulFavouriteWrites).toBe(1);
    expect(lowPriorityWrites).toBeGreaterThanOrEqual(1);

    await page.unroute('**/tags/m.lowpriority');
    await page.getByTestId('room-settings-for-you-save').click();
    await expect(feedback).toContainText('Low priority saved', {
      timeout: 30_000,
    });
    expect(notificationWrites).toBe(successfulNotificationWrites);
    expect(favouriteWrites).toBe(successfulFavouriteWrites);

    expect(await serverMode(request, hs, shared.accountA, shared.roomId)).toBe(
      'mute',
    );
    expect(
      await serverTags(request, hs, shared.accountA, shared.roomId),
    ).toMatchObject({ 'm.favourite': {}, 'm.lowpriority': {} });
    expect(await serverMode(request, hs, shared.accountB, shared.roomId)).toBe(
      'mentions',
    );
    expect(
      await serverTags(request, hs, shared.accountB, shared.roomId),
    ).toMatchObject({ 'm.favourite': {} });

    // Every shipped Theme and both Modes retain a readable, reachable action row. The
    // screenshots are test output only and become PR proof, never repository assets.
    const appearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
      fontSize: document.documentElement.style.fontSize,
    }));
    for (const theme of [null, 'amethyst', 'onyx'] as const) {
      for (const dark of [false, true]) {
        await page.evaluate(
          ({ selectedTheme, selectedDark }) => {
            document.documentElement.classList.toggle('dark', selectedDark);
            if (selectedTheme === null)
              document.documentElement.removeAttribute('data-theme');
            else
              document.documentElement.setAttribute(
                'data-theme',
                selectedTheme,
              );
          },
          { selectedTheme: theme, selectedDark: dark },
        );
        await expect(
          page.getByTestId('room-settings-for-you-form'),
        ).toBeVisible();
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    await page
      .getByTestId('room-settings-for-you-form')
      .scrollIntoViewIfNeeded();
    await expect(page.getByTestId('room-settings-for-you-form')).toBeVisible();
    await test.info().attach('room-settings-for-you-desktop', {
      body: await captureScreenshot(page, () =>
        page.getByTestId('room-settings').screenshot(),
      ),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme, fontSize }) => {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.fontSize = fontSize;
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, appearance);

    await page.getByTestId('room-settings-cancel').click();
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: shared.accountB.userId })
      .click();
    await expectWorkspaceAccount(page, shared.accountB.user);
    await openRoom(page, shared.roomName);
    await openForYou(page);
    await expect(page.getByTestId('room-settings-account')).toContainText(
      shared.accountB.user,
    );
    await expectMode(page, 'mentions');
    await expect(
      page.getByTestId('room-settings-favourite').getByRole('checkbox'),
    ).toBeChecked();
    await expect(
      page.getByTestId('room-settings-low-priority').getByRole('checkbox'),
    ).not.toBeChecked();
  });
});
