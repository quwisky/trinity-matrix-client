import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Regression for #282: a failed outbound invite or incoming room join must release
// request state, show actionable guidance, and allow the same action to be retried
// without reloading Trinity. Needs the disposable Synapse homeserver.
const session = synapseSession();

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const response = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  const json = await response.json();
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName }).first();
  await channel.waitFor({ state: 'visible', timeout: 30_000 });
  await channel.click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

function matrixFailure(status: number): {
  status: number;
  contentType: string;
  body: string;
} {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      errcode: 'M_UNKNOWN',
      error: 'synthetic upstream failure',
    }),
  };
}

test.describe('Room HTTP error recovery', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('retries an outbound room invite after an HTTP failure', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}invite-retry`;
    const owner = `invite-owner-${runId}`;
    const pass = `${owner}-pass`;
    const roomName = `Invite recovery ${runId}`;

    await registerUser(request, owner, pass);
    const ownerSession = await apiLogin(request, hs, owner, pass);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: ownerSession.headers,
      data: { name: roomName, preset: 'private_chat' },
    });
    await login(page, {
      available: true,
      hs,
      user: owner,
      pass,
    } as SynapseSession);
    await openRoom(page, roomName);

    let inviteAttempts = 0;
    await page.route('**/_matrix/client/**/rooms/**/invite', async (route) => {
      inviteAttempts += 1;
      await route.fulfill(
        inviteAttempts === 1
          ? matrixFailure(503)
          : { status: 200, contentType: 'application/json', body: '{}' },
      );
    });

    const target = '@remote-user:remote.example';
    await page.getByTestId('invite-people').click();
    await page.getByLabel('@user:server or a name').fill(target);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();

    await expect(
      page.getByText('The homeserver is unavailable. Try again.'),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('invite-people')).toBeEnabled();

    await page.getByTestId('invite-people').click();
    await page.getByLabel('@user:server or a name').fill(target);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();

    await expect(page.getByText(`Invitation sent to ${target}.`)).toBeVisible({
      timeout: 15_000,
    });
    expect(inviteAttempts).toBe(2);
  });

  test('retries accepting a room invite after an HTTP failure', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}join-retry`;
    const owner = `join-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const joiner = `join-target-${runId}`;
    const joinerPass = `${joiner}-pass`;
    const roomName = `Join recovery ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, joiner, joinerPass);
    const ownerSession = await apiLogin(request, hs, owner, ownerPass);
    const joinerSession = await apiLogin(request, hs, joiner, joinerPass);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: ownerSession.headers,
      data: {
        name: roomName,
        preset: 'private_chat',
        invite: [joinerSession.userId],
      },
    });

    await login(page, {
      available: true,
      hs,
      user: joiner,
      pass: joinerPass,
    } as SynapseSession);

    let joinAttempts = 0;
    await page.route('**/_matrix/client/**/join/**', async (route) => {
      joinAttempts += 1;
      if (joinAttempts === 1) {
        await route.fulfill(matrixFailure(502));
        return;
      }
      await route.continue();
    });

    const accept = page.getByRole('button', {
      name: `Accept invite to ${roomName}`,
    });
    await expect(accept).toBeVisible({ timeout: 30_000 });
    await accept.click();

    await expect(
      page.getByText('The homeserver is unavailable. Try again.'),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(accept).toBeEnabled();

    await accept.click();

    await expect(
      page.locator('.channel', { hasText: roomName }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    expect(joinAttempts).toBe(2);
  });
});
