import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {
  login,
  openSettingsTab,
  synapseSession,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers editing a room's settings: the room header's ⚙ button
// (data-testid="open-room-settings") opens a dialog (data-testid="room-settings")
// with Name/Topic fields, gated by the viewer's power level. As the room creator
// (admin), the reader renames the room; the new name round-trips through
// RoomSettingsService.setName → setRoomName → sync and re-labels the room.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

/** Log in over the API and return the access token. */
async function tokenFor(
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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

const HS_SERVER_NAME = 'localhost';

/**
 * Create a space and link `roomId` into it as a child (`m.space.child` with a non-empty
 * `via`, the shape SpacesService.orderedChildIds requires), so the room has a parent space
 * for the `restricted` join rule to point at.
 */
async function linkIntoSpace(
  request: APIRequestContext,
  hs: string,
  token: string,
  spaceName: string,
  roomId: string,
): Promise<string> {
  const spaceId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { via: [HS_SERVER_NAME], suggested: true },
    },
  );
  if (!res.ok()) {
    throw new Error(`m.space.child → ${res.status()} ${await res.text()}`);
  }
  return spaceId;
}

test.describe('Room settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

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
    const runId = `${Date.now().toString(36)}s`;
    const user = `settings-user-${runId}`;
    const pass = `${user}-pass`;
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
      data: { name: originalName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, originalName);

    // Open the room settings dialog and rename the room.
    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('room-settings-name').fill(newName);
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

  test('an admin changes who can join and read history', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ac`;
    const user = `access-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Access ${runId}`;

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
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${access_token}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });

    // Both fields live behind the Access tab now. The two assertions around the switch are
    // deliberate and belong in a browser: the panels are eager, so an inactive one is in the
    // DOM carrying the `hidden` ATTRIBUTE while its `panelClass` sets `display: flex`. What
    // keeps it hidden is Tailwind v4's preflight
    // (`[hidden]:where(:not([hidden='until-found'])) { display: none !important }`) — a bare
    // UA rule would tie with a single class and lose on source order. jsdom cannot tell the
    // two apart, so this is the only place the arrangement is actually checked.
    await expect(page.getByTestId('room-settings-panel-access')).toBeHidden();
    await openSettingsTab(page, 'room-settings', 'access');
    await expect(page.getByTestId('room-settings-panel-general')).toBeHidden();

    // Open the room up: anyone can join, and history is world-readable.
    // `selectOption` only ever drove a native `<select>`; this is a `trn-select` now, whose
    // options live in a CDK portal. Open the trigger, then pick by the id the option carries.
    await page.getByTestId('room-settings-join-rule').click();
    await page.getByTestId('join-rule-public').click();
    await page.getByTestId('room-settings-history').click();
    await page.getByTestId('history-world_readable').click();
    await page.getByTestId('room-settings-save').click();

    // Both state events round-trip to the homeserver.
    const stateValue = async (type: string, key: string): Promise<unknown> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/${type}/`,
        { headers: { Authorization: `Bearer ${access_token}` } },
      );
      return res.ok() ? (await res.json())[key] : undefined;
    };
    await expect
      .poll(() => stateValue('m.room.join_rules', 'join_rule'), {
        timeout: 20_000,
      })
      .toBe('public');
    await expect
      .poll(
        () => stateValue('m.room.history_visibility', 'history_visibility'),
        {
          timeout: 20_000,
        },
      )
      .toBe('world_readable');
  });

  test('an admin lets a space’s members join the room', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}rs`;
    const user = `restrict-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Restricted ${runId}`;
    const spaceName = `Owner ${runId}`;

    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        // Room version 9 so the server will actually enforce MSC3083.
        data: { name: roomName, preset: 'private_chat', room_version: '9' },
      })
      .then((r) => r.json());
    const spaceId = await linkIntoSpace(
      request,
      hs,
      token,
      spaceName,
      room_id as string,
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    // Via the space pill, NOT openRoom's flat Rooms view: linking the room into a space
    // takes it out of that list by design (room-filter-spaceless.spec.mts covers exactly
    // that), so the room the whole test is about is only reachable under its space.
    const pill = page.getByRole('button', { name: spaceName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });
    await openSettingsTab(page, 'room-settings', 'access');
    // The option only exists because the room sits in a space AND its version can enforce
    // the rule — selecting by value proves both held.
    await page.getByTestId('room-settings-join-rule').click();
    await page.getByTestId('join-rule-restricted').click();
    // Selecting the rule reveals a tickbox per parent space, pre-ticked — the allow list
    // is editable state, so the dialog shows it rather than deriving it out of sight.
    await expect(
      page.getByTestId(`room-settings-space-${spaceId}`),
    ).toBeVisible();
    await page.getByTestId('room-settings-save').click();

    // Both halves, deliberately: a write that set the rule and dropped `allow` is the
    // failure that locks everyone out, and it looks identical from the UI.
    const joinRules = async (): Promise<
      Record<string, unknown> | undefined
    > => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.join_rules/`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return res.ok() ? await res.json() : undefined;
    };
    await expect
      .poll(async () => (await joinRules())?.['join_rule'], { timeout: 30_000 })
      .toBe('restricted');
    expect((await joinRules())?.['allow']).toEqual([
      { type: 'm.room_membership', room_id: spaceId },
    ]);
  });

  test('an admin revokes a space’s access by unticking it', async ({
    page,
    request,
  }) => {
    // The counterpart of the test above, and the more dangerous direction: this is the
    // path that takes access AWAY, so it has to be both reachable and exact. Before the
    // tickboxes there was no way to reach it at all — the allow list was derived from the
    // room's parent spaces, so it could only ever grow.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}rv`;
    const user = `revoke-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Revoke ${runId}`;

    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat', room_version: '9' },
      })
      .then((r) => r.json());
    const keptId = await linkIntoSpace(
      request,
      hs,
      token,
      `Kept ${runId}`,
      room_id as string,
    );
    const droppedId = await linkIntoSpace(
      request,
      hs,
      token,
      `Dropped ${runId}`,
      room_id as string,
    );
    // Start restricted to BOTH, so the dialog has something to take away.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.join_rules/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          join_rule: 'restricted',
          allow: [keptId, droppedId].map((id) => ({
            type: 'm.room_membership',
            room_id: id,
          })),
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const pill = page.getByRole('button', {
      name: `Kept ${runId}`,
      exact: true,
    });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'access');
    // Both boxes start ticked because both are in `allow` — the dialog reports the
    // server's state, not the room's parentage.
    const dropped = page.getByTestId(`room-settings-space-${droppedId}`);
    await expect(dropped).toBeVisible({ timeout: 10_000 });
    await dropped.click();
    await page.getByTestId('room-settings-save').click();

    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.join_rules/`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          return res.ok() ? (await res.json())['allow'] : undefined;
        },
        { timeout: 30_000 },
      )
      .toEqual([{ type: 'm.room_membership', room_id: keptId }]);
  });

  test('an admin unbans a member from the banned list', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ub`;
    const admin = `unban-admin-${runId}`;
    const adminPass = `${admin}-pass`;
    const target = `unban-target-${runId}`;
    const targetPass = `${target}-pass`;
    const targetName = `Banned ${runId}`;
    const roomName = `Bans ${runId}`;

    await registerUser(request, admin, adminPass);
    await registerUser(request, target, targetPass);
    const adminAuth = {
      Authorization: `Bearer ${await tokenFor(request, hs, admin, adminPass)}`,
    };
    const targetLogin = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: target },
          password: targetPass,
        },
      })
      .then((r) => r.json());
    const targetId = targetLogin.user_id as string;
    const targetAuth = { Authorization: `Bearer ${targetLogin.access_token}` };

    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(targetId)}/displayname`,
      { headers: targetAuth, data: { displayname: targetName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: adminAuth,
        data: { name: roomName, preset: 'private_chat', invite: [targetId] },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: targetAuth },
    );
    // The admin bans the target so they appear in the room's banned list.
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/ban`,
      { headers: adminAuth, data: { user_id: targetId, reason: 'spam' } },
    );

    await login(page, {
      available: true,
      hs,
      user: admin,
      pass: adminPass,
    } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'bans');
    await expect(page.getByTestId('banned-members')).toBeVisible({
      timeout: 10_000,
    });
    const row = page
      .getByTestId('banned-member')
      .filter({ hasText: targetName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Unban them: the row disappears and the ban is lifted server-side.
    await row.getByTestId('banned-member-unban').click();
    await expect(page.getByText(`Unbanned ${targetName}.`)).toBeVisible({
      timeout: 20_000,
    });

    const membership = async (): Promise<unknown> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.member/${encodeURIComponent(targetId)}`,
        { headers: adminAuth },
      );
      return res.ok() ? (await res.json()).membership : undefined;
    };
    await expect.poll(membership, { timeout: 20_000 }).toBe('leave');
  });

  test('an admin adds a room address and makes it the main one', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}al`;
    const user = `alias-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Addr ${runId}`;

    await registerUser(request, user, pass);
    const login1 = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const auth = { Authorization: `Bearer ${login1.access_token}` };
    const server = (login1.user_id as string).split(':')[1];
    const localpart = `addr-${runId}`;
    const alias = `#${localpart}:${server}`;
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'access');
    await expect(page.getByTestId('room-aliases')).toBeVisible({
      timeout: 10_000,
    });

    // Add a new local address; it appears in the list and resolves in the directory.
    await page.getByTestId('room-alias-input').fill(localpart);
    await page.getByTestId('room-alias-add').click();
    const row = page.getByTestId('room-alias').filter({ hasText: alias });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const resolvedRoom = async (): Promise<unknown> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
        { headers: auth },
      );
      return res.ok() ? (await res.json()).room_id : undefined;
    };
    await expect.poll(resolvedRoom, { timeout: 20_000 }).toBe(room_id);

    // Make it the main (canonical) address; the state event round-trips.
    await row.getByTestId('room-alias-set-main').click();
    await expect(page.getByTestId('room-alias-main')).toBeVisible({
      timeout: 10_000,
    });
    const canonical = async (): Promise<unknown> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.canonical_alias/`,
        { headers: auth },
      );
      return res.ok() ? (await res.json()).alias : undefined;
    };
    await expect.poll(canonical, { timeout: 20_000 }).toBe(alias);
  });

  test('an admin changes the room photo', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}a`;
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
      .locator('.room-settings input[type="file"]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });

    // The upload + m.room.avatar write succeed, surfacing the success toast.
    await expect(page.getByText('Room photo updated.')).toBeVisible({
      timeout: 30_000,
    });
  });
});
