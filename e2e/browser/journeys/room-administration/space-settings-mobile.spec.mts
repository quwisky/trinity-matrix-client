import { captureScreenshot } from '../../../support/screenshot.mts';
import {
  devices,
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import type { TouchPlatform } from '../../../support/platform-contracts.mts';

const session = synapseSession();

async function tokenFor(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((response) => response.json())
    .then((body) => body.access_token as string);
}

async function createSpace(
  request: APIRequestContext,
  hs: string,
  token: string,
  name: string,
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    })
    .then((response) => response.json())
    .then((body) => body.room_id as string);
}

async function childLink(
  request: APIRequestContext,
  hs: string,
  token: string,
  spaceId: string,
  childId: string,
): Promise<Record<string, unknown> | null> {
  const response = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.ok()
    ? ((await response.json()) as Record<string, unknown>)
    : null;
}

async function openSpaceSettings(
  page: Page,
  name: string,
  touchPlatform: TouchPlatform,
  roomName?: string,
): Promise<void> {
  const pill = page.getByRole('button', { name, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await touchPlatform.tap(page, pill);
  if (roomName) {
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await channel.waitFor({ state: 'visible', timeout: 30_000 });
    await touchPlatform.tap(page, channel);
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 30_000,
    });
    await touchPlatform.tap(
      page,
      page.getByRole('button', { name: 'Back to rooms' }),
    );
    await touchPlatform.tap(page, pill);
  }
  await touchPlatform.tap(page, page.getByTestId('space-actions-overflow'));
  await touchPlatform.tap(page, page.getByTestId('open-space-settings'));
}

// A built-in device profile supplies the Android user agent used by Trinity's host layout.
test.use({ ...devices['Pixel 5'] });

