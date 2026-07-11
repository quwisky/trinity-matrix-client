import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the thread composer (data-testid="thread-view"): the room-scoped actions
// (poll/location/sticker/voice) are hidden there because they post to the main room,
// not the thread; and a slash command typed in a thread is parsed (`/me waves` sends an
// emote "waves", not the literal text). Needs a Synapse homeserver (Docker); self-skips.
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

test.describe('Thread composer', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('hides room-scoped actions and parses slash commands in a thread', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}thr`;
    const user = `thr-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Thread ${runId}`;
    const rootBody = `thread root ${runId}`;

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

    // Send a message, then open a thread off it via the hover toolbar.
    const composer = page.getByTestId('composer-input');
    await composer.fill(rootBody);
    await composer.press('Enter');
    const row = page.locator('.scroll .msg', { hasText: rootBody });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });
    await row.first().hover();
    await row.first().getByRole('button', { name: 'Reply in thread' }).click();

    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible({ timeout: 15_000 });

    // The room-only actions post to the main room, so the thread composer omits them.
    for (const id of [
      'composer-poll',
      'composer-location',
      'composer-sticker',
      'composer-voice',
    ]) {
      await expect(thread.getByTestId(id)).toHaveCount(0);
    }

    // A slash command is parsed in the thread: `/me waves` sends an emote "waves".
    const threadInput = thread.getByTestId('composer-input');
    await threadInput.fill('/me waves');
    await threadInput.press('Enter');

    await expect(
      thread.locator('.msg', { hasText: 'waves' }).first(),
    ).toBeVisible({ timeout: 20_000 });
    // The command was interpreted, not sent as literal text.
    await expect(thread).not.toContainText('/me waves');
  });
});
