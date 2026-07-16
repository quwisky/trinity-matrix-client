import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the pinned-messages panel end to end: the room toolbar's pin button
// (`data-testid="open-pinned"`) opens PinnedPanelService's side panel
// (`data-testid="pinned-panel"`), which lists every `m.room.pinned_events` entry
// (`data-testid="pinned-item"`) projected live by PinnedMessagesService. Unpinning
// (`data-testid="pinned-unpin"`) rewrites the state event and the row drops out of the
// live projection WITHOUT closing the panel — the property the unit spec asserts
// against a mock, exercised here against a real homeserver round-trip.
//
// The pin state is seeded server-side rather than through the UI, so the test asserts
// the read/unpin path rather than re-testing pinning itself.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise, like the other
// authenticated web e2e specs.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const nonceRes = await request.get(
    `${SYNAPSE_HTTP}/_synapse/admin/v1/register`,
  );
  const { nonce } = await nonceRes.json();
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

/**
 * A room containing two messages, both pinned via `m.room.pinned_events` (pin order =
 * array order). Two so unpinning one leaves a non-empty panel to assert against —
 * proving the row dropped rather than the panel merely emptying.
 */
async function seedPinnedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: SynapseSession;
  roomName: string;
  keepBody: string;
  unpinBody: string;
}> {
  const user = `pinner-${runId}`;
  const pass = `pinner-pass-${runId}`;
  const roomName = `Pinned Room ${runId}`;
  const unpinBody = `unpin-me-${runId}`;
  const keepBody = `keep-me-${runId}`;

  await registerUser(request, user, pass);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  const auth = { Authorization: `Bearer ${access_token}` };

  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: auth,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json());

  const send = async (body: string): Promise<string> => {
    const res = await request.put(
      `${hs}/_matrix/client/v3/rooms/${room_id}/send/m.room.message/${body}`,
      { headers: auth, data: { msgtype: 'm.text', body } },
    );
    const { event_id } = await res.json();
    return event_id;
  };
  const unpinId = await send(unpinBody);
  const keepId = await send(keepBody);

  await request.put(
    `${hs}/_matrix/client/v3/rooms/${room_id}/state/m.room.pinned_events/`,
    { headers: auth, data: { pinned: [unpinId, keepId] } },
  );

  return {
    reader: { available: true, hs, user, pass },
    roomName,
    keepBody,
    unpinBody,
  };
}

test.describe('Pinned messages panel', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('lists pinned messages and unpins one in place', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}p`;

    const { reader, roomName, keepBody, unpinBody } = await seedPinnedRoom(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();

    const room = page.locator('.channel', { hasText: roomName });
    await room.first().waitFor({ state: 'visible', timeout: 30_000 });
    await room.first().click();

    // The toolbar pin button opens the side panel with both pins, in pin order.
    await page.getByTestId('open-pinned').click();
    const panel = page.getByTestId('pinned-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pinned-item')).toHaveCount(2);
    await expect(panel).toContainText(unpinBody);
    await expect(panel).toContainText(keepBody);

    // Unpin the first: the state event is rewritten and the live projection drops the
    // row — while the panel STAYS open (an unpin is not a jump).
    // Scope to the row (.pin-item wraps the jump button + its unpin sibling) so the
    // two pins can never be confused.
    const unpinRow = page.locator('.pin-item', { hasText: unpinBody });
    await unpinRow.getByTestId('pinned-unpin').click({ timeout: 10_000 });

    await expect(page.getByTestId('pinned-item')).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(keepBody);
    await expect(panel).not.toContainText(unpinBody);
  });
});
