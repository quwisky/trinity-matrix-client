import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { createRoom } from '../../support/space-journey.mts';

// Covers Settings › Privacy › Invites: choosing "Block all invites" stores the MSC4380
// invite permission config, after which the invitee's homeserver turns the invite down
// (M_INVITE_BLOCKED). The inviter sees "{name} isn't accepting invites." and the invitee
// never receives the invite. Needs a homeserver that supports invite blocking.
const session = homeserverSession();

test.describe('Block unwanted invites', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('an invite to someone who blocks invites is turned down and never arrives', async ({
    page,
    request,
    secondaryApp,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ib`;
    const invitee = `invblock-bob-${runId}`;
    const inviteePass = `${invitee}-pass`;
    const inviter = `invblock-alice-${runId}`;
    const inviterPass = `${inviter}-pass`;
    const roomName = `Invite blocking ${runId}`;

    await registerUser(request, invitee, inviteePass);
    await registerUser(request, inviter, inviterPass);
    const bob = await passwordLogin(request, hs, invitee, inviteePass);
    const alice = await passwordLogin(request, hs, inviter, inviterPass);
    const aliceAuth = { Authorization: `Bearer ${alice.accessToken}` };
    const bobName = `Bob ${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(bob.userId)}/displayname`,
      {
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        data: { displayname: bobName },
      },
    );
    const room_id = await createRoom(request, hs, alice, roomName);

    // Bob turns every invite down.
    await login(page, {
      available: true,
      hs,
      user: invitee,
      pass: inviteePass,
    } as HomeserverSession);
    await openSettingsSection(page, 'privacy');
    const invites = page.getByTestId('privacy-invites');
    await expect(
      invites.getByRole('radiogroup', { name: 'Who can invite you' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      invites.getByRole('radio', { name: /Allow all invites/ }),
    ).toBeChecked();
    await invites.getByTestId('privacy-invites-block').click();
    await expect(
      invites.getByRole('radio', { name: /Block all invites/ }),
    ).toBeChecked();
    const bobAuth = { Authorization: `Bearer ${bob.accessToken}` };
    const configUrl = (type: string) =>
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(bob.userId)}/account_data/${type}`;
    await expect
      .poll(
        async () => {
          for (const type of [
            'm.invite_permission_config',
            'org.matrix.msc4380.invite_permission_config',
          ]) {
            const res = await request.get(configUrl(type), {
              headers: bobAuth,
            });
            if (res.ok() && (await res.json()).default_action === 'block') {
              return true;
            }
          }
          return false;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(invites.getByRole('alert')).toHaveCount(0);

    // Alice tries to invite Bob from her own app.
    const alicePage = await secondaryApp.launch();
    await login(alicePage, {
      available: true,
      hs,
      user: inviter,
      pass: inviterPass,
    } as HomeserverSession);
    await openRoom(alicePage, roomName);
    await alicePage.getByTestId('room-actions-overflow').click();
    await alicePage.getByTestId('overflow-invite-people').click();
    await alicePage.getByLabel('@user:server or a name').fill(bob.userId);
    await alicePage
      .getByRole('button', { name: 'Invite', exact: true })
      .click();
    // The picker names Bob when its directory search returned him, else by his user ID.
    await expect(
      alicePage
        .getByText(`${bobName} isn't accepting invites.`)
        .or(alicePage.getByText(`${bob.userId} isn't accepting invites.`))
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    // The invite never reached Bob.
    const members = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/members`,
        { headers: aliceAuth },
      )
      .then((r) => r.json());
    expect(
      (members.chunk as { state_key: string }[]).some(
        (event) => event.state_key === bob.userId,
      ),
    ).toBe(false);
    await secondaryApp.activatePrimary();
    await expect(
      page.getByRole('button', { name: `Accept invite to ${roomName}` }),
    ).toHaveCount(0);
  });
});