test.describe('Space settings on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('opens the directory before General and protects drafts on the full-screen flow', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spmobile`;
    const user = `space-mobile-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Mobile space ${runId}`;
    const roomName = `Mobile room ${runId}`;
    const candidateName = `Mobile candidate ${runId}`;
    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, spaceName);
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    const candidateId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: candidateName, preset: 'private_chat' },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { via: ['localhost'], suggested: true },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceSettings(page, spaceName, touchPlatform, roomName);

    const settings = page.getByTestId('space-settings');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    const box = await settings.boundingBox();
    const viewport = page.viewportSize();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 1);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(
      (viewport?.height ?? 0) - 1,
    );
    const directory = page.getByTestId('space-settings-directory');
    const general = page.getByTestId('space-settings-tab-general');
    await expect(directory).toBeVisible();
    await expect(page.getByTestId('space-settings-panel-general')).toBeHidden();
    await touchPlatform.tap(page, general);
    await expect(
      page.getByTestId('space-settings-panel-general'),
    ).toBeVisible();
    await expect(
      page.getByTestId('space-settings-section-heading'),
    ).toBeFocused();

    const surfaceBox = await settings.boundingBox();
    const accountBox = await page
      .getByTestId('space-settings-account')
      .boundingBox();
    expect((accountBox?.x ?? 0) + (accountBox?.width ?? 0)).toBeLessThanOrEqual(
      (surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0),
    );

    const topic = page.getByTestId('space-settings-topic');
    await expect(
      page.getByTestId('space-settings-general-actions'),
    ).toHaveCount(0);
    await topic.fill('A mobile draft');
    const actions = page.getByTestId('space-settings-general-actions');
    await expect(actions).toBeVisible();
    await expect
      .poll(() =>
        actions.evaluate((element) => getComputedStyle(element).position),
      )
      .toBe('sticky');
    await expect(page.getByTestId('space-settings-discard')).toBeVisible();
    await expect(page.getByTestId('space-settings-save')).toBeVisible();
    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    const discard = page.getByRole('dialog', {
      name: 'Discard Space settings changes?',
    });
    await touchPlatform.tap(
      page,
      discard.getByRole('button', { name: 'Keep editing' }),
    );
    await expect(topic).toHaveValue('A mobile draft');

    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    await touchPlatform.tap(
      page,
      discard.getByRole('button', { name: 'Discard changes' }),
    );
    await expect(directory).toBeVisible();
    const spaceNameBox = await page
      .getByTestId('space-settings-space-name')
      .boundingBox();
    expect(
      (spaceNameBox?.x ?? 0) + (spaceNameBox?.width ?? 0),
    ).toBeLessThanOrEqual((surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0));
    expect((await general.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await test.info().attach('space-settings-mobile-directory', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });

    const forYou = page.getByTestId('space-settings-tab-for-you');
    expect((await forYou.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await touchPlatform.tap(page, forYou);
    await expect(
      page.getByTestId('space-settings-panel-for-you'),
    ).toBeVisible();
    await expect(
      page.getByTestId('space-settings-section-heading'),
    ).toBeFocused();
    const alphabetical = page.getByTestId('space-settings-order-alphabetical');
    expect(
      (await alphabetical.boundingBox())?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
    await touchPlatform.tap(page, alphabetical);
    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    await touchPlatform.tap(
      page,
      discard.getByRole('button', { name: 'Keep editing' }),
    );
    await expect(
      alphabetical.getByRole('radio', { name: 'Alphabetical' }),
    ).toBeChecked();
    await test.info().attach('space-personal-order-mobile', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-for-you-discard'),
    );
    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    await expect(directory).toBeVisible();

    const access = page.getByTestId('space-settings-tab-access');
    expect((await access.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await touchPlatform.tap(page, access);
    await expect(page.getByTestId('space-settings-panel-access')).toBeVisible();
    await expect(
      page.getByTestId('space-settings-section-heading'),
    ).toBeFocused();
    await expect(
      page.getByText(/Rooms inside it keep their own access/),
    ).toBeVisible();
    await expect(page.getByTestId('space-settings-access-actions')).toHaveCount(
      0,
    );
    await test.info().attach('space-access-mobile', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    await expect(directory).toBeVisible();

    const contents = page.getByTestId('space-settings-tab-contents');
    expect((await contents.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await touchPlatform.tap(page, contents);
    const contentsPanel = page.getByTestId('space-settings-panel-contents');
    await expect(
      page.getByTestId('space-settings-section-heading'),
    ).toBeFocused();
    await expect(
      contentsPanel.getByText(roomName, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const createRoom = contentsPanel.getByRole('button', {
      name: 'Create Room',
    });
    expect(
      (await createRoom.boundingBox())?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
    const panelBox = await contentsPanel.boundingBox();
    const createBox = await createRoom.boundingBox();
    expect((createBox?.x ?? 0) + (createBox?.width ?? 0)).toBeLessThanOrEqual(
      (panelBox?.x ?? 0) + (panelBox?.width ?? 0),
    );
    const suggestedControl = contentsPanel.getByTestId(
      `space-content-suggest-control-${roomId}`,
    );
    expect(
      (await suggestedControl.boundingBox())?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
    const suggestedCheckbox = suggestedControl.getByRole('checkbox');
    await expect(suggestedCheckbox).toBeChecked();
    const moveUp = contentsPanel.getByTestId(`space-content-move-up-${roomId}`);
    const moveDown = contentsPanel.getByTestId(
      `space-content-move-down-${roomId}`,
    );
    expect((await moveUp.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await expect(moveUp).toBeDisabled();
    await expect(moveDown).toBeDisabled();
    await touchPlatform.tap(page, suggestedCheckbox);
    await expect
      .poll(
        async () =>
          (await childLink(request, hs, token, spaceId, roomId))?.['suggested'],
        { timeout: 30_000 },
      )
      .not.toBe(true);
    await test.info().attach('space-contents-mobile', {
      body: await captureScreenshot(page, () => contentsPanel.screenshot()),
      contentType: 'image/png',
    });

    await touchPlatform.tap(
      page,
      contentsPanel.getByRole('button', { name: 'Add existing' }),
    );
    await contentsPanel
      .getByLabel('Find a joined Room or Space')
      .fill(candidateName);
    const candidatePick = contentsPanel.getByTestId(
      `space-contents-pick-${candidateId}`,
    );
    await expect(candidatePick).toBeVisible({ timeout: 30_000 });
    await touchPlatform.tap(page, candidatePick);
    const addSelected = contentsPanel.getByRole('button', {
      name: 'Add selected',
    });
    await expect(addSelected).toBeEnabled();
    await touchPlatform.tap(page, addSelected);
    const candidateRow = contentsPanel.getByTestId(
      `space-content-${candidateId}`,
    );
    await expect(candidateRow).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => childLink(request, hs, token, spaceId, candidateId), {
        timeout: 30_000,
      })
      .toEqual(expect.objectContaining({ via: expect.any(Array) }));

    await touchPlatform.tap(page, createRoom);
    const createDialog = page.getByRole('dialog', { name: 'Create Room' });
    await touchPlatform.tap(
      page,
      createDialog.getByRole('button', { name: 'Cancel' }),
    );
    await expect(createDialog).toHaveCount(0);

    await touchPlatform.tap(
      page,
      candidateRow.getByRole('button', { name: 'Remove' }),
    );
    const removeDialog = page.getByRole('dialog', {
      name: 'Remove Room from Space',
    });
    await touchPlatform.tap(
      page,
      removeDialog.getByRole('button', { name: 'Cancel' }),
    );
    await expect(candidateRow).toBeVisible();
    await touchPlatform.tap(
      page,
      candidateRow.getByRole('button', { name: 'Remove' }),
    );
    await touchPlatform.tap(
      page,
      removeDialog.getByRole('button', { name: 'Remove' }),
    );
    await expect
      .poll(() => childLink(request, hs, token, spaceId, candidateId), {
        timeout: 30_000,
      })
      .toEqual({});
    const membership = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(candidateId)}/state/m.room.member/${encodeURIComponent(`@${user}:localhost`)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((response) => response.json());
    expect(membership.membership).toBe('join');

    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    await expect(directory).toBeVisible();

    await touchPlatform.tap(page, general);
    await expect(
      page.getByTestId('space-settings-panel-general'),
    ).toBeVisible();
    await touchPlatform.tap(page, page.getByTestId('space-settings-cancel'));
    await expect(settings).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: spaceName, exact: true }),
    ).toBeVisible();
    await touchPlatform.tap(
      page,
      page.locator('.channel', { hasText: roomName }).first(),
    );
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      roomName,
    );
  });

  test('opens the Members shortcut directly and returns to the directory', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spmembers`;
    const user = `space-members-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Members shortcut ${runId}`;
    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    await createSpace(request, hs, token, spaceName);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const pill = page.getByRole('button', { name: spaceName, exact: true });
    await touchPlatform.tap(page, pill);
    await touchPlatform.tap(page, page.getByTestId('space-actions-overflow'));
    await touchPlatform.tap(page, page.getByTestId('open-space-members'));

    await expect(page.getByTestId('space-settings-panel-members')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('space-settings-directory')).toBeHidden();
    await expect(page.getByTestId('space-settings-section-heading')).toHaveText(
      'Members',
    );
    await expect(page.getByTestId('space-settings-mobile-back')).toBeVisible();

    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    const members = page.getByTestId('space-settings-tab-members');
    await expect(members).toBeVisible();
    await expect(members).toBeFocused();
  });

  test('keeps a member’s Space General readable without writable controls', async ({
    page,
    request,
    touchPlatform,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spreadonly`;
    const owner = `space-phone-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `space-phone-member-${runId}`;
    const memberPass = `${member}-pass`;
    const memberId = `@${member}:localhost`;
    const spaceName = `Phone read only ${runId}`;
    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerToken = await tokenFor(request, hs, owner, ownerPass);
    const memberToken = await tokenFor(request, hs, member, memberPass);
    const spaceId = await createSpace(request, hs, ownerToken, spaceName);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/invite`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: { user_id: memberId },
      },
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/join`,
      { headers: { Authorization: `Bearer ${memberToken}` } },
    );

    await login(page, {
      available: true,
      hs,
      user: member,
      pass: memberPass,
    } as SynapseSession);
    await openSpaceSettings(page, spaceName, touchPlatform);

    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-tab-general'),
    );
    const name = page.getByTestId('space-settings-name');
    const topic = page.getByTestId('space-settings-topic');
    await expect(name).toHaveText(spaceName, { timeout: 10_000 });
    await expect(topic).toHaveText('No topic set.');
    await expect
      .poll(() => name.evaluate((element) => element.tagName))
      .toBe('P');
    await expect
      .poll(() => topic.evaluate((element) => element.tagName))
      .toBe('P');
    await expect(
      page.getByTestId('space-settings-general-actions'),
    ).toHaveCount(0);
    const surface = page.getByTestId('space-settings');
    const surfaceBox = await surface.boundingBox();
    expect(surfaceBox?.width ?? 0).toBeGreaterThan(0);
    await test.info().attach('space-settings-mobile-read-only', {
      body: await captureScreenshot(page, () => surface.screenshot()),
      contentType: 'image/png',
    });
  });
});
