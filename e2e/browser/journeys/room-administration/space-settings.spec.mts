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
      page.getByTestId('space-settings-section-heading'),
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
    await expect(page.getByTestId('space-settings-save')).toBeVisible();
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
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('space-settings-desktop-general-dark-amethyst', {
      body: await settings.screenshot(),
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
      body: await settings.screenshot(),
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

  test('a member without permission sees the fields but cannot edit them', async ({
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
    await joinAsMember(
      request,
      hs,
      ownerToken,
      spaceId,
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

    // Shown, so the member can still READ the space's settings — but not writable.
    await expect(page.getByTestId('space-settings-name')).toHaveValue(
      spaceName,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId('space-settings-name')).toBeDisabled();
    await expect(page.getByTestId('space-settings-topic')).toBeDisabled();
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
    await test.info().attach('space-access-member-read-only', {
      body: await page.getByTestId('space-settings').screenshot(),
      contentType: 'image/png',
    });
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
