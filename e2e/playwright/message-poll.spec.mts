import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for polls (MSC3381): create a poll from the composer, vote, see the tally
// update, and end it. Needs a Synapse homeserver (Docker).
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Polls', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('creates a poll, votes, and ends it', async ({ page, request }) => {
    const runId = `${Date.now().toString(36)}p`;
    const hs = session.hs as string;
    const username = `poll-user-${runId}`;
    const password = `${username}-pass`;
    await registerUser(request, username, password);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: username },
          password,
        },
      })
      .then((r) => r.json());
    const roomName = `Poll E2E ${runId}`;
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName },
    });

    await login(page, {
      available: true,
      hs,
      user: username,
      pass: password,
    } as SynapseSession);
    await openRoom(page, roomName);

    // Open the create-poll dialog and fill it in.
    await page.getByTestId('composer-poll').click();
    const question = `Best fruit ${runId}?`;
    await page.getByTestId('poll-question').fill(question);
    await page.getByTestId('poll-option-0').fill('Apple');
    await page.getByTestId('poll-option-1').fill('Pear');
    await page.getByTestId('poll-create').click();

    // The poll renders in the timeline.
    const poll = page.getByTestId('poll').first();
    await expect(poll).toBeVisible({ timeout: 20_000 });
    await expect(poll).toContainText(question);
    await expect(poll).toContainText('0 votes');

    // Vote for the first option → the tally updates live.
    await poll.locator('.poll__option').first().click();
    await expect(poll).toContainText('1 vote');
    await expect(poll).toContainText('1 (100%)');

    // End the poll → results are final and voting is closed.
    await poll.getByTestId('poll-end').click();
    await expect(poll).toContainText('Final results');
  });
});
