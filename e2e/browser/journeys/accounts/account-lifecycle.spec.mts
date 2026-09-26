import { expect, test } from '../../../fixtures.mts';
import { isAndroidE2E, login } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  installBadgeRecorder,
  recordedBadgeCalls,
} from '../../../support/platform-badge.mts';
import {
  addAccountViaUi,
  configureMultiAccountSuite,
  seedUnreadReader,
  session,
} from '../../support/multi-account-journey.mts';

test.describe('Multiple accounts', () => {
  configureMultiAccountSuite();

  test('the app badge sums unread across accounts, invariant to which is active', async ({
    matrixResources,
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'Android runs this through android.accounts-workspace (#672).',
    );
    const hs = session.hs as string;
    const SEED = 2;

    // Account A: fresh, zero unread. Account B: seeded with SEED unread messages.
    const userA = matrixResources.userLocalpart('badge-primary');
    const passA = `${userA}-pass`;
    await registerUser(request, userA, passA);
    const b = await seedUnreadReader(request, hs, SEED, matrixResources);

    await installBadgeRecorder(page);

    // Sign in as A (0 unread), then add B (SEED unread) — B becomes active.
    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, b.user, b.pass);
    await expect(page.locator('.userbar__handle')).toContainText(`@${b.user}:`);

    // The badge reflects the cross-account total: A(0) + B(SEED) = SEED.
    await page.waitForFunction(
      (seed) => {
        const w = window as unknown as { __appBadgeCalls?: unknown[][] };
        return (w.__appBadgeCalls ?? []).some(
          (call) => call[0] === 'set' && call[1] === seed,
        );
      },
      SEED,
      { timeout: 30_000, polling: 300 },
    );

    // Switch to account A (0 unread of its own). Because the total is aggregated
    // across every account, B's unread still counts — the badge must NOT clear or
    // drop to A's zero (active-only aggregation would). The switch is confirmed by
    // the user-bar handle, after which no further badge update should have fired.
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${userA}:` })
      .click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`);

    const calls = await recordedBadgeCalls(page);
    const lastSet = [...calls].reverse().find((call) => call[0] === 'set');
    expect(lastSet?.[1]).toBe(SEED); // still B's unread, not A's zero
    expect(calls[calls.length - 1]).not.toEqual(['clear']);
  });
});
