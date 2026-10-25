import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  homeserverSession,
  login,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import { latestLink } from '../../../support/mailbox.mts';

// Adding and removing an email address from Settings › Account. Synapse mails the
// validation link to the harness Mailpit; the spec opens it the way a mail client would.
// Synapse asks for the password before it checks the link, so an early Continue goes
// through the password step and then reports the link unopened.
const session = homeserverSession();

interface Account {
  readonly user: string;
  readonly pass: string;
  readonly address: string;
}

async function signedInAccount(
  page: Page,
  request: APIRequestContext,
  label: string,
): Promise<Account> {
  const user = `${label}-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  await login(page, { ...session, user, pass } as HomeserverSession);
  await openSettingsSection(page, 'account');
  return { user, pass, address: `${user}@example.test` };
}

async function sendLink(page: Page, address: string): Promise<void> {
  await page.getByRole('button', { name: 'Add email address' }).click();
  await page.getByTestId('add-email-input').fill(address);
  await page.getByTestId('add-email-submit').click();
  await expect(page.getByTestId('add-email-sent')).toContainText(address, {
    timeout: 20_000,
  });
}

async function continueWithPassword(page: Page, pass: string): Promise<void> {
  await page.getByTestId('add-email-continue').click();
  await expect(page.getByTestId('add-email-password')).toBeFocused({
    timeout: 20_000,
  });
  await page.getByTestId('add-email-password').fill(pass);
  await page.getByTestId('add-email-password-submit').click();
}

async function openLink(
  request: APIRequestContext,
  address: string,
): Promise<void> {
  const res = await request.get(
    await latestLink(request, address, session.hs as string),
  );
  expect(res.ok(), await res.text()).toBe(true);
}

async function addEmail(
  page: Page,
  request: APIRequestContext,
  account: Account,
): Promise<void> {
  await sendLink(page, account.address);
  await openLink(request, account.address);
  await continueWithPassword(page, account.pass);
  await expect(
    page.getByRole('button', { name: `Remove ${account.address}` }),
  ).toBeVisible({ timeout: 20_000 });
}

test.describe('Email addresses', () => {
  test.skip(
    !session.available || (session.unavailable ?? []).includes('mail'),
    'needs a homeserver that sends email, with the harness Mailpit (Synapse on Docker, or native with mailpit on PATH)',
  );

  test('adds an email after opening the link', async ({ page, request }) => {
    const account = await signedInAccount(page, request, 'email-add');

    await sendLink(page, account.address);
    await continueWithPassword(page, account.pass);
    await expect(page.getByTestId('add-email-not-verified')).toHaveText(
      'That link hasn’t been opened yet.',
      { timeout: 20_000 },
    );

    await openLink(request, account.address);
    await continueWithPassword(page, account.pass);
    await expect(
      page.getByRole('button', { name: `Remove ${account.address}` }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`${account.address} was added.`),
    ).toBeVisible();
  });

  test('removes an email', async ({ page, request }) => {
    const account = await signedInAccount(page, request, 'email-remove');
    await addEmail(page, request, account);

    await page
      .getByRole('button', { name: `Remove ${account.address}` })
      .click();
    await page.getByTestId('alert-confirm').click();
    await expect(
      page.getByRole('button', { name: `Remove ${account.address}` }),
    ).toHaveCount(0, { timeout: 20_000 });

    const hs = session.hs as string;
    const { accessToken } = await passwordLogin(
      request,
      hs,
      account.user,
      account.pass,
    );
    const res = await request.get(`${hs}/_matrix/client/v3/account/3pid`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const { threepids } = (await res.json()) as {
      threepids: { address: string }[];
    };
    expect(threepids.map((threepid) => threepid.address)).not.toContain(
      account.address,
    );
  });
});
