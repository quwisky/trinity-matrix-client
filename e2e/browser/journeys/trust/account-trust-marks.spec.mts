import { test, expect } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { publishIdentityWithoutRecovery } from '../../../support/cross-signing.mts';
import { addAccountViaUi } from '../../support/multi-account-journey.mts';
import { freshAccount } from '../../support/encryption-journey.mts';

// MSC4153 Phase 0, PR 2: every signed-in account shows whether this device is verified
// for it, not only the active one. The marked account has an identity published by
// another client (no recovery); the other account has none, so it carries no mark.
// Needs a homeserver; self-skips without one.
const session = homeserverSession();

test.describe('Trust marks for every signed-in account', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('marks the background account whose device here is unverified', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const marked = await freshAccount(request, hs, 'marked');
    const plain = await freshAccount(request, hs, 'plain');
    await publishIdentityWithoutRecovery(request, hs, marked.user, marked.pass);

    await login(page, marked.asSession);
    await addAccountViaUi(page, hs, plain.user, plain.pass);

    // The switcher: the background account is marked, by text, inside its row's name.
    await page.getByTestId('user-menu-trigger').click();
    const markedRow = page
      .getByTestId('account-row')
      .filter({ hasText: marked.user });
    await expect(markedRow.getByTestId('account-row-unverified')).toHaveText(
      'Unverified',
      { timeout: 30_000 },
    );
    await expect(markedRow).toHaveAccessibleName(/Unverified/);
    const plainRow = page
      .getByTestId('account-row')
      .filter({ hasText: plain.user });
    await expect(plainRow).toBeVisible();
    await expect(plainRow.getByTestId('account-row-unverified')).toHaveCount(0);

    // The desktop "Accounts in view" submenu draws the same mark in its option.
    await page.getByTestId('show-accounts').hover();
    await expect(
      page.getByRole('menuitemcheckbox', {
        name: new RegExp(`${marked.user}.*Unverified`),
      }),
    ).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Settings › Server marks the same account's block, and only that one.
    await page.goto('/settings/server', { waitUntil: 'domcontentloaded' });
    const markedBlock = page.locator(
      `[data-testid="server-block"][data-account^="@${marked.user}:"]`,
    );
    await expect(markedBlock.getByTestId('hs-account-unverified')).toHaveText(
      'Unverified',
      { timeout: 30_000 },
    );
    const plainBlock = page.locator(
      `[data-testid="server-block"][data-account^="@${plain.user}:"]`,
    );
    await expect(plainBlock).toBeVisible();
    await expect(plainBlock.getByTestId('hs-account-unverified')).toHaveCount(
      0,
    );
  });
});
