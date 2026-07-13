import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers composer slash commands (TimelineService.send → slashCommandContent):
// /shrug appends the kaomoji, and /plain sends its argument literally (no markdown).
// Needs a Synapse homeserver (Docker); self-skips otherwise.
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

test.describe('Slash commands', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('/shrug appends the kaomoji and /plain keeps markdown literal', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sc`;
    const user = `slash-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Slash ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);
    const composer = page.getByTestId('composer-input');

    // /shrug appends the kaomoji.
    await composer.fill('/shrug oh well');
    await composer.press('Enter');
    await expect(
      page.locator('.msg__text', { hasText: 'oh well ¯\\_(ツ)_/¯' }),
    ).toBeVisible({ timeout: 20_000 });

    // /plain sends its argument literally — the `**` are not rendered as bold.
    await composer.fill('/plain **not bold**');
    await composer.press('Enter');
    await expect(
      page.locator('.msg__text', { hasText: '**not bold**' }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
