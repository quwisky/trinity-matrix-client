import { test, expect, testResourceId } from '../../../fixtures.mts';
import { fillLabeledInput, synapseSession } from '../../../support/app.mts';
import { passwordLogin } from '../../../support/account.mts';

const session = synapseSession();

test.describe('Legacy Matrix registration', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('creates a password account through UIA and enters encryption setup', async ({
    page,
    request,
  }) => {
    const runId = testResourceId('registration');
    const username = `signup-${runId}`;
    const password = `Trinity-registration-${runId}`;

    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', session.hs as string);
    await page.getByText('Continue', { exact: true }).click();

    // The button is gated by GET /register/available; reaching it proves the login
    // screen did not merely assume that every password homeserver accepts accounts.
    const createAccount = page.getByTestId('password-register');
    await expect(createAccount).toBeVisible({ timeout: 30_000 });
    await createAccount.click();
    await page.waitForURL('**/register?**');

    await fillLabeledInput(page, 'Username', username);
    await fillLabeledInput(page, 'Password', password);
    await fillLabeledInput(page, 'Confirm password', password);
    await page.getByTestId('register-submit').click();

    // The disposable Synapse advertises m.login.dummy. The SDK auto-completes that
    // UIA stage, Trinity establishes the returned session, and a brand-new account
    // goes directly to first-device encryption setup rather than recovery unlock.
    await page.waitForURL('**/encryption/setup', { timeout: 60_000 });

    // Independently prove the server-side account exists with the chosen password.
    // This avoids a vacuous pass where a mocked/local session alone reached the route.
    const account = await passwordLogin(
      request,
      session.hs as string,
      username,
      password,
    );
    expect(account.userId).toBe(`@${username}:localhost`);
  });
});
