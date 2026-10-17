import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  databaseNames,
  fillLabeledInput,
  login,
  preferenceKeys,
  waitForRooms,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import {
  addAccountViaUi,
  configureMultiAccountSuite,
  expectWorkspaceAccount,
  session,
} from '../../support/multi-account-journey.mts';

// Deleting your own account from Settings › Account on a server with the legacy account
// API: the typed DELETE gate, the password stage of `/account/deactivate`'s UIA, and the
// local cleanup that follows (Rooms for the next account, or sign-in with a notice).
const DEACTIVATE = '/_matrix/client/v3/account/deactivate';

interface Account {
  readonly user: string;
  readonly pass: string;
  readonly userId: string;
}

async function freshAccount(
  request: APIRequestContext,
  label: string,
): Promise<Account> {
  const user = `${label}-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  // The server name is not the client URL's host, so the server says what the ID is.
  const { userId } = await passwordLogin(
    request,
    session.hs as string,
    user,
    pass,
  );
  return { user, pass, userId };
}

async function signIn(page: Page, account: Account): Promise<void> {
  await login(page, {
    ...session,
    user: account.user,
    pass: account.pass,
  } as HomeserverSession);
}

/** Settings › Account › Delete account…, which opens on Cancel. */
async function openDeletion(page: Page): Promise<void> {
  await openSettingsSection(page, 'account');
  await page.getByTestId('delete-account').click();
  await expect(page.getByTestId('delete-account-cancel')).toBeFocused();
}

async function typeConfirmation(page: Page, typed = 'DELETE'): Promise<void> {
  await page.getByTestId('delete-account-confirm-input').fill(typed);
  await page.getByTestId('delete-account-submit').click();
}

async function startDeletion(page: Page, typed = 'DELETE'): Promise<void> {
  await openDeletion(page);
  await typeConfirmation(page, typed);
}

async function answerPassword(page: Page, password: string): Promise<void> {
  const field = page.getByTestId('delete-account-password');
  await expect(field).toBeFocused({ timeout: 30_000 });
  await field.fill(password);
  await page.getByTestId('delete-account-password-submit').click();
}

/** Whether the server still lets a new account take this localpart. */
async function localpartAvailable(
  request: APIRequestContext,
  user: string,
): Promise<boolean> {
  const response = await request.get(
    `${session.hs}/_matrix/client/v3/register/available?username=${encodeURIComponent(user)}`,
  );
  return response.ok();
}

async function ownDatabases(page: Page, account: Account): Promise<string[]> {
  return (await databaseNames(page)).filter((name) =>
    name.includes(account.userId),
  );
}

async function ownPreferenceKeys(
  page: Page,
  account: Account,
): Promise<string[]> {
  const encoded = encodeURIComponent(account.userId);
  return (await preferenceKeys(page)).filter((key) => key.includes(encoded));
}

test.describe('Delete account', () => {
  configureMultiAccountSuite();

  test('deletes the only account, erasing its messages, and confirms it on sign-in', async ({
    page,
    request,
  }) => {
    const account = await freshAccount(request, 'delete-only');
    await signIn(page, account);
    await expect
      .poll(async () => (await ownDatabases(page, account)).length)
      .toBeGreaterThan(0);
    // Trust's forecast is an account-scoped device preference the deletion must forget.
    await expect
      .poll(async () => (await ownPreferenceKeys(page, account)).length)
      .toBeGreaterThan(0);
    const bodies: unknown[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith(DEACTIVATE)) bodies.push(r.postDataJSON());
    });

    await openDeletion(page);
    await expect(page.getByLabel('Also erase my messages')).toBeChecked();
    await typeConfirmation(page);
    await answerPassword(page, account.pass);

    await page.waitForURL((url) => url.pathname === '/login', {
      timeout: 60_000,
    });
    const notice = page.getByTestId('login-account-deleted');
    await expect(notice).toHaveText(
      `Your account ${account.userId} was deleted.`,
    );
    await expect(notice).toBeFocused();
    // The probe carries no auth key at all; the password answer carries erase as well.
    expect(bodies[0]).toEqual({ erase: true });
    expect(bodies.at(-1)).toMatchObject({
      erase: true,
      auth: { type: 'm.login.password' },
    });

    await expect.poll(() => ownDatabases(page, account)).toEqual([]);
    expect(await ownPreferenceKeys(page, account)).toEqual([]);
    // The user ID stays reserved, which is what the dialog promised.
    expect(await localpartAvailable(request, account.user)).toBe(false);

    await fillLabeledInput(page, 'Homeserver', session.hs as string);
    await page.getByText('Continue', { exact: true }).click();
    await fillLabeledInput(page, 'Username', account.user);
    await fillLabeledInput(page, 'Password', account.pass);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Synapse drops a deactivated account's password, so it answers M_FORBIDDEN like any
    // wrong password; a server that sends M_USER_DEACTIVATED gets the plainer wording.
    await expect(
      page.getByText(
        /This account has been deleted\.|Incorrect username or password\./u,
      ),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('deletes the active account and moves to the other one', async ({
    page,
    request,
  }) => {
    const survivor = await freshAccount(request, 'delete-keep');
    const doomed = await freshAccount(request, 'delete-gone');
    await signIn(page, survivor);
    await addAccountViaUi(page, session.hs as string, doomed.user, doomed.pass);
    await expect(page.locator('.userbar__handle')).toContainText(doomed.userId);
    const survivorDatabases = await ownDatabases(page, survivor);
    expect(survivorDatabases.length).toBeGreaterThan(0);

    const bodies: unknown[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith(DEACTIVATE)) bodies.push(r.postDataJSON());
    });
    await openDeletion(page);
    await page.getByLabel('Also erase my messages').uncheck();
    await typeConfirmation(page);
    await answerPassword(page, doomed.pass);

    await waitForRooms(page, 60_000);
    await expectWorkspaceAccount(page, survivor.user);
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(
          `${doomed.userId} was deleted. You’re now using ${survivor.userId}.`,
        ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(bodies[0]).toEqual({ erase: false });

    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);
    await expect(page.getByTestId('account-row')).toContainText(
      survivor.userId,
    );
    await page.keyboard.press('Escape');
    await expect.poll(() => ownDatabases(page, doomed)).toEqual([]);
    expect(await ownDatabases(page, survivor)).toEqual(
      expect.arrayContaining(survivorDatabases),
    );
    expect(
      (
        await passwordLogin(
          request,
          session.hs as string,
          survivor.user,
          survivor.pass,
        )
      ).userId,
    ).toBe(survivor.userId);
  });

  test('keeps the account after a mistyped DELETE and three wrong passwords', async ({
    page,
    request,
  }) => {
    const account = await freshAccount(request, 'delete-kept');
    await signIn(page, account);
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith(DEACTIVATE)) sent.push(r.postData() ?? '');
    });

    await startDeletion(page, 'DELET');
    await expect(
      page.getByTestId('delete-account-confirm-error'),
    ).toContainText('Nothing was deleted. Type DELETE exactly to confirm.');
    await expect(
      page.getByTestId('delete-account-confirm-input'),
    ).toBeFocused();
    expect(sent).toEqual([]);

    await page.getByTestId('delete-account-confirm-input').fill('delete');
    await page.getByTestId('delete-account-submit').click();
    await answerPassword(page, 'wrong-1');
    await expect(
      page.getByTestId('delete-account-password-error'),
    ).toContainText('That password is incorrect. Nothing was deleted.', {
      timeout: 30_000,
    });
    await answerPassword(page, 'wrong-2');
    await expect(page.getByTestId('delete-account-password')).toBeFocused({
      timeout: 30_000,
    });
    await answerPassword(page, 'wrong-3');
    await expect(page.getByTestId('delete-account-stopped')).toContainText(
      'Too many incorrect passwords. Nothing was deleted.',
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('delete-account-retry')).toHaveCount(0);
    await page.getByTestId('delete-account-close').click();

    await waitForRooms(page);
    expect(
      (
        await passwordLogin(
          request,
          session.hs as string,
          account.user,
          account.pass,
        )
      ).userId,
    ).toBe(account.userId);
  });

  test('settles a lost answer with the server, and finishes the deletion', async ({
    page,
    request,
  }) => {
    const account = await freshAccount(request, 'delete-lost');
    await signIn(page, account);
    // The authenticated request reaches the server, which deletes the account; its answer
    // never reaches the app.
    await page.route(`**${DEACTIVATE}`, async (route) => {
      const body = route.request().postDataJSON() as { auth?: unknown };
      if (!body?.auth) return route.continue();
      await route.fetch();
      await route.abort('connectionreset');
    });

    await startDeletion(page);
    await answerPassword(page, account.pass);

    await page.waitForURL((url) => url.pathname === '/login', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('login-account-deleted')).toHaveText(
      `Your account ${account.userId} was deleted.`,
    );
  });
});
