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
  roomName?: string,
): Promise<void> {
  const pill = page.getByRole('button', { name, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await pill.tap();
  if (roomName) {
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await channel.waitFor({ state: 'visible', timeout: 30_000 });
    await channel.tap();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Back to rooms' }).tap();
    await pill.tap();
  }
  await page.getByTestId('space-actions-overflow').tap();
  await page.getByTestId('open-space-settings').tap();
}

// A built-in device profile supplies the Android user agent used by Trinity's host layout.
test.use({ ...devices['Pixel 5'] });

test.describe('Space settings on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('uses a full-screen General-to-directory flow with protected drafts', async ({
    page,
    request,
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
    await openSpaceSettings(page, spaceName, roomName);

    const settings = page.getByTestId('space-settings');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    const box = await settings.boundingBox();
    const viewport = page.viewportSize();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 1);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(
      (viewport?.height ?? 0) - 1,
    );
    await expect(
      page.getByTestId('space-settings-panel-general'),
    ).toBeVisible();
    await expect(page.getByTestId('space-settings-directory')).toBeHidden();
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
    await topic.fill('A mobile draft');
    await page.getByTestId('space-settings-mobile-back').tap();
    const discard = page.getByRole('dialog', {
      name: 'Discard Space settings changes?',
    });
    await discard.getByRole('button', { name: 'Keep editing' }).tap();
    await expect(topic).toHaveValue('A mobile draft');

    await page.getByTestId('space-settings-mobile-back').tap();
    await discard.getByRole('button', { name: 'Discard changes' }).tap();
    const directory = page.getByTestId('space-settings-directory');
    await expect(directory).toBeVisible();
    const spaceNameBox = await page
      .getByTestId('space-settings-space-name')
      .boundingBox();
    expect(
      (spaceNameBox?.x ?? 0) + (spaceNameBox?.width ?? 0),
    ).toBeLessThanOrEqual((surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0));
    const general = page.getByTestId('space-settings-tab-general');
    expect((await general.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await test.info().attach('space-settings-mobile-directory', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });

    const forYou = page.getByTestId('space-settings-tab-for-you');
    expect((await forYou.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await forYou.tap();
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
    await alphabetical.tap();
    await page.getByTestId('space-settings-mobile-back').tap();
    await discard.getByRole('button', { name: 'Keep editing' }).tap();
    await expect(
      alphabetical.getByRole('radio', { name: 'Alphabetical' }),
    ).toBeChecked();
    await test.info().attach('space-personal-order-mobile', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.getByTestId('space-settings-for-you-discard').tap();
    await page.getByTestId('space-settings-mobile-back').tap();
    await expect(directory).toBeVisible();

    const access = page.getByTestId('space-settings-tab-access');
    expect((await access.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await access.tap();
    await expect(page.getByTestId('space-settings-panel-access')).toBeVisible();
    await expect(
      page.getByTestId('space-settings-section-heading'),
    ).toBeFocused();
    await expect(
      page.getByText(/Rooms inside it keep their own access/),
    ).toBeVisible();
    const accessSaveBox = await page
      .getByTestId('space-settings-save')
      .boundingBox();
    expect(
      (accessSaveBox?.x ?? 0) + (accessSaveBox?.width ?? 0),
    ).toBeLessThanOrEqual((surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0));
    await test.info().attach('space-access-mobile', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.getByTestId('space-settings-mobile-back').tap();
    await expect(directory).toBeVisible();

    const contents = page.getByTestId('space-settings-tab-contents');
    expect((await contents.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await contents.tap();
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
    await suggestedCheckbox.tap();
    await expect
      .poll(
        async () =>
          (await childLink(request, hs, token, spaceId, roomId))?.['suggested'],
        { timeout: 30_000 },
      )
      .not.toBe(true);
    await test.info().attach('space-contents-mobile', {
      body: await contentsPanel.screenshot(),
      contentType: 'image/png',
    });

    await contentsPanel.getByRole('button', { name: 'Add existing' }).tap();
    await contentsPanel
      .getByLabel('Find a joined Room or Space')
      .fill(candidateName);
    await contentsPanel.getByTestId(`space-contents-pick-${candidateId}`).tap();
    await contentsPanel.getByRole('button', { name: 'Add selected' }).tap();
    const candidateRow = contentsPanel.getByTestId(
      `space-content-${candidateId}`,
    );
    await expect(candidateRow).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => childLink(request, hs, token, spaceId, candidateId), {
        timeout: 30_000,
      })
      .toEqual(expect.objectContaining({ via: expect.any(Array) }));

    await createRoom.tap();
    const createDialog = page.getByRole('dialog', { name: 'Create Room' });
    await createDialog.getByRole('button', { name: 'Cancel' }).tap();
    await expect(createDialog).toHaveCount(0);

    await candidateRow.getByRole('button', { name: 'Remove' }).tap();
    const removeDialog = page.getByRole('dialog', {
      name: 'Remove Room from Space',
    });
    await removeDialog.getByRole('button', { name: 'Cancel' }).tap();
    await expect(candidateRow).toBeVisible();
    await candidateRow.getByRole('button', { name: 'Remove' }).tap();
    await removeDialog.getByRole('button', { name: 'Remove' }).tap();
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

    await page.getByTestId('space-settings-mobile-back').tap();
    await expect(directory).toBeVisible();

    await general.tap();
    await expect(
      page.getByTestId('space-settings-panel-general'),
    ).toBeVisible();
    await page.getByTestId('space-settings-cancel').tap();
    await expect(settings).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: spaceName, exact: true }),
    ).toBeVisible();
    await page.locator('.channel', { hasText: roomName }).first().tap();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      roomName,
    );
  });

  test('keeps a member’s Space General readable without writable controls', async ({
    page,
    request,
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
    await openSpaceSettings(page, spaceName);

    await expect(page.getByTestId('space-settings-name')).toHaveValue(
      spaceName,
      {
        timeout: 10_000,
      },
    );
    await expect(page.getByTestId('space-settings-name')).toBeDisabled();
    await expect(page.getByTestId('space-settings-topic')).toBeDisabled();
    await expect(page.getByTestId('space-settings-save')).toBeDisabled();
    const surface = page.getByTestId('space-settings');
    const surfaceBox = await surface.boundingBox();
    const saveBox = await page.getByTestId('space-settings-save').boundingBox();
    expect((saveBox?.x ?? 0) + (saveBox?.width ?? 0)).toBeLessThanOrEqual(
      (surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0),
    );
    await test.info().attach('space-settings-mobile-read-only', {
      body: await surface.screenshot(),
      contentType: 'image/png',
    });
  });
});
