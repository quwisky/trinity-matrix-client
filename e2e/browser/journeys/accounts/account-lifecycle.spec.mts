import { expect, test, testResourceId } from '../../../fixtures.mts';
import {
  databaseNames,
  fillLabeledInput,
  login,
  preferenceKeys,
  waitForRooms,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  installBadgeRecorder,
  recordedBadgeCalls,
} from '../../../support/platform-badge.mts';
import {
  addAccountViaUi,
  configureMultiAccountSuite,
  expectWorkspaceAccount,
  seedUnreadReader,
  session,
} from '../../support/multi-account-journey.mts';

test.describe('Multiple accounts', () => {
  configureMultiAccountSuite();

  test('adds a second account and switches the active account between them', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}m`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    await registerUser(request, userB, passB);

    // 1. Sign in as account A (the default seeded session user).
    await login(page, session);
    const handleA = `@${session.user}:`;
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    await expectWorkspaceAccount(page, session.user as string);

    // 2. Add account B from the user panel.
    await addAccountViaUi(page, hs, userB, passB);

    // 3. Account B is now the active account.
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    await expectWorkspaceAccount(page, userB);

    // 3b. Per-account encryption status reaches the UI: account B is brand new with
    // no encryption set up, so its setup banner shows — proof the crypto status
    // (its own per-account store) projected onto the newly-active account. Scope to
    // the visible <trn-banner>: the banner also mirrors its message in an off-screen
    // sr-only live region, so a bare getByText would match two elements.
    await expect(
      page.locator('trn-banner').getByText('Set up encryption'),
    ).toBeVisible({
      timeout: 20_000,
    });

    // 4. The switcher lists both accounts.
    await page.getByTestId('user-menu-trigger').click();
    const menu = page.getByRole('menu').last();
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Switch account');
    await expect(menu.getByTestId('show-accounts')).toContainText(
      'Accounts in view',
    );
    await expect(menu.getByTestId('add-account')).toContainText('Add account');
    await expect(menu.getByTestId('logout')).toContainText(
      'Remove account from this device',
    );
    const rows = page.getByTestId('account-row');
    await expect(rows).toHaveCount(2);

    // The overlay is keyboard-dismissable and returns focus to the stable account trigger.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('user-menu-trigger')).toBeFocused();
    await page.getByTestId('user-menu-trigger').click();

    // 5. Switch back to account A from the menu.
    await rows.filter({ hasText: handleA }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    await expectWorkspaceAccount(page, session.user as string);
  });

  test('keeps the Workspace coherent through repeated and consecutive switches', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}r`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    const userC = `multi-c-${runId}`;
    const passC = `multi-c-pass-${runId}`;
    await registerUser(request, userB, passB);
    await registerUser(request, userC, passC);

    await login(page, session);
    await addAccountViaUi(page, hs, userB, passB);
    await addAccountViaUi(page, hs, userC, passC);

    const handleA = `@${session.user}:`;
    const handleB = `@${userB}:`;
    const handleC = `@${userC}:`;
    await expect(page.locator('.userbar__handle')).toContainText(handleC);

    // Switch to B, then select the already-active B row again. The second user action is
    // a no-op and must leave the settled Workspace intact.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('account-row').filter({ hasText: handleB }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleB);
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('account-row').filter({ hasText: handleB }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleB);
    await expect(
      page.getByText('Unable to switch accounts right now.'),
    ).toHaveCount(0);

    // Consecutive real menu actions rebound all visible projections and repair the
    // Workspace on each target; no stale intermediate Account may remain visible.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('account-row').filter({ hasText: handleC }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleC);
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('account-row').filter({ hasText: handleA }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    await expect(
      page.getByText('Unable to switch accounts right now.'),
    ).toHaveCount(0);
  });

  test('the app badge sums unread across accounts, invariant to which is active', async ({
    matrixResources,
    page,
    request,
  }) => {
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

  test('signs one account out while the other keeps running', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}o`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    await registerUser(request, userB, passB);

    const handleA = `@${session.user}:`;
    await login(page, session);
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Sign out the active account (B) from the user panel, confirming the dialog.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();

    // B never set up key backup, so the removal first offers the key export. Export keys
    // opens Security settings, where the export lives, and B stays signed in.
    const keyStep = page.getByRole('dialog', {
      name: 'Room keys are not backed up',
    });
    await expect(keyStep).toContainText(
      'You’ll lose access to encrypted messages on this device.',
    );
    await keyStep.getByTestId('alert-alternative').click();
    await expect(page.getByTestId('security-export-keys')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('security-export-keys')).toBeHidden();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Remove anyway completes the removal.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();
    await keyStep.getByRole('button', { name: 'Remove anyway' }).click();

    // Account A survives and becomes active; the shell stays put (no redirect).
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    await expect(page).toHaveURL(/\/rooms/);

    // The switcher now lists only account A.
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);

    // B's crypto store key went with its store; A's stays.
    const storeKeys = async () =>
      (await preferenceKeys(page)).filter((key) =>
        key.startsWith('secure.matrix.cryptoStoreKey:'),
      );
    await expect
      .poll(async () =>
        (await storeKeys()).some((key) => key.includes(`:@${userB}:`)),
      )
      .toBe(false);
    expect((await storeKeys()).some((key) => key.includes(handleA))).toBe(true);
  });

  test('re-adds a signed-out account without a crypto-store mismatch', async ({
    page,
    request,
  }) => {
    // Regression for the sign-out → sign-in crypto bug: signing an account out then
    // logging it back in used to fail with the Rust-crypto error "the account in the
    // store doesn't match the account in the constructor". Sign-out deleted the wrong
    // encryption store (leaving the account's real one orphaned) and the store was keyed
    // only by user, so the re-login — on a NEW server-issued device — reopened that
    // stale store, initRustCrypto threw, and the client never started. Needs real crypto
    // + persistent IndexedDB across the logout/login cycle, so it lives here, not in a unit.
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}x`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    await registerUser(request, userB, passB);

    const handleA = `@${session.user}:`;
    // Sign in as A, add B (B becomes active).
    await login(page, session);
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Sign B out — its stores are wiped; A survives and becomes active.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();
    await page.getByRole('button', { name: 'Remove anyway' }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleA);

    // Re-add B (the exact reported flow). It logs in fresh on a new device; the add must
    // reach /rooms — addAccountViaUi waits for **/rooms, so a clean crypto start IS the
    // assertion (a mismatch would leave the add spinning on the login screen).
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Both accounts are signed in again.
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(2);
  });

  test('signs the only account out and back in without a crypto-store mismatch', async ({
    page,
  }) => {
    // The single-account variant of the same bug, exercising the full-reset + replace-login
    // path (last-account sign-out wipes everything and returns to /login).
    const handleA = `@${session.user}:`;
    // Sign in — creates and persists this account's encryption store.
    await login(page, session);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);

    // Sign the only account out → the shell returns to /login and the stores are wiped.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();
    await page.getByRole('button', { name: 'Remove anyway' }).click();
    await page.waitForURL('**/login', { timeout: 30_000 });

    // Sign back in on a new device. Before the fix this reopened the previous device's
    // orphaned crypto store and initRustCrypto threw, so /rooms was never reached; login()
    // waits for **/rooms, so reaching it proves the encryption store started clean.
    await login(page, session);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
  });

  test('asks before signing in again replaces a stored account’s keys, and Cancel keeps them', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}k`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    await registerUser(request, userB, passB);

    await login(page, session);
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    const storesOfB = async (): Promise<string[]> =>
      (await databaseNames(page))
        .filter((name) => name.includes(`@${userB}:`))
        .sort();
    await expect
      .poll(async () => (await storesOfB()).length)
      .toBeGreaterThanOrEqual(2);
    const storesBefore = await storesOfB();

    // Sign in to B again through Add account. A password sign-in sends no device id, so
    // the homeserver issues a new device, and saving it would delete B's current keys.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('add-account').click();
    await fillLabeledInput(page, 'Homeserver', hs);
    await page.getByText('Continue', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Sign in' })
      .waitFor({ timeout: 30_000 });
    await fillLabeledInput(page, 'Username', userB);
    await fillLabeledInput(page, 'Password', passB);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // B is live and has no key backup, so the warning comes first and offers the export.
    const warning = page.getByRole('dialog', {
      name: 'Room keys are not backed up',
    });
    await expect(warning).toContainText(
      `Signing in again starts a new session for @${userB}:`,
    );
    await expect(warning.getByTestId('alert-alternative')).toHaveText(
      'Export keys',
    );
    await warning.getByTestId('alert-cancel').click();

    // Cancel leaves B, its device and its stores exactly as they were.
    await expect(
      page.getByText(`Sign-in cancelled. @${userB}:`, { exact: false }),
    ).toBeVisible();
    expect(await storesOfB()).toEqual(storesBefore);
    await page.getByTestId('cancel-add').click();
    await expect(page).toHaveURL(/\/rooms/);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(2);
  });

  test('cancels adding an account and returns to the app', async ({ page }) => {
    const handleA = `@${session.user}:`;
    await login(page, session);

    // Start adding an account, then cancel out of the add-mode login.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('add-account').click();
    await expect(page.getByTestId('cancel-add')).toBeVisible();
    await page.getByTestId('cancel-add').click();

    // Back in the app on account A — still the only signed-in account.
    await expect(page).toHaveURL(/\/rooms/);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);
  });

  test('re-authenticates an account from the /login?reauth prefill', async ({
    page,
  }) => {
    const handleA = `@${session.user}:`;
    await login(page, session);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    const userId = (
      (await page.locator('.userbar__handle').textContent()) ?? ''
    ).trim();

    // Go straight to the re-auth login for the account (as the switcher's re-auth row
    // does). The homeserver step is skipped and the username is prefilled + locked.
    await page.goto(`/login?reauth=${encodeURIComponent(userId)}`, {
      // The existing account keeps /sync open while re-authentication is shown.
      waitUntil: 'domcontentloaded',
    });
    await expect(
      page.getByText('Sign in again to reconnect this account'),
    ).toBeVisible({ timeout: 15_000 });
    const username = page.getByLabel('Username');
    await expect(username).toHaveValue(userId);
    await expect(username).toBeDisabled();

    // Complete the re-auth → back in the app on the same account.
    await fillLabeledInput(page, 'Password', session.pass as string);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await waitForRooms(page);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
  });
});
