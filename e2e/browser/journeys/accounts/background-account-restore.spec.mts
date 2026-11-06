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
  const userA = `bg-a-${runId}`;
  const userB = `bg-b-${runId}`;
  const roomB = `Room B ${runId}`;
  await registerUser(request, userA, `${userA}-pass`);
  await registerUser(request, userB, `${userB}-pass`);
  const b = await apiLogin(request, hs, userB, `${userB}-pass`);
  await createRoom(request, hs, b, roomB);

  await login(page, {
    available: true,
    hs,
    user: userA,
    pass: `${userA}-pass`,
  });
  await addAccountViaUi(page, hs, userB, `${userB}-pass`);
  await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

  await delayAccount(page, request, hs, userA, 8_000);
  await page.reload();
  // The active account opens without waiting for the delayed one.
  await expect(page.locator('.channel', { hasText: roomB })).toBeVisible({
    timeout: 6_000,
  });

  await page.getByTestId('user-menu-trigger').click();
  const rowA = page
    .getByTestId('account-row')
    .filter({ hasText: `@${userA}:` });
  const rowB = page
    .getByTestId('account-row')
    .filter({ hasText: `@${userB}:` });
  await expect(rowA).toHaveAttribute('aria-disabled', 'true');
  await expect(rowA.getByTestId('account-row-restoring')).toHaveText(
    'Loading…',
  );
  await expect(rowB).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('add-account')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByTestId('logout')).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  await page.unroute('**/_matrix/client/**');
  await expect(rowA).not.toHaveAttribute('aria-disabled', 'true', {
    timeout: 45_000,
  });
  await expect(rowA.getByTestId('account-row-restoring')).toHaveCount(0);
  await expect(page.getByTestId('logout')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
});
