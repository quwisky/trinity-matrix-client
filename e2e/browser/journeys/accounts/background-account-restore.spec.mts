import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { login } from '../../../support/app.mts';
import { registerUser, apiLogin } from '../../../support/account.mts';
import {
  addAccountViaUi,
  configureMultiAccountSuite,
  session,
} from '../../support/multi-account-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

configureMultiAccountSuite();

/**
 * Hold back every authenticated request of one account, so its restore is still running in the
 * background after the start has settled. Owners are looked up once per access token.
 */
async function delayAccount(
  page: Page,
  request: APIRequestContext,
  hs: string,
  localpart: string,
  delayMs: number,
): Promise<void> {
  const owners = new Map<string, string>();
  await page.route('**/_matrix/client/**', async (route) => {
    const auth = route.request().headers()['authorization'];
    if (auth) {
      let owner = owners.get(auth);
      if (owner === undefined) {
        const who = await request.get(
          `${hs}/_matrix/client/v3/account/whoami`,
          { headers: { authorization: auth } },
        );
        owner = who.ok() ? ((await who.json()).user_id as string) : '';
        owners.set(auth, owner);
      }
      if (owner.startsWith(`@${localpart}:`)) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    await route.fallback().catch(() => undefined);
  });
}

test('an account still restoring in the background is disabled in the switcher until it settles', async ({
  page,
  request,
}) => {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}bg`;
  // A restores slowly; C is settled while A is still restoring; B is the active account.
  const [userA, userB, userC] = ['a', 'b', 'c'].map((n) => `bg-${n}-${runId}`);
  const roomB = `Room B ${runId}`;
  for (const user of [userA, userB, userC]) {
    await registerUser(request, user, `${user}-pass`);
  }
  const b = await apiLogin(request, hs, userB, `${userB}-pass`);
  await createRoom(request, hs, b, roomB);

  await login(page, {
    available: true,
    hs,
    user: userA,
    pass: `${userA}-pass`,
  });
  await addAccountViaUi(page, hs, userC, `${userC}-pass`);
  await addAccountViaUi(page, hs, userB, `${userB}-pass`);
  const handle = page.locator('.userbar__handle');
  await expect(handle).toContainText(`@${userB}:`);

  await delayAccount(page, request, hs, userA, 20_000);
  await page.reload();
  // The active account opens without waiting for the delayed one.
  await expect(page.locator('.channel', { hasText: roomB })).toBeVisible({
    timeout: 8_000,
  });

  const row = (user: string) =>
    page.getByTestId('account-row').filter({ hasText: `@${user}:` });
  await page.getByTestId('user-menu-trigger').click();
  await expect(row(userA)).toHaveAttribute('aria-disabled', 'true');
  await expect(row(userA).getByTestId('account-row-restoring')).toHaveText(
    'Loading…',
  );
  await expect(row(userB)).not.toHaveAttribute('aria-disabled', 'true');
  for (const testId of ['add-account', 'logout']) {
    await expect(page.getByTestId(testId)).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  }

  // A settled account switches at once while A is still restoring.
  await expect(row(userC)).toBeVisible();
  await expect(row(userC)).not.toHaveAttribute('aria-disabled', 'true');
  await row(userC).click();
  await expect(handle).toContainText(`@${userC}:`);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.getByTestId('user-menu-trigger').click();
  await expect(row(userA)).toBeVisible();
  await expect(row(userA)).not.toHaveAttribute('aria-disabled', 'true', {
    timeout: 60_000,
  });
  await expect(row(userA).getByTestId('account-row-restoring')).toHaveCount(0);
  await expect(page.getByTestId('logout')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await row(userA).click();
  await expect(handle).toContainText(`@${userA}:`);
});
