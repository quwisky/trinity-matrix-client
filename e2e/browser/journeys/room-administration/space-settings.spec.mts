import { captureScreenshot } from '../../../support/screenshot.mts';
import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers editing a SPACE's settings, which had no surface at all before #40: a space was
// configured once at creation and never again. The space overflow menu
// (data-testid="space-actions-overflow") gains a "Space settings" row
// (data-testid="open-space-settings") opening a dialog (data-testid="space-settings") with
// Name/Topic/join-rule fields — trigger and dialog named apart, as the room pair is.
//
// Asserted server-side via the CS API rather than on the dialog closing: a settings dialog
// that closes having written nothing looks identical from the UI, and that is exactly the
// failure this spec exists to catch.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return json.access_token as string;
}

/**
 * Create a space (a room with `creation_content.type: m.space`, matching
 * `SpacesService.createSpace`) as the signed-in user, who is therefore its admin.
 */
async function createSpace(
  request: APIRequestContext,
  hs: string,
  token: string,
  name: string,
): Promise<string> {
  const res = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    },
  });
  if (!res.ok()) {
    throw new Error(`createRoom(space) → ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).room_id as string;
}

/** Create a joined Room owned by the token holder. */
async function createRoom(
  request: APIRequestContext,
  hs: string,
  token: string,
  name: string,
): Promise<string> {
  const response = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, preset: 'private_chat' },
  });
  if (!response.ok()) {
    throw new Error(
      `createRoom → ${response.status()} ${await response.text()}`,
    );
  }
  return (await response.json()).room_id as string;
}

async function putChildLink(
  request: APIRequestContext,
  hs: string,
  token: string,
  spaceId: string,
  childId: string,
): Promise<void> {
  const response = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { via: ['localhost'] },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `m.space.child → ${response.status()} ${await response.text()}`,
    );
  }
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

/**
 * Select the space's rail pill and open its ⋮ overflow. `ServerRailComponent` puts no
 * testid on the pill — it is an `aria-label`ed button named after the space (see
 * room-filter-spaceless.spec.mts, which relies on the same thing).
 */
async function openSpaceMenu(page: Page, spaceName: string): Promise<void> {
  const pill = page.getByRole('button', { name: spaceName, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await pill.click();
  await page.getByTestId('space-actions-overflow').click();
}

/** Read one field out of a room's current state, or undefined if it isn't set. */
async function stateValue(
  request: APIRequestContext,
  hs: string,
  token: string,
  roomId: string,
  type: string,
  key: string,
): Promise<unknown> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return res.ok() ? (await res.json())[key] : undefined;
}

/** Invite `userId` into `spaceId` and accept as that user, so they are a plain member. */
async function joinAsMember(
  request: APIRequestContext,
  hs: string,
  ownerToken: string,
  spaceId: string,
  memberToken: string,
  memberId: string,
): Promise<void> {
  const invite = await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/invite`,
    {
      headers: { Authorization: `Bearer ${ownerToken}` },
      data: { user_id: memberId },
    },
  );
  if (!invite.ok()) {
    throw new Error(`invite → ${invite.status()} ${await invite.text()}`);
  }
  const join = await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/join`,
    { headers: { Authorization: `Bearer ${memberToken}` } },
  );
  if (!join.ok()) {
    throw new Error(`join → ${join.status()} ${await join.text()}`);
  }
}

test.describe('Space settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('an admin renames a space, sets its topic and publishes it', async ({
    page,
    request,
  }) => {
    // Three state events round-tripping through /sync, which is slow under full-suite load.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sp`;
    const user = `space-settings-${runId}`;
    const pass = `${user}-pass`;
    const originalName = `Team ${runId}`;
    const roomName = `Conversation ${runId}`;
    const newName = `Renamed ${runId}`;
    const newTopic = `Where team ${runId} works`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, originalName);
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
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
    const pill = page.getByRole('button', { name: originalName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      roomName,
    );
    // Reactivate the Space sidebar without navigating away from the Conversation.
    // Its overflow belongs to the active Space, while the room surface stays mounted.
    await pill.click();
    await page.getByTestId('space-actions-overflow').click();

    await page.getByTestId('open-space-settings').click();
    const settings = page.getByTestId('space-settings');
    await expect(page.getByTestId('space-settings-name')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('space-settings-directory')).toBeVisible();
    await expect(page.getByTestId('space-settings-account')).toContainText(
      user,
    );
    await expect(
      settings.getByRole('heading', { name: 'Space settings', level: 1 }),
    ).toBeFocused();
    const settingsBox = await settings.boundingBox();
    expect(settingsBox?.width ?? 0).toBeGreaterThan(700);

    const openingViewport = page.viewportSize();
    if (!openingViewport) throw new Error('Space settings needs a viewport');
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.getByTestId('space-settings-directory')).toBeHidden();
    await expect(page.getByTestId('space-settings-mobile-back')).toBeVisible();
    await page.setViewportSize(openingViewport);
    await expect(page.getByTestId('space-settings-directory')).toBeVisible();

    const openingRootSize = await page.evaluate(
      () => document.documentElement.style.fontSize,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    await expect(page.getByTestId('space-settings-cancel')).toBeVisible();
    await expect(
      page.getByTestId('space-settings-general-actions'),
    ).toHaveCount(0);
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, openingRootSize);

    const openingAppearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
    }));
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('data-theme');
    });
    await test.info().attach('space-settings-desktop-general-light', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('space-settings-desktop-general-dark-amethyst', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, openingAppearance);

    const read = (type: string, key: string) =>
      stateValue(request, hs, token, spaceId, type, key);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await page
      .locator('[data-testid="space-settings"] input[type="file"]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
    await expect(
      page.getByLabel('Notifications alt+T').getByText('Space photo updated.'),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => read('m.room.avatar', 'url'), { timeout: 30_000 })
      .toMatch(/^mxc:\/\//);

    await page.getByTestId('space-settings-name').fill(newName);
    await page.getByTestId('space-settings-topic').fill(newTopic);
    await page.getByTestId('space-settings-save').click();
    await expect(
      page.getByTestId('space-settings-general-feedback'),
    ).toContainText(/Name.*topic.*saved|Topic.*name.*saved/i, {
      timeout: 30_000,
    });

    // Access has its own draft and Save; changing sections never commits General implicitly.
    await openSettingsTab(page, 'space-settings', 'access');
    // `selectOption` only ever drove a native `<select>`; this is a `trn-select` now, whose
    // options live in a CDK portal.
    await page.getByTestId('space-settings-join-rule').click();
    await page.getByTestId('join-rule-public').click();
    await test.info().attach('space-access-admin', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.getByTestId('space-settings-save').click();

    await expect
      .poll(() => read('m.room.name', 'name'), { timeout: 30_000 })
      .toBe(newName);
    await expect
      .poll(() => read('m.room.topic', 'topic'), { timeout: 30_000 })
      .toBe(newTopic);
    await expect
      .poll(() => read('m.room.join_rules', 'join_rule'), { timeout: 30_000 })
      .toBe('public');

    await page.getByTestId('space-settings-cancel').click();
    await expect(settings).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      roomName,
    );

    // Deliberately NOT asserting that the rail pill re-labels itself. A rename is an
    // m.room.name state event with no local echo, so the client only sees it once /sync
    // returns it — and that took over 90s on one run here, leaving the pill, the sidebar
    // title and the overflow's own label all reading the old name together (i.e. the SDK's
    // Room.name was stale, not Trinity's projection of it). room-settings.spec.mts covers
    // rename-then-re-label for rooms and documents the same latency; repeating it here
    // buys nothing but a flake.
  });

  test('the dialog seeds from the space’s current values', async ({
    page,
    request,
  }) => {
    // A dialog that opened blank would still save correctly in the test above (every field
    // is "changed" from empty), so seeding needs its own assertion — and the name has to
    // come from m.room.name, not the SDK's fabricated display name.
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sd`;
    const user = `space-seed-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Seeded ${runId}`;
    const topic = `Topic ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, spaceName);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.topic/`,
      { headers: { Authorization: `Bearer ${token}` }, data: { topic } },
    );
    // Deliberately NOT the invite-only rule `preset: private_chat` created: the form model
    // seeds `joinRule: JoinRule.Invite` itself, so asserting "invite" proved nothing — a
    // dialog that read the rule off nothing at all would have passed. Open the space up
    // first, and the assertion below can only hold if the dialog read the real state event.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.join_rules/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { join_rule: 'public' },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();

    await expect(page.getByTestId('space-settings-name')).toHaveValue(
      spaceName,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId('space-settings-topic')).toHaveValue(topic);
    await openSettingsTab(page, 'space-settings', 'access');
    // A `trn-select` collapsed trigger renders the chosen option's LABEL, not its value —
    // there is no form control to call `toHaveValue` on any more.
    await expect(page.getByTestId('space-settings-join-rule')).toHaveText(
      /Anyone can find and join/,
      { timeout: 10_000 },
    );
  });

  test('an admin adds, creates, recovers and unlinks exact Space contents', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}contents`;
    const user = `space-contents-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Contents ${runId}`;
    const linkedName = `Linked ${runId}`;
    const candidateName = `Candidate Room ${runId}`;
    const candidateSpaceName = `Candidate Space ${runId}`;
    const createdSpaceName = `Created Space ${runId}`;
    const recoveredName = `Recovered ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, spaceName);
    const linkedId = await createRoom(request, hs, token, linkedName);
    const candidateId = await createRoom(request, hs, token, candidateName);
    const candidateSpaceId = await createSpace(
      request,
      hs,
      token,
      candidateSpaceName,
    );
    await putChildLink(request, hs, token, spaceId, linkedId);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();
    await openSettingsTab(page, 'space-settings', 'contents');

    const panel = page.getByTestId('space-settings-panel-contents');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(linkedName, { exact: true })).toBeVisible();
    await expect(panel.getByTestId(`space-content-${linkedId}`)).toContainText(
      'Room',
    );

    const openingRootSize = await page.evaluate(
      () => document.documentElement.style.fontSize,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    await expect(
      panel.getByRole('button', { name: 'Create Space' }),
    ).toBeVisible();
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, openingRootSize);

    await panel.getByRole('button', { name: 'Add existing' }).click();
    await panel.getByLabel('Find a joined Room or Space').fill(`Candidate`);
    const candidateRoom = panel.getByTestId(
      `space-contents-pick-${candidateId}`,
    );
    await candidateRoom.getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await panel.getByTestId(`space-contents-pick-${candidateSpaceId}`).click();
    await panel.getByRole('button', { name: 'Add selected' }).click();
    await expect
      .poll(() => childLink(request, hs, token, spaceId, candidateId), {
        timeout: 30_000,
      })
      .toEqual(expect.objectContaining({ via: expect.any(Array) }));
    await expect
      .poll(() => childLink(request, hs, token, spaceId, candidateSpaceId), {
        timeout: 30_000,
      })
      .toEqual(expect.objectContaining({ via: expect.any(Array) }));

    const createdSpaceResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/createRoom') &&
        response.ok(),
    );
    await panel.getByRole('button', { name: 'Create Space' }).click();
    await page.getByPlaceholder('Space name').fill(createdSpaceName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const createdSpaceId = (
      (await (await createdSpaceResponse).json()) as {
        room_id: string;
      }
    ).room_id;
    await expect
      .poll(() => childLink(request, hs, token, spaceId, createdSpaceId), {
        timeout: 30_000,
      })
      .toEqual(expect.objectContaining({ via: expect.any(Array) }));
    await expect(
      panel.getByTestId(`space-content-${createdSpaceId}`),
    ).toContainText('Space', { timeout: 30_000 });

    // Force only the parent-link step to fail. Room creation must survive and expose its
    // id; retry then sends just the link, which proves the recovery path cannot duplicate it.
    const childRoute = '**/state/m.space.child/**';
    let createRequests = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/createRoom')) {
        createRequests += 1;
      }
    });
    await page.route(childRoute, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          errcode: 'M_FORBIDDEN',
          error: 'link rejected',
        }),
      }),
    );
    await panel.getByRole('button', { name: 'Create Room' }).click();
    await page.getByPlaceholder('Room name').fill(recoveredName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const recovery = panel.getByTestId('space-contents-recovery');
    await expect(recovery).toBeVisible({ timeout: 30_000 });
    await expect(recovery).toContainText(recoveredName);
    const recoveredId = (await recovery.locator('p').textContent())?.trim();
    expect(recoveredId).toMatch(/^!/);
    expect(createRequests).toBe(1);

    await page.unroute(childRoute);
    await recovery.getByRole('button', { name: 'Try linking again' }).click();
    await expect(recovery).toHaveCount(0);
    await expect
      .poll(
        () => childLink(request, hs, token, spaceId, recoveredId as string),
        { timeout: 30_000 },
      )
      .toEqual(expect.objectContaining({ via: expect.any(Array) }));
    expect(createRequests).toBe(1);

    // Parent-owned hierarchy policy: retry did not invent a child-side governance write.
    const parentState = await request.get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(recoveredId as string)}/state/m.space.parent/${encodeURIComponent(spaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(parentState.ok()).toBe(false);

    const linkedRow = panel.getByTestId(`space-content-${linkedId}`);
    await linkedRow.getByRole('button', { name: 'Remove' }).click();
    const removeDialog = page.getByRole('dialog', {
      name: 'Remove Room from Space',
    });
    await expect(removeDialog).toContainText(linkedName);
    await expect(removeDialog).toContainText(spaceName);
    await expect(removeDialog).toContainText('not deleted');
    await removeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      childLink(request, hs, token, spaceId, linkedId),
    ).resolves.toEqual(expect.objectContaining({ via: expect.any(Array) }));

    await linkedRow.getByRole('button', { name: 'Remove' }).click();
    await removeDialog.getByRole('button', { name: 'Remove' }).click();
    await expect
      .poll(() => childLink(request, hs, token, spaceId, linkedId), {
        timeout: 30_000,
      })
      .toEqual({});
    const membership = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(linkedId)}/state/m.room.member/${encodeURIComponent(`@${user}:localhost`)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((response) => response.json());
    expect(membership.membership).toBe('join');

    await test.info().attach('space-contents-desktop', {
      body: await captureScreenshot(page, () => panel.screenshot()),
      contentType: 'image/png',
    });

    const createdSpaceRow = panel.getByTestId(
      `space-content-${createdSpaceId}`,
    );
    await createdSpaceRow.getByRole('button', { name: 'Remove' }).click();
    const removeSpaceDialog = page.getByRole('dialog', {
      name: 'Remove Space from Space',
    });
    await expect(removeSpaceDialog).toContainText(createdSpaceName);
    await expect(removeSpaceDialog).toContainText(spaceName);
    await removeSpaceDialog.getByRole('button', { name: 'Remove' }).click();
    await expect
      .poll(() => childLink(request, hs, token, spaceId, createdSpaceId), {
        timeout: 30_000,
      })
      .toEqual({});
    const createdSpaceMembership = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(createdSpaceId)}/state/m.room.member/${encodeURIComponent(`@${user}:localhost`)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((response) => response.json());
    expect(createdSpaceMembership.membership).toBe('join');

    const appearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
    }));
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('space-contents-desktop-dark-amethyst', {
      body: await captureScreenshot(page, () => panel.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, appearance);

    const userId = `@${user}:localhost`;
    const powerLevels = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((response) => response.json());
    const demote = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          ...powerLevels,
          users: { ...powerLevels.users, [userId]: 0 },
        },
      },
    );
    expect(demote.ok()).toBe(true);
    await expect(panel.getByTestId('space-contents-actions')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(
      panel.getByTestId(`space-content-${candidateSpaceId}`),
    ).toBeVisible();
    await expect(
      panel.getByTestId(`space-content-unlink-${candidateSpaceId}`),
    ).toHaveCount(0);
    await expect(
      panel.getByTestId(`space-content-suggest-${candidateSpaceId}`),
    ).toHaveCount(0);
    await expect(
      panel.getByTestId(`space-content-move-up-${candidateSpaceId}`),
    ).toHaveCount(0);
  });

  test('a member without permission sees plain General values without actions', async ({
    page,
    request,
  }) => {
    // The dialog is seeded per-field from the viewer's power level. Proving that reaches
    // the UI matters more for a space than a room: a space is where "who can administer
    // this" is least obvious, and a form that looked editable and then failed on Save
    // would be indistinguishable from a broken write.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ro`;
    const owner = `space-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `space-member-${runId}`;
    const memberPass = `${member}-pass`;
    const spaceName = `ReadOnly ${runId}`;
    const childName = `Visible child ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerToken = await apiLogin(request, hs, owner, ownerPass);
    const memberLogin = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: member },
          password: memberPass,
        },
      })
      .then((r) => r.json());
    const spaceId = await createSpace(request, hs, ownerToken, spaceName);
    const childId = await createRoom(request, hs, ownerToken, childName);
    await putChildLink(request, hs, ownerToken, spaceId, childId);
    await joinAsMember(
      request,
      hs,
      ownerToken,
      spaceId,
      memberLogin.access_token as string,
      memberLogin.user_id as string,
    );
    await joinAsMember(
      request,
      hs,
      ownerToken,
      childId,
      memberLogin.access_token as string,
      memberLogin.user_id as string,
    );

    await login(page, {
      available: true,
      hs,
      user: member,
      pass: memberPass,
    } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();

    // Shown as text, so the member can still READ the Space details without a
    // disabled form implying that they can save them.
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
    await openSettingsTab(page, 'space-settings', 'access');
    await expect(page.getByTestId('space-settings-join-rule')).toBeDisabled();
    await expect(
      page.getByText("Your role cannot change this room's join rule."),
    ).toBeVisible();
    await expect(
      page.getByText(/Rooms inside it keep their own access/),
    ).toBeVisible();
    await expect(page.getByTestId('space-settings-access-actions')).toHaveCount(
      0,
    );
    await openSettingsTab(page, 'space-settings', 'contents');
    const contents = page.getByTestId('space-settings-panel-contents');
    await expect(contents.getByText(childName, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(contents.getByTestId('space-contents-actions')).toHaveCount(0);
    await expect(
      contents.getByTestId(`space-content-unlink-${childId}`),
    ).toHaveCount(0);
    await expect(
      contents.getByTestId('space-contents-read-only'),
    ).toBeVisible();
    await test.info().attach('space-access-member-read-only', {
      body: await captureScreenshot(page, () =>
        page.getByTestId('space-settings').screenshot(),
      ),
      contentType: 'image/png',
    });
  });

  test('keeps a dirty General edit visible and readonly after permission is lost', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}permissionloss`;
    const owner = `space-permission-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `space-permission-member-${runId}`;
    const memberPass = `${member}-pass`;
    const memberId = `@${member}:localhost`;
    const spaceName = `Permission loss ${runId}`;
    const unsavedTopic = `Keep this draft ${runId}`;
    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerToken = await apiLogin(request, hs, owner, ownerPass);
    const memberToken = await apiLogin(request, hs, member, memberPass);
    const spaceId = await createSpace(request, hs, ownerToken, spaceName);
    await joinAsMember(request, hs, ownerToken, spaceId, memberToken, memberId);

    const powerLevels = (await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      )
      .then((response) => response.json())) as Record<string, unknown>;
    const setMemberPower = async (power: number): Promise<void> => {
      const response = await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          data: {
            ...powerLevels,
            users: {
              ...(powerLevels.users as Record<string, number> | undefined),
              [memberId]: power,
            },
          },
        },
      );
      if (!response.ok()) {
        throw new Error(
          `set member power → ${response.status()} ${await response.text()}`,
        );
      }
    };
    await setMemberPower(50);

    await login(page, {
      available: true,
      hs,
      user: member,
      pass: memberPass,
    } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();
    const topic = page.getByTestId('space-settings-topic');
    await expect(topic).toBeEditable({ timeout: 20_000 });
    await topic.fill(unsavedTopic);
    await expect(
      page.getByTestId('space-settings-general-actions'),
    ).toBeVisible();

    await setMemberPower(0);
    await expect(topic).toHaveAttribute('aria-readonly', 'true', {
      timeout: 30_000,
    });
    await expect(topic).toHaveValue(unsavedTopic);
    await expect(
      page.getByText('This unsaved Topic edit is now read-only.'),
    ).toBeVisible();
    await expect(page.getByTestId('space-settings-discard')).toBeVisible();
    await expect(page.getByTestId('space-settings-save')).toBeDisabled();
  });

  test('an admin publishes an address for the space', async ({
    page,
    request,
  }) => {
    // The space dialog embeds the same addresses section as the room one. It is also the
    // only e2e that drives that input inside the SPACE form, where a bare Enter used to
    // submit the dialog and close it instead of adding the address.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sa`;
    const user = `space-addr-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Addressed ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, spaceName);
    const localpart = `space-addr-${runId}`;
    const alias = `#${localpart}:localhost`;

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();
    await openSettingsTab(page, 'space-settings', 'addresses');
    await expect(page.getByTestId('room-aliases')).toBeVisible({
      timeout: 10_000,
    });

    // Enter, deliberately — not the Add button. This is the path that used to save and
    // close the dialog via implicit form submission.
    await page.getByTestId('room-alias-input').fill(localpart);
    await page.getByTestId('room-alias-input').press('Enter');

    // The dialog is still open (Enter must not have submitted it) and the address is live.
    // The DIALOG, not the name field: that field lives on the General tab, and this test is
    // standing on Addresses — a still-open dialog would have failed a visibility check on it.
    await expect(page.getByTestId('space-settings')).toBeVisible();
    await expect(
      page.getByTestId('room-alias').filter({ hasText: alias }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
          );
          return res.ok() ? (await res.json()).room_id : undefined;
        },
        { timeout: 20_000 },
      )
      .toBe(spaceId);
  });

  test('Space settings names the creator Owner and an equal-power member Admin', async ({
    page,
    request,
  }) => {
    // A space IS a room, so it has a creator, and the same Owner/Admin distinction
    // applies — which is only visible once two people share the top power level.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}som`;
    const owner = `space-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const other = `space-admin-${runId}`;
    const otherPass = `${other}-pass`;
    const spaceName = `Owned ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, other, otherPass);
    const ownerToken = await apiLogin(request, hs, owner, ownerPass);
    const otherLogin = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: other },
          password: otherPass,
        },
      })
      .then((r) => r.json());
    const otherId = otherLogin.user_id as string;
    const spaceId = await createSpace(request, hs, ownerToken, spaceName);
    await joinAsMember(
      request,
      hs,
      ownerToken,
      spaceId,
      otherLogin.access_token as string,
      otherId,
    );
    // Promote them to the SAME power the creator holds — the case a power level alone
    // cannot tell apart. Read the CURRENT power levels and merge, rather than PUTting a
    // bare `users` map: this event also carries `events`, `state_default` and friends,
    // and replacing it wholesale would silently drop them.
    const ownerId = (
      await request
        .get(`${hs}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        })
        .then((r) => r.json())
    ).user_id as string;
    const currentPowers = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      )
      .then((r) => r.json());
    const powersRes = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: {
          ...currentPowers,
          users: { ...currentPowers.users, [ownerId]: 100, [otherId]: 100 },
        },
      },
    );
    // Checked like every other request here: a 403 must fail loudly rather than surface
    // later as a confusing assertion timeout.
    if (!powersRes.ok()) {
      throw new Error(
        `set power levels → ${powersRes.status()} ${await powersRes.text()}`,
      );
    }

    await login(page, {
      available: true,
      hs,
      user: owner,
      pass: ownerPass,
    } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-members').click();
    await expect(page.getByTestId('space-settings')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('space-settings-section-heading')).toHaveText(
      'Members',
    );

    const roster = page.getByTestId('member-list');
    const ownerGroup = roster.getByRole('group', { name: /Owner/ });
    const adminGroup = roster.getByRole('group', { name: /Admin/ });
    await expect(ownerGroup.getByTestId('member-row')).toContainText(owner, {
      timeout: 20_000,
    });
    await expect(adminGroup.getByTestId('member-row')).toContainText(other);
  });
});
