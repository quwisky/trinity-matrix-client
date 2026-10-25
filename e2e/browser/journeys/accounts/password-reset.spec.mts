import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { fillLabeledInput, homeserverSession } from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { confirmResetLink, latestLink } from '../../../support/mailbox.mts';

// Resetting a forgotten password from the sign-in page. Synapse mails the link to the
// harness Mailpit; the spec confirms it the way a mail client would, then returns to the
// open reset page.
const session = homeserverSession();
const hs = session.hs as string;
const NOT_CONFIRMED = 'Confirm the link in the email first, then try again.';
const UNKNOWN_ADDRESS =
  "Trinity couldn't send a link to that address. Check it, or use the address on your account.";

interface Account {
  readonly user: string;
  readonly pass: string;
  readonly address: string;
  readonly accessToken: string;
}

/** An account with a validated email address and a second token the reset may revoke. */
async function accountWithEmail(request: APIRequestContext): Promise<Account> {
  const user = `reset-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  const address = `${user}@example.test`;
  await registerUser(request, user, pass);
  const { accessToken } = await passwordLogin(request, hs, user, pass);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const clientSecret = `secret-${user}`;

  const token = await request.post(
    `${hs}/_matrix/client/v3/account/3pid/email/requestToken`,
    {
      headers,
      data: { client_secret: clientSecret, email: address, send_attempt: 1 },
    },
  );
  expect(token.ok(), `requestToken: ${await token.text()}`).toBe(true);
  const { sid } = (await token.json()) as { sid: string };

  const link = await request.get(await latestLink(request, address, hs));
  expect(link.ok(), `add-address link: ${await link.text()}`).toBe(true);

  const add = `${hs}/_matrix/client/v3/account/3pid/add`;
  const challenge = await request.post(add, {
    headers,
    data: { client_secret: clientSecret, sid },
  });
  expect(challenge.status(), await challenge.text()).toBe(401);
  const { session: uia } = (await challenge.json()) as { session: string };
  const added = await request.post(add, {
    headers,
    data: {
      client_secret: clientSecret,
      sid,
      auth: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
        session: uia,
      },
    },
  });
  expect(added.ok(), `add 3pid: ${await added.text()}`).toBe(true);
  return { user, pass, address, accessToken };
}

async function openReset(page: Page): Promise<void> {
  await page.goto('/login');
  await fillLabeledInput(page, 'Homeserver', hs);
  await page.getByText('Continue', { exact: true }).click();
  await page.getByTestId('password-forgot').click();
}

async function sendLink(page: Page, address: string): Promise<void> {
  await page.getByTestId('reset-email-input').fill(address);
  await page.getByTestId('reset-send').click();
}

async function fillNewPassword(page: Page, pass: string): Promise<void> {
  await page.getByTestId('reset-continue').click();
  await page.getByTestId('reset-password-input').fill(pass);
  await page.getByTestId('reset-confirm-input').fill(pass);
}

async function whoami(
  request: APIRequestContext,
  accessToken: string,
): Promise<number> {
  const res = await request.get(`${hs}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.status();
}

test.describe('Password reset', () => {
  test.skip(
    !session.available || (session.unavailable ?? []).includes('mail'),
    'needs a homeserver that sends email, with the harness Mailpit (Synapse on Docker, or native with mailpit on PATH)',
  );

  test('resets and signs out other devices', async ({ page, request }) => {
    const account = await accountWithEmail(request);
    const newPass = `${account.pass}-new`;

    await openReset(page);
    await sendLink(page, account.address);
    await expect(page.getByTestId('reset-sent')).toContainText(
      account.address,
      { timeout: 20_000 },
    );
    await fillNewPassword(page, newPass);
    await page.getByTestId('reset-submit').click();
    await expect(page.getByTestId('reset-error')).toHaveText(NOT_CONFIRMED, {
      timeout: 20_000,
    });
    await expect(page.getByTestId('reset-sent')).toBeVisible();

    await confirmResetLink(request, account.address, hs);
    await page.getByTestId('reset-continue').click();
    await expect(page.getByTestId('reset-password-input')).toHaveValue(newPass);
    await expect(page.getByTestId('reset-confirm-input')).toHaveValue(newPass);
    await page.getByTestId('reset-submit').click();
    await expect(page.getByTestId('login-password-reset')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel('Homeserver', { exact: true })).toHaveValue(
      hs,
    );

    await passwordLogin(request, hs, account.user, newPass);
    await expect(
      passwordLogin(request, hs, account.user, account.pass),
    ).rejects.toThrow();
    expect(await whoami(request, account.accessToken)).toBe(401);
  });

  test('keeps other devices signed in', async ({ page, request }) => {
    const account = await accountWithEmail(request);
    const newPass = `${account.pass}-new`;

    await openReset(page);
    await sendLink(page, account.address);
    await expect(page.getByTestId('reset-sent')).toContainText(
      account.address,
      { timeout: 20_000 },
    );
    await fillNewPassword(page, newPass);
    await page
      .getByTestId('reset-logout-devices')
      .getByRole('checkbox')
      .uncheck();
    await confirmResetLink(request, account.address, hs);
    await page.getByTestId('reset-submit').click();
    await expect(page.getByTestId('login-password-reset')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel('Homeserver', { exact: true })).toHaveValue(
      hs,
    );

    await passwordLogin(request, hs, account.user, newPass);
    expect(await whoami(request, account.accessToken)).toBe(200);
  });

  test('refuses an unknown address', async ({ page }) => {
    await openReset(page);
    await sendLink(page, `nobody-${testResourceId('run')}@example.test`);
    await expect(page.getByTestId('reset-error')).toHaveText(UNKNOWN_ADDRESS, {
      timeout: 20_000,
    });
    await expect(page.getByTestId('reset-sent')).toHaveCount(0);
  });
});
