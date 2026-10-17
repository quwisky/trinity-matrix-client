import { expect, test } from '../../../fixtures.mts';
import { homeserverSession, type SsoAccount } from '../../../support/app.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import { ssoLogin } from '../../support/sso.mts';

// Deleting an account that has no Matrix password: `/account/deactivate` asks for the
// `m.login.sso` stage, which Trinity completes through the homeserver's fallback page in
// the browser. The account is a Dex identity of its own (`ssoDelete`, see
// e2e/support/homeserver/dex.yaml), because a deleted Matrix ID never comes back.
const session = homeserverSession();

test.describe('Delete an SSO account', () => {
  test.skip(
    !session.available || !session.ssoDelete,
    'needs the homeserver + Dex harness (Docker, or native with dex on PATH)',
  );
  test.describe.configure({ timeout: 180_000 });

  test('confirms in the browser, then deletes the account', async ({
    page,
    authPlatform,
  }) => {
    const account = session.ssoDelete as SsoAccount;
    await ssoLogin(page, session, authPlatform, account);
    const handle = page.locator('.userbar__handle');
    await expect(handle).toContainText(`@${account.user}:`);
    const userId = (await handle.textContent())?.trim() ?? '';

    await openSettingsSection(page, 'account');
    await page.getByTestId('delete-account').click();
    await page.getByTestId('delete-account-confirm-input').fill('DELETE');
    await page.getByTestId('delete-account-submit').click();

    const browserStep = page.getByTestId('delete-account-open-page');
    const stopped = page.getByTestId('delete-account-stopped');
    await expect(browserStep.or(stopped)).toBeVisible({ timeout: 30_000 });
    // Synapse offers m.login.sso for an account without a password.
    if (session.kind !== 'synapse' && (await stopped.isVisible())) {
      // A server that offers no stage Trinity can complete says so, and keeps the account.
      await expect(stopped).toContainText(
        'needs a confirmation step Trinity can’t complete',
      );
      test.info().annotations.push({
        type: 'server',
        description: `${session.kind} offers no SSO stage for /account/deactivate`,
      });
      return;
    }

    const confirm = page.getByTestId('delete-account-browser-confirm');
    await expect(confirm).toBeDisabled();
    // ExternalBrowserService opens a new tab on the web.
    const [fallback] = await Promise.all([
      page.context().waitForEvent('page'),
      browserStep.click(),
    ]);
    await fallback.waitForLoadState('domcontentloaded');
    expect(new URL(fallback.url()).pathname).toMatch(
      /\/auth\/m\.login\.sso\/fallback\/web$/u,
    );
    // The homeserver's own confirmation page, then the provider's login form.
    await fallback
      .getByRole('link')
      .or(fallback.getByRole('button'))
      .first()
      .click();
    const email = fallback.locator('#login');
    await email.waitFor({ state: 'visible', timeout: 30_000 }).then(
      async () => {
        await email.fill(account.email);
        await fallback.locator('#password').fill(account.pass);
        await fallback.locator('#submit-login').click();
      },
      () => undefined,
    );
    await expect(fallback.locator('body')).toContainText(
      /return to the application|close this window|Thank you/iu,
      { timeout: 30_000 },
    );

    await expect(confirm).toBeEnabled();
    await confirm.click();

    await page.waitForURL((url) => url.pathname === '/login', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('login-account-deleted')).toHaveText(
      `Your account ${userId} was deleted.`,
    );
  });
});
