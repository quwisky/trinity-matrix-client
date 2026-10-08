import { testResourceId, test, expect } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// An empty room you are alone in offers Invite people, and the prompt leaves once
// something is said. Needs the disposable homeserver (Docker); self-skips.
const session = homeserverSession();

test.describe('Empty room invite prompt', () => {
  test.skip(!session.available, 'needs a homeserver (Docker)');

  test('offers Invite people in an empty room until someone speaks', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const run = `${testResourceId('run')}intro`;
    const user = `intro-${run}`;
    const pass = `${user}-pass`;
    const roomName = `Intro ${run}`;
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

    await login(page, { available: true, hs, user, pass });
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();

    const intro = page.getByTestId('room-intro');
    await expect(intro).toBeVisible({ timeout: 20_000 });
    await intro.getByRole('button', { name: 'Invite people' }).click();
    const invite = page.getByRole('dialog', { name: `Invite to ${roomName}` });
    await expect(invite).toBeVisible();
    await page.keyboard.press('Escape');
    // Typing before the dialog has gone would land in it, not in the composer.
    await expect(invite).toBeHidden();

    await page.getByTestId('composer-input').fill('Hello');
    await page.getByTestId('composer-input').press('Enter');
    await expect(intro).toBeHidden({ timeout: 20_000 });
  });
});
