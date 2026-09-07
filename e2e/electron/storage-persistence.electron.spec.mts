import { expect, test } from './fixtures.mts';
import { login, synapseSession, waitForRooms } from '../support/app.mts';
import { registerUser } from '../support/account.mts';
import { createElectronProfile, launchApp } from './support/launch.mts';

const session = synapseSession();

test('restores a signed-in Account without a storage warning after restart', async ({
  request,
  matrixResources,
}) => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  const username = matrixResources.userLocalpart('storage-restart');
  const password = `${username}-pass`;
  await registerUser(request, username, password);
  const profile = createElectronProfile();
  let app = await launchApp(profile);
  try {
    const page = await app.firstWindow();
    await login(
      page,
      { ...session, user: username, pass: password },
      async (target, path) => {
        await target.goto(new URL(path, 'trinity://app/').href, {
          waitUntil: 'domcontentloaded',
        });
      },
    );
    const account = new URL(page.url()).searchParams.get('account');
    expect(await page.evaluate(() => navigator.storage.persisted())).toBe(true);

    await app.close();
    app = await launchApp(profile);
    const restored = await app.firstWindow();
    await waitForRooms(restored);
    expect(new URL(restored.url()).searchParams.get('account')).toBe(account);
    expect(await restored.evaluate(() => navigator.storage.persisted())).toBe(
      true,
    );

    await restored.getByTestId('open-system-status').click();
    const status = restored.getByRole('dialog', { name: 'System Status' });
    await expect(status).toBeVisible();
    await expect(status.getByTestId('system-status-all-working')).toBeVisible();
    await expect(
      status.getByText('Protected browser storage is unavailable', {
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
