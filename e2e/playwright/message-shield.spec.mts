import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers per-message authenticity shields (message-row `data-testid="msg-shield-*"`).
// Shields are resolved only for *encrypted* messages via the crypto trust API, so a
// message in a plaintext room must carry no shield — the deterministic gating check.
// (Shielded encrypted cases are covered by the TimelineService unit tests, which don't
// need a second verified device.) Needs a Synapse homeserver (Docker); self-skips.
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

test.describe('Message authenticity shields', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a message in a plaintext room shows no shield', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sh`;
    const owner = `shield-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const reader = `shield-reader-${runId}`;
    const readerPass = `${reader}-pass`;
    const roomName = `Plain ${runId}`;
    const body = `plaintext message ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, reader, readerPass);
    const login1 = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: owner },
          password: ownerPass,
        },
      })
      .then((r) => r.json());
    const ownerAuth = { Authorization: `Bearer ${login1.access_token}` };
    const readerId = `@${reader}:${(login1.user_id as string).split(':')[1]}`;

    // A plaintext room (no encryption initial_state) — its messages get no shield.
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: ownerAuth,
        data: { name: roomName, preset: 'private_chat', invite: [readerId] },
      })
      .then((r) => r.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-msg`,
      { headers: ownerAuth, data: { msgtype: 'm.text', body } },
    );

    await login(page, {
      available: true,
      hs,
      user: reader,
      pass: readerPass,
    } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    // The message renders, and it carries no authenticity shield (plaintext room).
    await expect(page.getByText(body)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid^="msg-shield-"]')).toHaveCount(0);
  });
});
