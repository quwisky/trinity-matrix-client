import { captureScreenshot } from '../../../support/screenshot.mts';
import { expect, test, testResourceId } from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { installWidgetFixture } from '../../support/widget.mts';
import { addAccountViaUi } from '../../support/multi-account-journey.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';

test.describe('Room settings', () => {
  configureRoomSettingsSuite();

  test('embeds a real room widget through a restricted Widget API bridge', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}wd`;
    const user = `widget-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Widgets ${runId}`;
    const rawUrl =
      'https://widgets.example/board?room=$matrix_room_id' +
      '&user=$matrix_user_id&board=$board_id';
    const widgetFixture = await installWidgetFixture(page, 1_500);

    await registerUser(request, user, pass);
    const { access_token, user_id } = await request
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
        data: {
          name: roomName,
          preset: 'private_chat',
          initial_state: [
            {
              type: 'im.vector.modular.widgets',
              state_key: 'planning-board',
              content: {
                name: 'Planning board',
                type: 'm.custom',
                url: rawUrl,
                data: { board_id: 'road map' },
              },
            },
          ],
        },
      })
      .then((r) => r.json());

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'widgets');

    const card = page.getByTestId('room-widget-planning-board');
    await expect(card).toContainText('Planning board');
    await expect(card).toContainText('m.custom');
    await expect(card).toContainText(rawUrl);
    await expect(card).toContainText('https://widgets.example');
    await expect(card).toContainText('this room’s ID');
    await expect(card).toContainText('your Matrix user ID');

    const expectedUrl =
      `https://widgets.example/board?room=${encodeURIComponent(room_id as string)}` +
      `&user=${encodeURIComponent(user_id as string)}&board=road%20map`;
    const open = page.getByTestId('room-widget-open-planning-board');
    await expect(open).toHaveAttribute('href', expectedUrl);
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    expect(widgetFixture.requestCount()).toBe(0);

    const embed = page.getByTestId('room-widget-embed-planning-board');
    await embed.click();
    await expect(page.getByTestId('widget-frame-status')).toContainText(
      'Negotiating',
    );
    await expect(page.getByTestId('room-widget-frame-close')).toBeFocused();
    expect(widgetFixture.requestCount()).toBe(1);

    const firstFrame = page.frameLocator('iframe.widget-frame__iframe');
    await expect(firstFrame.locator('#request')).not.toHaveText('');
    const firstRequest = JSON.parse(
      (await firstFrame.locator('#request').textContent()) ?? '{}',
    ) as Record<string, unknown>;
    const attackerNavigation = page.waitForEvent('framenavigated', {
      predicate: (candidate) =>
        candidate.url() === 'https://widgets.example/attacker',
    });
    await page.evaluate(() => {
      const attacker = document.createElement('iframe');
      attacker.dataset['widgetAttacker'] = 'source';
      attacker.src = 'https://widgets.example/attacker';
      document.body.append(attacker);
    });
    const attackerFrame = await attackerNavigation;
    await attackerFrame.evaluate(
      ({ message, targetOrigin }) => {
        parent.postMessage(
          { ...message, response: { capabilities: [] } },
          targetOrigin,
        );
      },
      { message: firstRequest, targetOrigin: new URL(page.url()).origin },
    );
    await page.waitForTimeout(100);
    await expect(page.getByTestId('widget-frame-status')).toContainText(
      'Negotiating',
    );
    await page
      .locator('iframe[data-widget-attacker="source"]')
      .evaluate((element) => element.remove());

    // A same-origin sibling cannot forge the response. Close during the real request,
    // then also prove that the target WindowProxy is rejected after an origin change.
    await page.getByTestId('room-widget-frame-close').click();
    await expect(page.locator('iframe.widget-frame__iframe')).toHaveCount(0);
    await expect(embed).toBeFocused();
    await embed.click();
    await expect(page.getByTestId('widget-frame-status')).toContainText(
      'Negotiating',
    );
    const secondFrame = page.frameLocator('iframe.widget-frame__iframe');
    await expect(secondFrame.locator('#request')).not.toHaveText('');
    const secondRequest = JSON.parse(
      (await secondFrame.locator('#request').textContent()) ?? '{}',
    ) as Record<string, unknown>;
    await page.route('https://attacker.example/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Changed origin</title>',
      });
    });
    const originChange = page.waitForEvent('framenavigated', {
      predicate: (candidate) =>
        candidate.url() === 'https://attacker.example/origin-change',
    });
    await page
      .locator('iframe.widget-frame__iframe')
      .evaluate((iframe: HTMLIFrameElement) => {
        iframe.src = 'https://attacker.example/origin-change';
      });
    const changedFrame = await originChange;
    await changedFrame.evaluate(
      ({ message, targetOrigin }) => {
        parent.postMessage(
          { ...message, response: { capabilities: [] } },
          targetOrigin,
        );
      },
      { message: secondRequest, targetOrigin: new URL(page.url()).origin },
    );
    await page.waitForTimeout(100);
    await expect(page.getByTestId('widget-frame-status')).toContainText(
      'Negotiating',
    );
    await page.getByTestId('room-widget-frame-close').click();
    await expect(embed).toBeFocused();

    // A clean third open completes with only the legitimate target response.
    await embed.click();
    await expect(page.getByTestId('widget-frame-status')).toContainText(
      'Widget API ready',
      { timeout: 5_000 },
    );
    expect(widgetFixture.requestCount()).toBe(3);
    expect(widgetFixture.referrers()).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const frameElement = page.locator('iframe.widget-frame__iframe');
    await expect(frameElement).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-same-origin',
    );
    await expect(frameElement).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(frameElement).not.toHaveAttribute('allowfullscreen', /.*/);
    const frame = page.frameLocator('iframe.widget-frame__iframe');
    await expect(
      frame.getByRole('heading', { name: 'Widget fixture loaded' }),
    ).toBeVisible();
    await expect(frame.locator('#requested')).toContainText(
      'm.always_on_screen',
    );
    await expect(frame.locator('#approved')).toHaveText('[]');
    await expect(frame.locator('#policy-api')).toHaveText('available');
    await expect(frame.locator('#denied')).toHaveText(
      JSON.stringify([
        ['camera', false],
        ['microphone', false],
        ['geolocation', false],
        ['display-capture', false],
        ['clipboard-read', false],
        ['fullscreen', false],
      ]),
    );

    let blockedHttpRequests = 0;
    await page.route('http://blocked-widget.test/**', async (route) => {
      blockedHttpRequests += 1;
      await route.fulfill({ status: 200, body: 'must not load' });
    });
    const cspViolation = page.waitForEvent('console', {
      predicate: (message) =>
        message.text().includes('frame-src') &&
        message.text().includes('blocked-widget.test'),
    });
    await page.evaluate(() => {
      const iframe = document.createElement('iframe');
      iframe.src = 'http://blocked-widget.test/frame';
      document.body.append(iframe);
    });
    await cspViolation;
    expect(blockedHttpRequests).toBe(0);
    await page.getByTestId('room-widget-frame-close').click();
    await expect(embed).toBeFocused();
  });

  test('the opening admin adds and removes an exact generic widget after an Account switch', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}wg`;
    const user = `widget-manage-${runId}`;
    const pass = `${user}-pass`;
    const member = `widget-reader-${runId}`;
    const memberPass = `${member}-pass`;
    const memberId = `@${member}:localhost`;
    const roomName = `Manage widgets ${runId}`;
    const widgetName = `Roadmap ${runId}`;
    const rawUrl =
      'https://widgets.example/board?room=$matrix_room_id&view=roadmap' +
      '&user=$matrix_user_id';
    const widgetFixture = await installWidgetFixture(page);

    await registerUser(request, user, pass);
    await registerUser(request, member, memberPass);
    const { access_token, user_id } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((response) => response.json());
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${access_token}` },
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [memberId],
        },
      })
      .then((response) => response.json());
    const memberAccessToken = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: member },
          password: memberPass,
        },
      })
      .then((response) => response.json())
      .then((body) => body.access_token as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: { Authorization: `Bearer ${memberAccessToken}` } },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await addAccountViaUi(page, hs, member, memberPass);
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${user}:` })
      .click();
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'widgets');
    await expect(page.getByTestId('room-settings-account')).toContainText(user);

    // The overlay owns pointer interaction, so invoke the underlying menu trigger and
    // switch to the ordinary member through the same Account Runtime handlers.
    await page
      .getByTestId('user-menu-trigger')
      .evaluate((element: HTMLElement) => element.click());
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${member}:` })
      .click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${member}:`);
    await expect(page.getByTestId('room-settings-account')).toContainText(user);

    await page.getByTestId('room-widget-create-name').fill(widgetName);
    await page.getByTestId('room-widget-create-url').fill(rawUrl);

    // A failed exact-target write retains both fields and exposes a finite pending state.
    const widgetWrite = /\/state\/im\.vector\.modular\.widgets\//;
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    await page.route(widgetWrite, async (route) => {
      await failureGate;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ errcode: 'M_UNKNOWN', error: 'retry me' }),
      });
    });
    await page.getByTestId('room-widget-create-url').press('Enter');
    await expect(page.getByTestId('room-widget-create-submit')).toContainText(
      'Adding',
    );
    releaseFailure();
    await expect(page.getByTestId('room-widget-create-error')).toContainText(
      'Could not add',
    );
    await expect(page.getByTestId('room-widget-create-name')).toHaveValue(
      widgetName,
    );
    await expect(page.getByTestId('room-widget-create-url')).toHaveValue(
      rawUrl,
    );
    await page.unroute(widgetWrite);
    await page.getByTestId('room-widget-create-submit').click();

    const card = page.locator('article.room-widgets__widget', {
      hasText: widgetName,
    });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(
      card.getByRole('link', { name: /open .* in browser/i }),
    ).toHaveAttribute(
      'href',
      new RegExp(`user=${encodeURIComponent(user_id as string)}`),
    );
    await test.info().attach('room-widgets-desktop', {
      body: await captureScreenshot(page, () =>
        page.getByTestId('room-settings').screenshot(),
      ),
      contentType: 'image/png',
    });
    expect(widgetFixture.requestCount()).toBe(0);

    const stateEvents = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state`,
        { headers: { Authorization: `Bearer ${access_token}` } },
      )
      .then((response) => response.json());
    const declaration = (
      stateEvents as Array<{
        type: string;
        state_key: string;
        content: Record<string, unknown>;
      }>
    ).find(
      (event) =>
        event.type === 'im.vector.modular.widgets' &&
        event.content['name'] === widgetName,
    );
    expect(declaration).toBeDefined();
    expect(declaration?.content).toEqual({
      id: declaration?.state_key,
      name: widgetName,
      type: 'm.custom',
      url: rawUrl,
      creatorUserId: user_id,
      data: {},
      waitForIframeLoad: true,
    });

    const widgetId = declaration?.state_key as string;
    await page.getByTestId(`room-widget-remove-${widgetId}`).click();
    const confirmation = page.locator('trn-alert-dialog');
    await expect(confirmation).toContainText(widgetName);
    await expect(confirmation).toContainText('every member and Matrix client');
    await confirmation.getByTestId('alert-confirm').click();

    await expect(card).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('room-widget-create-name')).toBeFocused();
    expect(widgetFixture.requestCount()).toBe(0);

    const tombstone = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/im.vector.modular.widgets/${encodeURIComponent(widgetId)}`,
        { headers: { Authorization: `Bearer ${access_token}` } },
      )
      .then((response) => response.json());
    expect(tombstone).toEqual({});
  });

  test('widget management follows live power grants and revocations', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}wp`;
    const owner = `widget-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `widget-member-${runId}`;
    const memberPass = `${member}-pass`;
    const roomName = `Widget powers ${runId}`;
    const widgetFixture = await installWidgetFixture(page);

    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerSession = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: owner },
          password: ownerPass,
        },
      })
      .then((response) => response.json());
    const memberSession = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: member },
          password: memberPass,
        },
      })
      .then((response) => response.json());
    const ownerHeaders = {
      Authorization: `Bearer ${ownerSession.access_token as string}`,
    };
    const memberHeaders = {
      Authorization: `Bearer ${memberSession.access_token as string}`,
    };
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: ownerHeaders,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [memberSession.user_id],
          initial_state: [
            {
              type: 'im.vector.modular.widgets',
              state_key: 'shared-board',
              content: {
                name: 'Shared board',
                type: 'm.custom',
                url: 'https://widgets.example/shared',
              },
            },
          ],
        },
      })
      .then((response) => response.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: memberHeaders },
    );

    await login(page, {
      available: true,
      hs,
      user: member,
      pass: memberPass,
    } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'widgets');

    await expect(page.getByTestId('room-widget-shared-board')).toBeVisible();
    await expect(page.getByTestId('room-widget-create')).toHaveCount(0);
    await expect(
      page.getByTestId('room-widget-remove-shared-board'),
    ).toHaveCount(0);

    const powerUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.power_levels/`;
    const powers = await request
      .get(powerUrl, { headers: ownerHeaders })
      .then((response) => response.json());
    await request.put(powerUrl, {
      headers: ownerHeaders,
      data: {
        ...powers,
        users: {
          ...(powers.users as Record<string, number>),
          [memberSession.user_id as string]: 50,
        },
      },
    });
    await expect(page.getByTestId('room-widget-create')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByTestId('room-widget-remove-shared-board'),
    ).toBeVisible();

    await request.put(powerUrl, {
      headers: ownerHeaders,
      data: {
        ...powers,
        users: {
          ...(powers.users as Record<string, number>),
          [memberSession.user_id as string]: 0,
        },
      },
    });
    await expect(page.getByTestId('room-widget-create')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(
      page.getByTestId('room-widget-remove-shared-board'),
    ).toHaveCount(0);
    expect(widgetFixture.requestCount()).toBe(0);
  });
});
