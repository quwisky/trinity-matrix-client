import { test, expect, testResourceId, type Page } from '../../../fixtures.mts';
import { fillLabeledInput, homeserverSession } from '../../../support/app.mts';
import { passwordLogin } from '../../../support/account.mts';
import { latestLink } from '../../../support/mailbox.mts';

const session = homeserverSession();

/** From the login screen to the submitted registration form. */
async function submitRegistration(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
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
}

test.describe('Legacy Matrix registration', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('creates a password account through UIA and enters encryption setup', async ({
    page,
    request,
  }) => {
    const runId = testResourceId('registration');
    const username = `signup-${runId}`;
    const password = `Trinity-registration-${runId}`;

    await submitRegistration(page, username, password);

    // The disposable Synapse advertises m.login.dummy. Trinity completes that UIA
    // stage on its own, establishes the returned session, and a brand-new account
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

  test('creates an account through the email stage once the mailed link is opened', async ({
    page,
    request,
  }) => {
    test.skip(
      (session.unavailable ?? []).includes('mail'),
      'needs a homeserver that sends email, with the harness Mailpit',
    );
    const runId = testResourceId('registration-email');
    const username = `signup-mail-${runId}`;
    const password = `Trinity-registration-${runId}`;
    const email = `${username}@example.test`;
    // Synapse offers a dummy and an email flow, and Trinity takes the shorter dummy one;
    // offering only the email flow makes it walk the real email stage.
    await page.route('**/_matrix/client/v3/register', async (route) => {
      const response = await route.fetch();
      const body = (await response.json().catch(() => null)) as {
        flows?: unknown;
      } | null;
      if (response.status() !== 401 || !body?.flows) {
        return route.fulfill({ response });
      }
      return route.fulfill({
        response,
        json: { ...body, flows: [{ stages: ['m.login.email.identity'] }] },
      });
    });

    await submitRegistration(page, username, password);
    await fillLabeledInput(page, 'Email address', email);
    await page.getByRole('button', { name: 'Send verification email' }).click();
    const verified = page.getByRole('button', { name: 'I verified my email' });
    await expect(verified).toBeVisible({ timeout: 30_000 });

    // The registration link validates the address when opened.
    const link = await latestLink(request, email, session.hs as string);
    expect((await request.get(link)).ok()).toBe(true);
    await verified.click();

    await page.waitForURL('**/encryption/setup', { timeout: 60_000 });
    const account = await passwordLogin(
      request,
      session.hs as string,
      username,
      password,
    );
    expect(account.userId).toBe(`@${username}:localhost`);
  });
});
