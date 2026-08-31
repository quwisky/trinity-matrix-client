import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { AA_NORMAL_TEXT, measureContrast } from '../../support/contrast.mts';

// End-to-end for matrix.to link navigation: a message linking to another room routes
// in-app (switches rooms) rather than leaving to matrix.to. Needs Synapse (Docker).
const session = synapseSession();

type Auth = { accessToken: string; userId: string };

async function loginApi(
  request: APIRequestContext,
  hs: string,
  username: string,
  password: string,
): Promise<Auth> {
  const response = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json();
  return {
    accessToken: body.access_token as string,
    userId: body.user_id as string,
  };
}

async function registerRemote(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<Auth> {
  const hs = session.secondary?.hs as string;
  const response = await request.post(`${hs}/_matrix/client/v3/register`, {
    data: {
      auth: { type: 'm.login.dummy' },
      username,
      password,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json();
  return {
    accessToken: body.access_token as string,
    userId: body.user_id as string,
  };
}

async function createRoom(
  request: APIRequestContext,
  hs: string,
  auth: Auth,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { room_id: string }).room_id;
}

async function sendRoomLink(
  request: APIRequestContext,
  hs: string,
  auth: Auth,
  sourceId: string,
  href: string,
  label: string,
): Promise<void> {
  const response = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(sourceId)}/send/m.room.message/link-${testResourceId('run')}`,
    {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      data: {
        msgtype: 'm.text',
        body: label,
        format: 'org.matrix.custom.html',
        formatted_body: `<a href="${href}">${label}</a>`,
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

async function localScenario(
  request: APIRequestContext,
  suffix: string,
): Promise<{
  hs: string;
  username: string;
  password: string;
  auth: Auth;
  sourceId: string;
  sourceName: string;
}> {
  const hs = session.hs as string;
  const username = `link-user-${suffix}`;
  const password = `${username}-pass`;
  await registerUser(request, username, password);
  const auth = await loginApi(request, hs, username, password);
  const sourceName = `Link Source ${suffix}`;
  const sourceId = await createRoom(request, hs, auth, { name: sourceName });
  return { hs, username, password, auth, sourceId, sourceName };
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

test.describe('Matrix room links', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.skip(
    !session.secondary,
    'needs the federated secondary Synapse from the current harness',
  );

  test('a joined room previews before an explicit Open', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}l`;
    const hs = session.hs as string;
    const username = `link-user-${runId}`;
    const password = `${username}-pass`;
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

    const sourceName = `Link Source ${runId}`;
    const targetName = `Link Target ${runId}`;
    const createRoom = (name: string) =>
      request
        .post(`${hs}/_matrix/client/v3/createRoom`, { headers, data: { name } })
        .then((r) => r.json())
        .then((j) => j.room_id as string);
    const sourceId = await createRoom(sourceName);
    const targetId = await createRoom(targetName);

    // A message in the source room linking to the target room.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(sourceId)}/send/m.room.message/link-${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: `open ${targetName}`,
          format: 'org.matrix.custom.html',
          formatted_body: `open <a href="https://matrix.to/#/${targetId}">the target room</a>`,
        },
      },
    );

    await login(page, {
      available: true,
      hs,
      user: username,
      pass: password,
    } as SynapseSession);
    await openRoom(page, sourceName);

    // Information opens first; even a joined room does not navigate on link click.
    await page
      .locator('.scroll a', { hasText: 'the target room' })
      .first()
      .click();
    const preview = page.getByTestId('room-link-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('room-link-name')).toHaveText(targetName);
    await expect(preview.getByTestId('room-link-primary')).toHaveText(
      'Open room',
    );
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      new RegExp(sourceName),
    );

    await preview.getByTestId('room-link-primary').click();

    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      new RegExp(targetName),
      { timeout: 20_000 },
    );
  });

  test('previews and joins a public room across real federation', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}f`;
    const local = await localScenario(request, runId);
    const remotePassword = `remote-${runId}-pass`;
    const remote = await registerRemote(
      request,
      `remote-${runId}`,
      remotePassword,
    );
    const remoteName = `Federated Room ${runId}`;
    const remoteTopic = `Served by ${session.secondary!.serverName}`;
    const remoteAliasLocalpart = `federated-${runId}`;
    const remoteAlias = `#${remoteAliasLocalpart}:${session.secondary!.serverName}`;
    await createRoom(request, session.secondary!.hs, remote, {
      name: remoteName,
      topic: remoteTopic,
      preset: 'public_chat',
      visibility: 'public',
      room_alias_name: remoteAliasLocalpart,
    });
    await sendRoomLink(
      request,
      local.hs,
      local.auth,
      local.sourceId,
      `https://matrix.to/#/${encodeURIComponent(remoteAlias)}`,
      'open the federated room',
    );

    await login(page, {
      available: true,
      hs: local.hs,
      user: local.username,
      pass: local.password,
    } as SynapseSession);
    await openRoom(page, local.sourceName);
    await page.getByRole('link', { name: 'open the federated room' }).click();

    const preview = page.getByTestId('room-link-preview');
    await expect(preview.getByTestId('room-link-name')).toHaveText(remoteName, {
      timeout: 20_000,
    });
    await expect(preview.getByTestId('room-link-topic')).toHaveText(
      remoteTopic,
    );
    await expect(preview.getByTestId('room-link-primary')).toHaveText(
      'Join room',
    );
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      new RegExp(local.sourceName),
    );

    const primary = preview.getByTestId('room-link-primary');
    await primary.focus();
    await page.keyboard.press('Enter');
    await expect(preview.getByTestId('room-link-success')).toContainText(
      'Room joined',
      { timeout: 30_000 },
    );
    await expect(primary).toHaveText('Open room');
    await expect(primary).toBeFocused();

    const initiallyDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );
    expect(
      (await measureContrast(page, 'room-link-success')).ratio,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(
      (await measureContrast(page, 'room-link-success')).ratio,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    await page.evaluate((restoreDark) => {
      document.documentElement.classList.toggle('dark', restoreDark);
    }, initiallyDark);

    await primary.click();
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      new RegExp(remoteName),
      { timeout: 30_000 },
    );
  });

  test('shows a useful unavailable state for an inaccessible remote room', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}x`;
    const local = await localScenario(request, runId);
    const remote = await registerRemote(
      request,
      `private-${runId}`,
      `private-${runId}-pass`,
    );
    const remoteId = await createRoom(request, session.secondary!.hs, remote, {
      name: `Private ${runId}`,
      preset: 'private_chat',
    });
    await sendRoomLink(
      request,
      local.hs,
      local.auth,
      local.sourceId,
      `https://matrix.to/#/${remoteId}?via=${encodeURIComponent(session.secondary!.serverName)}`,
      'open a private remote room',
    );

    await login(page, {
      available: true,
      hs: local.hs,
      user: local.username,
      pass: local.password,
    } as SynapseSession);
    await openRoom(page, local.sourceName);
    await page
      .getByRole('link', { name: 'open a private remote room' })
      .click();

    const error = page.getByTestId('room-link-load-error');
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText(/Room (not found|unavailable)/);
    await expect(page.getByTestId('room-link-primary')).toHaveCount(0);
  });

  test('keeps a rejected federated Join open and retryable', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}r`;
    const local = await localScenario(request, runId);
    const remote = await registerRemote(
      request,
      `retry-${runId}`,
      `retry-${runId}-pass`,
    );
    const remoteId = await createRoom(request, session.secondary!.hs, remote, {
      name: `Join Retry ${runId}`,
      preset: 'public_chat',
    });
    await sendRoomLink(
      request,
      local.hs,
      local.auth,
      local.sourceId,
      `matrix:roomid/${remoteId.slice(1)}?via=${encodeURIComponent(session.secondary!.serverName)}`,
      'open a room whose join will fail',
    );

    await login(page, {
      available: true,
      hs: local.hs,
      user: local.username,
      pass: local.password,
    } as SynapseSession);
    await openRoom(page, local.sourceName);
    await page
      .getByRole('link', { name: 'open a room whose join will fail' })
      .click();
    const preview = page.getByTestId('room-link-preview');
    await expect(preview.getByTestId('room-link-primary')).toHaveText(
      'Join room',
      { timeout: 20_000 },
    );

    // Change the rule after preview resolution. The offered action was valid when
    // rendered, but the write is now rejected by the remote homeserver.
    const response = await request.put(
      `${session.secondary!.hs}/_matrix/client/v3/rooms/${encodeURIComponent(remoteId)}/state/m.room.join_rules/`,
      {
        headers: { Authorization: `Bearer ${remote.accessToken}` },
        data: { join_rule: 'invite' },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);

    const primary = preview.getByTestId('room-link-primary');
    await primary.focus();
    await page.keyboard.press('Enter');
    await expect(preview.getByTestId('room-link-action-error')).toBeVisible({
      timeout: 30_000,
    });
    await expect(primary).toHaveText('Join room');
    await expect(primary).toBeFocused();
    await expect(preview).toBeVisible();
  });

  test.describe('Android portrait room-link sheet', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('keeps the sheet and its action footer reachable', async ({
      page,
      request,
    }) => {
      test.skip(!isAndroidE2E, 'Android WebView geometry only');
      const runId = `${testResourceId('run')}m`;
      const local = await localScenario(request, runId);
      const targetName = `Portrait Target ${runId}`;
      const targetId = await createRoom(request, local.hs, local.auth, {
        name: targetName,
      });
      await sendRoomLink(
        request,
        local.hs,
        local.auth,
        local.sourceId,
        `https://matrix.to/#/${targetId}`,
        'open the portrait target',
      );

      await login(page, {
        available: true,
        hs: local.hs,
        user: local.username,
        pass: local.password,
      } as SynapseSession);
      await openRoom(page, local.sourceName);
      await page
        .getByRole('link', { name: 'open the portrait target' })
        .click();

      const preview = page.getByTestId('room-link-preview');
      await expect(preview).toBeVisible();
      await expect(page.locator('trn-room-link-preview')).toHaveClass(
        /room-link-preview--sheet/,
      );
      await expect(preview.getByTestId('room-link-primary')).toHaveText(
        'Open room',
      );
      const geometry = await preview.evaluate((element) => {
        const surface = element.getBoundingClientRect();
        const footer = element
          .querySelector<HTMLElement>('.room-preview__actions')!
          .getBoundingClientRect();
        const viewport = window.visualViewport;
        const viewportBottom =
          (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
        return {
          portrait: window.innerHeight > window.innerWidth,
          surface: {
            left: surface.left,
            right: surface.right,
            bottom: surface.bottom,
          },
          footer: { top: footer.top, bottom: footer.bottom },
          viewportBottom,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.portrait).toBe(true);
      expect(Math.abs(geometry.surface.left)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.surface.right - geometry.viewportWidth),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.surface.bottom - geometry.viewportBottom),
      ).toBeLessThanOrEqual(1);
      expect(geometry.footer.top).toBeGreaterThanOrEqual(0);
      expect(geometry.footer.bottom).toBeLessThanOrEqual(
        geometry.viewportBottom + 1,
      );
    });
  });

  test('clicking a mention shows a user card, not an empty room', async ({
    page,
    request,
  }) => {
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

    // Android deliberately uses its mobile dialog interaction model even under a wide
    // emulated viewport. Web uses the anchored pointer popover.
    if (isAndroidE2E) {
      await expect(
        page.locator('.cdk-overlay-connected-position-bounding-box'),
      ).toHaveCount(0);
      await expect(page.getByRole('dialog')).toContainText(bobName);
      await expect(page.getByTestId('composer-input')).toHaveAttribute(
        'placeholder',
        new RegExp(roomName),
      );
      return;
    }

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
