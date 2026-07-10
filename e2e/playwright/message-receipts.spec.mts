import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for "seen by" read receipts: when another member reads a message, their
// avatar appears on it in the reader's timeline. Needs Synapse (Docker).
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

async function apiToken(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<{ userId: string; headers: { Authorization: string } }> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
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

test.describe('Read receipts (seen by)', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test("shows a reader's avatar on the message they read", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}s`;
    const hs = session.hs as string;

    await registerUser(request, `rcpt-reader-${runId}`, 'pass-reader');
    await registerUser(request, `rcpt-author-${runId}`, 'pass-author');
    await registerUser(request, `rcpt-seer-${runId}`, 'pass-seer');
    const reader = await apiToken(
      request,
      hs,
      `rcpt-reader-${runId}`,
      'pass-reader',
    );
    const author = await apiToken(
      request,
      hs,
      `rcpt-author-${runId}`,
      'pass-author',
    );
    const seer = await apiToken(request, hs, `rcpt-seer-${runId}`, 'pass-seer');

    const seerName = `Cara${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(seer.userId)}/displayname`,
      { headers: seer.headers, data: { displayname: seerName } },
    );

    const roomName = `Receipts E2E ${runId}`;
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: { name: roomName, invite: [author.userId, seer.userId] },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    for (const who of [author, seer]) {
      await request.post(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        { headers: who.headers },
      );
    }

    // The author sends a message, and the "seer" reads up to it.
    const body = `read receipt target ${runId}`;
    const eventId = await request
      .put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/rcpt-${runId}`,
        { headers: author.headers, data: { msgtype: 'm.text', body } },
      )
      .then((r) => r.json())
      .then((j) => j.event_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      { headers: seer.headers, data: {} },
    );

    await login(page, {
      available: true,
      hs,
      user: `rcpt-reader-${runId}`,
      pass: 'pass-reader',
    } as SynapseSession);
    await openRoom(page, roomName);

    // The seer's read receipt renders as a "seen by" avatar group on the message.
    const receipts = page.locator('.scroll [data-testid="read-receipts"]');
    await expect(receipts.first()).toBeVisible({ timeout: 20_000 });
    await expect(receipts.first()).toHaveAttribute(
      'aria-label',
      new RegExp(seerName),
    );
  });
});
