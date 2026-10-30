import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Covers Settings → Devices: renaming another session and signing it out, which asks for
// the account password (user-interactive auth). A cancelled prompt keeps the session; a
// wrong password asks again; the right one signs it out on the homeserver.
// Needs a homeserver; self-skips.
const session = homeserverSession();

function dialog(page: Page, text: string) {
  return page.locator('trn-alert-dialog', { hasText: text });
}

test.describe('Device management', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('renames another session and signs it out with the account password', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const user = `devices-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);

    // A second session of the same account, signed in elsewhere.
    const other = await request.post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
        initial_device_display_name: 'Journey tablet',
      },
    });
    expect(other.ok()).toBe(true);
    const { access_token: otherToken, device_id: otherId } =
      (await other.json()) as { access_token: string; device_id: string };
    const devicesOf = (token: string) =>
      request.get(`${hs}/_matrix/client/v3/devices`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openSettingsSection(page, 'devices');
    const section = page.locator('trn-devices-section');
    const row = section.getByTestId('device-row').filter({ hasText: otherId });
    await expect(row).toContainText('Journey tablet', { timeout: 30_000 });

    // Rename: the row and the homeserver both show the new name.
    await row.getByTestId('rename-device').click();
    const rename = dialog(page, 'Rename device');
    await rename.locator('input').fill('Journey phone');
    await rename.getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText('Journey phone', { timeout: 20_000 });
    await expect
      .poll(async () => {
        const body = (await (await devicesOf(otherToken)).json()) as {
          devices: { device_id: string; display_name?: string }[];
        };
        return body.devices.find((d) => d.device_id === otherId)?.display_name;
      })
      .toBe('Journey phone');

    // Sign out, cancelling the password prompt: the session stays, with no error.
    await row.getByTestId('remove-device').click();
    await dialog(page, 'Sign out device')
      .getByRole('button', { name: 'Sign out' })
      .click();
    const password = dialog(page, 'Confirm your password');
    await expect(password).toBeVisible({ timeout: 20_000 });
    await password.getByRole('button', { name: 'Cancel' }).click();
    await expect(password).toBeHidden();
    await expect(row).toBeVisible();
    await expect(section.getByRole('alert')).toHaveCount(0);
    expect((await devicesOf(otherToken)).ok()).toBe(true);

    // Sign out again: a wrong password asks again, the right one signs it out.
    await row.getByTestId('remove-device').click();
    await dialog(page, 'Sign out device')
      .getByRole('button', { name: 'Sign out' })
      .click();
    await expect(password).toBeVisible({ timeout: 20_000 });
    await password.locator('input[type="password"]').fill(`${pass}-wrong`);
    await password.getByRole('button', { name: 'Confirm' }).click();
    await expect(password).toBeVisible({ timeout: 20_000 });
    await expect(password.locator('input[type="password"]')).toHaveValue('');
    await password.locator('input[type="password"]').fill(pass);
    await password.getByRole('button', { name: 'Confirm' }).click();

    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(section.getByRole('alert')).toHaveCount(0);
    // Signing a device out revokes its token.
    await expect
      .poll(async () => (await devicesOf(otherToken)).status())
      .toBe(401);
  });
});
