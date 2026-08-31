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
});
