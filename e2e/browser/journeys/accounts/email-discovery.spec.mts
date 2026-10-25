import { createHash } from 'node:crypto';
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
import { IDENTITY_SERVER_URL } from '../../../support/homeserver/start.mjs';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import { latestLink } from '../../../support/mailbox.mts';

// Letting people find you by email: account A publishes an address through Settings ›
// Account and account B, over the API, looks it up the way another client would.
const session = homeserverSession();
const hs = session.hs as string;
const identity = `${IDENTITY_SERVER_URL}/_matrix/identity/v2`;

interface Account {
  readonly user: string;
  readonly pass: string;
  readonly address: string;
  readonly userId: string;
}

/** An account with a validated email address, added over the API. */
async function accountWithEmail(request: APIRequestContext): Promise<Account> {
  const user = `find-${testResourceId('run')}`;
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
  return { user, pass, address, userId: `@${user}:${new URL(hs).hostname}` };
}

/** Account B: registers with the identity server, accepts its terms and looks addresses up. */
async function finder(
  request: APIRequestContext,
  asker: string,
): Promise<(address: string) => Promise<string | undefined>> {
  const pass = `${asker}-pass`;
  await registerUser(request, asker, pass);
  const { accessToken } = await passwordLogin(request, hs, asker, pass);
  const userId = `@${asker}:${new URL(hs).hostname}`;
  const openid = await request.post(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/openid/request_token`,
    { headers: { Authorization: `Bearer ${accessToken}` }, data: {} },
  );
  expect(openid.ok(), 'openid request_token').toBe(true);
  const registered = await request.post(`${identity}/account/register`, {
    data: await openid.json(),
  });
  expect(registered.ok(), 'identity account/register').toBe(true);
  const { token } = (await registered.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}` };

  const terms = (await (await request.get(`${identity}/terms`)).json()) as {
    policies: Record<string, { en: { url: string } }>;
  };
  const accepted = await request.post(`${identity}/terms`, {
    headers,
    data: {
      user_accepts: Object.values(terms.policies).map((p) => p.en.url),
    },
  });
  expect(accepted.ok(), 'identity terms').toBe(true);

  return async (address) => {
    const details = await request.get(`${identity}/hash_details`, { headers });
    const { lookup_pepper: pepper } = (await details.json()) as {
      lookup_pepper: string;
    };
    const hash = createHash('sha256')
      .update(`${address} email ${pepper}`)
      .digest('base64url');
    const res = await request.post(`${identity}/lookup`, {
      headers,
      data: { addresses: [hash], algorithm: 'sha256', pepper },
    });
    expect(res.ok(), 'identity lookup').toBe(true);
    const { mappings } = (await res.json()) as {
      mappings: Record<string, string>;
    };
    return mappings[hash];
  };
}

async function signIn(page: Page, account: Account): Promise<void> {
  await login(page, {
    ...session,
    user: account.user,
    pass: account.pass,
  } as HomeserverSession);
  await openSettingsSection(page, 'account');
}

const toggle = (page: Page) =>
  page.getByTestId('findable-0').getByRole('switch');

async function chooseServer(page: Page): Promise<void> {
  await page.getByTestId('identity-server-change').click();
  await page.getByTestId('identity-server-url-input').fill(IDENTITY_SERVER_URL);
  await page.getByTestId('identity-server-save').click();
  await expect(page.getByTestId('identity-server-value')).toHaveText(
    new URL(IDENTITY_SERVER_URL).host,
    { timeout: 20_000 },
  );
}

async function publish(
  page: Page,
  request: APIRequestContext,
  account: Account,
): Promise<void> {
  await toggle(page).click();
  await expect(page.getByTestId('identity-terms-decline')).toBeFocused();
  await page.getByTestId('identity-terms-accept').click();
  await expect(page.getByTestId('publish-email-sent')).toContainText(
    account.address,
    { timeout: 20_000 },
  );
  // Sydent's link validates on a GET; the newest mail may still be Synapse's add-address one.
  let link = '';
  await expect
    .poll(
      async () =>
        (link = await latestLink(
          request,
          account.address,
          IDENTITY_SERVER_URL,
        )),
      { timeout: 30_000, message: 'no identity-server mail arrived' },
    )
    .toContain('/identity/');
  const opened = await request.get(link);
  expect(opened.ok(), await opened.text()).toBe(true);
  await page.getByTestId('publish-email-continue').click();
  await expect(toggle(page)).toBeChecked({ timeout: 20_000 });
}

test.describe('Finding someone by email', () => {
  test.skip(
    !session.available ||
      (session.unavailable ?? []).some((f) => f === 'mail' || f === 'identity'),
    'needs a homeserver that sends email and the harness identity server (native Sydent, or Synapse on Docker)',
  );

  test('publishes an address, then stops it being found', async ({
    page,
    request,
  }) => {
    const account = await accountWithEmail(request);
    const lookup = await finder(request, `finder-${testResourceId('run')}`);
    await signIn(page, account);
    await chooseServer(page);

    await publish(page, request, account);
    expect(await lookup(account.address)).toBe(account.userId);

    await toggle(page).click();
    await expect(toggle(page)).not.toBeChecked({ timeout: 20_000 });
    await expect
      .poll(() => lookup(account.address), { timeout: 20_000 })
      .toBeUndefined();
  });

  test('turning the server off first stops it finding you', async ({
    page,
    request,
  }) => {
    const account = await accountWithEmail(request);
    const lookup = await finder(request, `finder-${testResourceId('run')}`);
    await signIn(page, account);
    await chooseServer(page);
    await publish(page, request, account);
    expect(await lookup(account.address)).toBe(account.userId);

    await page.getByTestId('identity-server-turn-off').click();
    await page.getByTestId('alert-confirm').click();
    await expect(page.getByTestId('identity-server-value')).toHaveText('Off', {
      timeout: 20_000,
    });
    expect(await lookup(account.address)).toBeUndefined();
  });
});
