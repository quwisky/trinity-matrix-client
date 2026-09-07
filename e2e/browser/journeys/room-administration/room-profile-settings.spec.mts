import { captureScreenshot } from '../../../support/screenshot.mts';
import { expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type SynapseSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { addAccountViaUi } from '../../support/multi-account-journey.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';

test.describe('Room settings', () => {
  configureRoomSettingsSuite();

  test('an admin renames a room from the settings dialog', async ({
    page,
    request,
  }) => {
    // Unlike reactions/polls (timeline events with instant local echo), a rename is an
    // m.room.name STATE event with no local echo — the channel list only reflects it
    // after the change round-trips via /sync, whose latency balloons under a loaded
    // homeserver. Give this one echo-gated test extra budget for the wait below.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}s`;
    const user = `settings-user-${runId}`;
    const pass = `${user}-pass`;
    const priorName = `Prior ${runId}`;
    const originalName = `Before ${runId}`;
    const newName = `After ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: priorName, preset: 'private_chat' },
    });
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: originalName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, priorName);
    await openRoom(page, originalName);

    // Open the room settings dialog and rename the room.
    await page.getByTestId('open-room-settings').click();
    const settings = page.getByTestId('room-settings');
    await expect(settings).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('room-settings-directory')).toBeVisible();
    await expect(page.getByTestId('room-settings-account')).toContainText(user);
    await expect(
      settings.getByRole('heading', { name: 'Room settings', level: 1 }),
    ).toBeFocused();
    const settingsBox = await settings.boundingBox();
    expect(settingsBox?.width ?? 0).toBeGreaterThan(700);
    expect(settingsBox?.width ?? Infinity).toBeLessThan(
      page.viewportSize()?.width ?? Infinity,
    );
    const openingViewport = page.viewportSize();
    if (!openingViewport) throw new Error('Room settings needs a viewport');
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.getByTestId('room-settings-directory')).toBeHidden();
    await expect(page.getByTestId('room-settings-mobile-back')).toBeVisible();
    await expect(page.getByTestId('room-settings-panel-general')).toBeVisible();
    await page.setViewportSize(openingViewport);
    await expect(page.getByTestId('room-settings-directory')).toBeVisible();
    await expect(page.getByTestId('room-settings-mobile-back')).toBeHidden();

    const openingRootSize = await page.evaluate(
      () => document.documentElement.style.fontSize,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    await expect(page.getByTestId('room-settings-cancel')).toBeVisible();
    await expect(page.getByTestId('room-settings-general-actions')).toHaveCount(
      0,
    );
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, openingRootSize);

    const name = page.getByTestId('room-settings-name');
    await name.focus();
    await name.press('ControlOrMeta+A');
    await name.pressSequentially(newName);
    await page.goBack();
    const discard = page.getByRole('dialog', {
      name: 'Discard Room settings changes?',
    });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(name).toHaveValue(newName);

    await page.getByTestId('room-settings-tab-access').click();
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(name).toHaveValue(newName);
    await expect(page.getByTestId('room-settings-panel-general')).toBeVisible();
    const openingAppearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
    }));
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('data-theme');
    });
    await test.info().attach('room-settings-desktop-general-light', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('room-settings-desktop-general-dark-amethyst', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, openingAppearance);
    await page.getByTestId('room-settings-save').click();

    // The rename is an m.room.name state event, and matrix-js-sdk has no local echo for
    // state — the channel list only updates once the change round-trips back via /sync,
    // which is slow under full-suite load. Give that sync-driven update headroom (the
    // per-test budget is raised in playwright.config for exactly these login+sync flows).
    await expect(
      page.locator('.channel', { hasText: newName }).first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      page.locator('.channel', { hasText: originalName }),
    ).toHaveCount(0);
  });

  test('an admin changes the room photo', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}a`;
    const user = `photo-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Photo ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });

    // Set a 1×1 PNG on the (hidden) file input, which uploads it as the avatar.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await page
      .getByTestId('room-settings')
      .locator('input[type="file"]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });

    // The upload + m.room.avatar write succeed, surfacing the success toast.
    await expect(
      page.getByLabel('Notifications alt+T').getByText('Room photo updated.'),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('retains a partial General failure and retries only the unsaved field', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}partial`;
    const user = `settings-partial-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Partial settings ${runId}`;
    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();

    let nameWrites = 0;
    let topicWrites = 0;
    await page.route(
      /\/state\/m\.room\.(name|topic)(?:\/|\?|$)/,
      async (route) => {
        if (route.request().url().includes('m.room.name')) {
          nameWrites++;
          await route.continue();
          return;
        }
        topicWrites++;
        if (topicWrites === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ errcode: 'M_UNKNOWN', error: 'retry me' }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page.getByTestId('room-settings-name').fill(`${roomName} renamed`);
    await page.getByTestId('room-settings-topic').fill('Eventually saved');
    await page.getByTestId('room-settings-save').click();
    const feedback = page.getByTestId('room-settings-general-feedback');
    await expect(feedback).toContainText('still unsaved', { timeout: 30_000 });
    expect(nameWrites).toBe(1);
    expect(topicWrites).toBe(1);

    await page
      .getByTestId('room-settings-save')
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(feedback).toContainText('Topic saved', { timeout: 30_000 });
    expect(nameWrites).toBe(1);
    expect(topicWrites).toBe(2);
  });

  test('keeps late and subsequent General writes on the opening Account after a shared-Room switch', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}account`;
    const userA = `settings-owner-${runId}`;
    const passA = `${userA}-pass`;
    const userB = `settings-member-${runId}`;
    const passB = `${userB}-pass`;
    const userBId = `@${userB}:localhost`;
    const roomName = `Shared settings ${runId}`;
    const renamed = `${roomName} renamed`;
    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const tokenA = await tokenFor(request, hs, userA, passA);
    const tokenB = await tokenFor(request, hs, userB, passB);
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${tokenA}` },
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [userBId],
        },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: { Authorization: `Bearer ${tokenB}` } },
    );

    await login(page, {
      available: true,
      hs,
      user: userA,
      pass: passA,
    } as SynapseSession);
    await addAccountViaUi(page, hs, userB, passB);
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${userA}:` })
      .click();
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings-account')).toContainText(
      userA,
    );

    let releaseName!: () => void;
    const nameGate = new Promise<void>((resolve) => {
      releaseName = resolve;
    });
    await page.route(/\/state\/m\.room\.name(?:\/|\?|$)/, async (route) => {
      await nameGate;
      await route.continue();
    });
    await page.getByTestId('room-settings-name').fill(renamed);
    await page.getByTestId('room-settings-save').click();
    await expect(page.getByTestId('room-settings-save')).toContainText(
      'Saving',
    );

    // The modal intentionally prevents pointer access to the underlying Account picker.
    // Invoke the same DOM handlers to model an external active-Account transition while
    // the exact-target command is in flight, then let the real Account Runtime settle.
    await page
      .getByTestId('user-menu-trigger')
      .evaluate((element: HTMLElement) => element.click());
    const memberRow = page
      .getByTestId('account-row')
      .filter({ hasText: `@${userB}:` });
    await expect(memberRow).toBeVisible();
    await memberRow.click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    await expect(page.getByTestId('room-settings-account')).toContainText(
      userA,
    );
    releaseName();
    await expect(
      page.getByTestId('room-settings-general-feedback'),
    ).toContainText('Name saved', { timeout: 30_000 });

    // B is an ordinary member and cannot write Room state. Success after B becomes active
    // therefore proves the new command resolves A's retained client, not the active one.
    await page.getByTestId('room-settings-topic').fill('Owned by account A');
    await page.getByTestId('room-settings-save').click();
    await expect(
      page.getByTestId('room-settings-general-feedback'),
    ).toContainText('Topic saved', { timeout: 30_000 });
    const topic = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.topic`,
        { headers: { Authorization: `Bearer ${tokenB}` } },
      )
      .then((response) => response.json());
    expect(topic.topic).toBe('Owned by account A');
  });
});
