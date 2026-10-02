import { expect, test, testResourceId } from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  configureRoomSettingsSuite,
  linkIntoSpace,
  openRoom,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';

test.describe('Room settings', () => {
  configureRoomSettingsSuite();

  test('an admin changes who can join and read history', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ac`;
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

    // Each section owns its form and action row; inactive sections do not compete for focus.
    await expect(page.getByTestId('room-settings-panel-access')).toHaveCount(0);
    await openSettingsTab(page, 'room-settings', 'access');
    await expect(page.getByTestId('room-settings-panel-general')).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId('room-settings-section-heading'),
    ).toBeFocused();
    await expect(page.getByTestId('room-aliases')).toHaveCount(0);

    // Open the room up: anyone can join, and history is world-readable.
    // The public selects use CDK portals. Save from the keyboard after choosing both values.
    const joinRule = page.getByTestId('room-settings-join-rule');
    await joinRule.click();
    await page.getByTestId('join-rule-public').click();
    const history = page.getByTestId('room-settings-history');
    await history.click();
    await page.getByTestId('history-world_readable').click();

    const settings = page.getByTestId('room-settings');
    const openingAppearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
      fontSize: document.documentElement.style.fontSize,
    }));
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('data-theme');
      document.documentElement.style.fontSize = '125%';
    });
    await expect(page.getByTestId('room-settings-save')).toBeVisible();
    await test.info().attach('room-access-admin-light-text-scale', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('room-access-admin-dark-amethyst', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme, fontSize }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.fontSize = fontSize;
    }, openingAppearance);
    const save = page.getByTestId('room-settings-save');
    await save.focus();
    await expect(save).toBeFocused();
    await save.press('Enter');

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

    await openSettingsTab(page, 'room-settings', 'addresses');
    await expect(page.getByTestId('room-aliases')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('an admin lets a space’s members join the room', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}rs`;
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
    const runId = `${testResourceId('run')}rv`;
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
    const unknownAllowEntry = {
      type: 'org.example.membership_claim',
      room_id: keptId,
      issuer: 'example.org',
    };
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.join_rules/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          join_rule: 'restricted',
          allow: [keptId, droppedId]
            .map((id) => ({
              type: 'm.room_membership',
              room_id: id,
            }))
            .concat(unknownAllowEntry),
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
      .toEqual([
        { type: 'm.room_membership', room_id: keptId },
        unknownAllowEntry,
      ]);
  });

  test('a member reads Room policy without a disabled Save footer', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}memberaccess`;
    const owner = `room-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `room-member-${runId}`;
    const memberPass = `${member}-pass`;
    const roomName = `Member access ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerToken = await tokenFor(request, hs, owner, ownerPass);
    const memberToken = await tokenFor(request, hs, member, memberPass);
    const memberId = `@${member}:localhost`;
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.history_visibility/`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: { history_visibility: 'joined' },
      },
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/invite`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: { user_id: memberId },
      },
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: { Authorization: `Bearer ${memberToken}` } },
    );

    await login(page, {
      available: true,
      hs,
      user: member,
      pass: memberPass,
    } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'access');

    await expect(page.getByTestId('room-settings-join-rule')).toContainText(
      'Invite only',
    );
    await expect(page.getByTestId('room-settings-history')).toContainText(
      'Members — since they joined',
    );
    await expect(
      page.getByText("Your role cannot change this room's join rule."),
    ).toBeVisible();
    await expect(
      page.getByText("Your role cannot change this room's history visibility."),
    ).toBeVisible();
    await expect(page.getByTestId('room-settings-access-actions')).toHaveCount(
      0,
    );
    await test.info().attach('room-access-member-read-only', {
      body: await page.getByTestId('room-settings').screenshot(),
      contentType: 'image/png',
    });
  });
});
