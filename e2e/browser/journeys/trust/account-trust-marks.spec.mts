import { test, expect } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { publishIdentityWithoutRecovery } from '../../../support/cross-signing.mts';
import { addAccountViaUi } from '../../support/multi-account-journey.mts';
import {
  freshAccount,
  setUpEncryption,
} from '../../support/encryption-journey.mts';

// MSC4153 Phase 0, PR 2: every signed-in account shows whether this device is verified
// for it, not only the active one. The marked account has an identity published by
// another client (no recovery); the other account has none, so it carries no mark. Each
// row and block carries its status in `data-trust`, so the checks for a missing mark wait
// for a status first and cannot pass before Trust has read the account. The mark follows
// the status: unlocking with the recovery key removes it without a reload.
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
    await expect(markedRow).toHaveAttribute('data-trust', 'unverified');
    await expect(markedRow).toHaveAccessibleName(/Unverified/);
    const plainRow = page
      .getByTestId('account-row')
      .filter({ hasText: plain.user });
    await expect(plainRow).toHaveAttribute('data-trust', 'not-set-up', {
      timeout: 30_000,
    });
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
    await expect(
      markedBlock.getByRole('heading', { name: /Unverified/ }),
    ).toBeVisible();
    const plainBlock = page.locator(
      `[data-testid="server-block"][data-account^="@${plain.user}:"]`,
    );
    await expect(plainBlock).toHaveAttribute('data-trust', 'not-set-up', {
      timeout: 30_000,
    });
    await expect(plainBlock.getByTestId('hs-account-unverified')).toHaveCount(
      0,
    );
  });

  test('drops the mark once this device unlocks with the recovery key', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const marked = await freshAccount(request, hs, 'unlocks');
    const plain = await freshAccount(request, hs, 'other');

    // Another device sets up recovery, so this device signs in needing it.
    const first = await secondaryApp.launch();
    await login(first, marked.asSession);
    const recoveryKey = await setUpEncryption(first, marked.pass);

    await login(page, marked.asSession);
    await addAccountViaUi(page, hs, plain.user, plain.pass);
    await page.getByTestId('user-menu-trigger').click();
    const markedRow = page
      .getByTestId('account-row')
      .filter({ hasText: marked.user });
    await expect(markedRow).toHaveAttribute('data-trust', 'unverified', {
      timeout: 30_000,
    });
    await expect(markedRow.getByTestId('account-row-unverified')).toHaveText(
      'Unverified',
    );

    // Back to the marked account, which unlocks in place from its banner.
    await markedRow.click();
    await expect(page.locator('.userbar__handle')).toContainText(marked.user);
    const banner = page.locator('trn-encryption-banner trn-banner');
    await banner.getByRole('button', { name: 'Use recovery key' }).click();
    await page.getByTestId('recovery-key-input').fill(recoveryKey);
    await page.getByTestId('unlock-submit').click();
    // Settled: the active account's own prompt goes once this device is unlocked.
    await expect(banner).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('unlock-error')).toHaveCount(0);

    await page.getByTestId('user-menu-trigger').click();
    // The rows are still listed, and the mark is gone because the status moved on.
    await expect(page.getByTestId('account-row')).toHaveCount(2);
    await expect(page.getByTestId('account-row-unverified')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(markedRow).toHaveAttribute('data-trust', 'verified');
  });
});
