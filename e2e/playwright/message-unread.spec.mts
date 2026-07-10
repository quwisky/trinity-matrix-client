import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for the unread "New messages" divider + jump-to-unread pill: a reader
// whose fully-read marker sits at an old message sees a divider before the first
// unread one, and — with the divider scrolled off the top — a jump pill that brings it
// back into view. Needs a Synapse homeserver (Docker).
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

async function sendText(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  headers: { Authorization: string },
  body: string,
  txn: string,
): Promise<string> {
  const json = await request
    .put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
      { headers, data: { msgtype: 'm.text', body } },
    )
    .then((r) => r.json());
  return json.event_id as string;
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

test.describe('Unread divider + jump-to-unread', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows a divider and a jump pill for unread messages', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}u`;
    const hs = session.hs as string;

    // Seed a reader + a member who fills the room with messages.
    const readerUser = `unread-reader-${runId}`;
    const memberUser = `unread-member-${runId}`;
    await registerUser(request, readerUser, `${readerUser}-pass`);
    await registerUser(request, memberUser, `${memberUser}-pass`);
    const reader = await apiToken(
      request,
      hs,
      readerUser,
      `${readerUser}-pass`,
    );
    const member = await apiToken(
      request,
      hs,
      memberUser,
      `${memberUser}-pass`,
    );

    const roomName = `Unread E2E ${runId}`;
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: { name: roomName, invite: [member.userId] },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: member.headers },
    );

    // One old message the reader has read up to…
    const readEventId = await sendText(
      request,
      hs,
      roomId,
      member.headers,
      'seen already',
      `${runId}-a`,
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      {
        headers: reader.headers,
        data: { 'm.fully_read': readEventId, 'm.read': readEventId },
      },
    );

    // …then a run of unread ones (enough to overflow the short viewport below).
    for (let i = 0; i < 14; i++) {
      await sendText(
        request,
        hs,
        roomId,
        member.headers,
        `unread message ${i}`,
        `${runId}-b${i}`,
      );
    }

    // A short viewport so the divider (near the top) is scrolled off on open.
    await page.setViewportSize({ width: 1000, height: 400 });
    await login(page, {
      available: true,
      hs,
      user: readerUser,
      pass: `${readerUser}-pass`,
    } as SynapseSession);
    await openRoom(page, roomName);

    // The "New messages" divider is rendered before the first unread message.
    const divider = page.getByTestId('new-messages-divider');
    await expect(divider).toHaveText(/New messages/i, { timeout: 20_000 });

    // On open the timeline pins to the bottom, so the divider is off-screen and the
    // jump pill appears; clicking it brings the divider into view and hides the pill.
    const jump = page.getByTestId('jump-to-unread');
    await expect(jump).toBeVisible({ timeout: 20_000 });
    await jump.click();
    await expect(jump).toBeHidden({ timeout: 20_000 });
  });
});
