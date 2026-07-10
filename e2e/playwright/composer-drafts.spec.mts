import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for per-conversation composer drafts: a half-typed message is kept per
// room while switching between rooms, and survives a reload (persisted to Capacitor
// Preferences and restored at startup). Needs a Synapse homeserver (Docker).
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

/** Capacitor Preferences persists web values under this localStorage prefix. */
const DRAFTS_LS_KEY = 'CapacitorStorage.trinity.composer.drafts';

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

/** Register a reader and create two plain rooms they belong to. */
async function seedTwoRooms(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; roomA: string; roomB: string }> {
  const user = `drafts-${runId}`;
  const pass = `drafts-${runId}-pass`;
  const roomA = `Drafts A ${runId}`;
  const roomB = `Drafts B ${runId}`;

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
  const headers = { Authorization: `Bearer ${token}` };
  for (const name of [roomA, roomB]) {
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name },
    });
  }

  return {
    reader: { available: true, hs, user, pass },
    roomA,
    roomB,
  };
}

/** Open a room from the sidebar and wait for its composer to be ready. */
async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Composer drafts', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps a per-room draft across room switches and a reload', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}d`;
    const { reader, roomA, roomB } = await seedTwoRooms(
      request,
      session.hs as string,
      runId,
    );
    const draft = `unsent draft ${runId}`;

    await login(page, reader);

    // Type a draft in room A, without sending it.
    await openRoom(page, roomA);
    const composer = page.getByTestId('composer-input');
    await composer.fill(draft);

    // Switch to room B — A's draft must not leak into it.
    await openRoom(page, roomB);
    await expect(page.getByTestId('composer-input')).toHaveValue('');

    // Switch back to A — the draft is restored.
    await openRoom(page, roomA);
    await expect(page.getByTestId('composer-input')).toHaveValue(draft);

    // Once the draft has persisted, a reload restores it (cold-start).
    await expect
      .poll(() =>
        page.evaluate((k) => localStorage.getItem(k) ?? '', DRAFTS_LS_KEY),
      )
      .toContain(draft);
    await page.reload();
    await openRoom(page, roomA);
    await expect(page.getByTestId('composer-input')).toHaveValue(draft);
  });
});
