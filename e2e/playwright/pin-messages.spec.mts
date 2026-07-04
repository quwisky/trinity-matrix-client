import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the pin-messages feature end to end: a message's hover toolbar's ⋯
// menu (`data-testid="msg-more"`) offers "Pin message" (`data-testid="msg-pin"`),
// which writes `m.room.pinned_events` room state (PinnedMessagesService.pin →
// sendStateEvent). The room toolbar's pin button (`data-testid="open-pinned"`)
// shows a count badge (`.header-pin__badge`) and opens the pinned-messages side
// panel (PinnedMessagesPanelComponent), whose rows (`.pin-item`) list each pin's
// body/sender/time, jump the timeline to that message on click
// (`.pin-item__main`), and offer an inline Unpin (`.pin-item__unpin`).
//
// Seeds a single fresh user via Synapse's shared-secret admin endpoint (same
// trick as unread-badges.spec.mts / room-list.spec.mts) who creates their own
// room — as creator they hold power level 100, so
// `maySendStateEvent('m.room.pinned_events')` (canPin) is true with no extra
// power-level setup. No second "sender" account is needed: the room is
// classified as non-DM purely by the `m.direct` account-data map (not the
// `private_chat` preset), so a single-member room the reader created still
// surfaces under the Rooms rail like every other seeded plain room in this
// suite.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise, like the other
// authenticated web e2e specs.
const session = synapseSession();

// Direct (no-TLS) Synapse admin endpoint — same constant as the other e2e
// helpers (e2e/features/rooms.mjs, search.mjs, unread-badges.spec.mts).
const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

const OTHER_BODY = 'just chatting';
const PIN_BODY = 'pin me please';

interface ApiUser {
  token: string;
  userId: string;
  headers: { Authorization: string };
}

/** Register a user via Synapse's shared-secret admin endpoint (idempotent —
 * "already exists" is treated as success, mirrors rooms.mjs/search.mjs). */
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

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  const json = await res.json();
  return {
    token: json.access_token as string,
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/**
 * Register a fresh reader, have them create their own plain (non-DM) room —
 * so they hold power level 100 (creator) and can pin/unpin — then post a
 * couple of known-body messages via the CS API before the reader ever logs
 * in, so both are already part of the initial sync.
 */
async function seedPinRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; roomName: string }> {
  const readerUser = `pin-reader-${runId}`;
  const readerPass = `reader-pass-${runId}`;
  const roomName = `Pin E2E ${runId}`;

  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/pin-other-${runId}`,
    { headers: reader.headers, data: { msgtype: 'm.text', body: OTHER_BODY } },
  );
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/pin-target-${runId}`,
    { headers: reader.headers, data: { msgtype: 'm.text', body: PIN_BODY } },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
  };
}

test.describe('Pin messages', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('pin a message, see it (and its count) in the pinned panel, jump to it, then unpin it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}p`;

    const { reader, roomName } = await seedPinRoom(request, hs, runId);

    await login(page, reader);

    // Seeded room is a plain (non-DM) room — reveal it under the Rooms pill.
    await page.getByTestId('rail-rooms').click();

    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    // Confirm the timeline actually mounted before touching a message row.
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

    const targetRow = page.locator('.scroll .msg[data-mid]', {
      hasText: PIN_BODY,
    });
    await targetRow.first().waitFor({ state: 'visible', timeout: 15_000 });

    // Reveal the row's hover toolbar (opacity/pointer-events are hover/focus
    // gated — see message-row.component.scss) before its ⋯ trigger is
    // clickable.
    await targetRow.first().hover();
    await targetRow.first().getByTestId('msg-more').click();

    // The ⋯ overlay menu renders at page root (CDK overlay), not nested under
    // the row — select its "Pin message" item at page scope.
    const pinItem = page.getByTestId('msg-pin');
    await pinItem.waitFor({ state: 'visible', timeout: 10_000 });
    await pinItem.click();

    // Assert the toolbar's pin button now carries a count badge of 1 — wait on
    // this app state (the pin round-tripping through sendStateEvent →
    // RoomStateEvent.Events → readRoomState), not a fixed sleep.
    const pinButton = page.getByTestId('open-pinned');
    const badge = pinButton.locator('.header-pin__badge');
    await expect(badge).toHaveText('1', { timeout: 30_000 });

    // Open the pinned-messages panel and confirm it lists the pinned message.
    await pinButton.click();
    await expect(
      page.getByRole('heading', { name: 'Pinned messages' }),
    ).toBeVisible({ timeout: 10_000 });

    let pinRow = page.locator('.pin-item', { hasText: PIN_BODY });
    await expect(pinRow).toBeVisible({ timeout: 10_000 });
    await expect(pinRow.locator('.pin-item__body')).toContainText(PIN_BODY);

    // Clicking the row jumps the timeline to that message (and closes the
    // panel — PinnedMessagesPanelComponent.jumpTo resolves the dialog with the
    // chosen event id, which RoomsPage.openPinnedPanel turns into a
    // messageSearchTarget jump, the same mechanism in-room search uses).
    await pinRow.locator('.pin-item__main').click();
    await expect(
      page.getByRole('heading', { name: 'Pinned messages' }),
    ).toBeHidden({ timeout: 10_000 });

    await expect(targetRow.first()).toBeInViewport({ timeout: 15_000 });

    // Reopen the panel and unpin from its per-row control.
    await pinButton.click();
    await expect(
      page.getByRole('heading', { name: 'Pinned messages' }),
    ).toBeVisible({ timeout: 10_000 });

    pinRow = page.locator('.pin-item', { hasText: PIN_BODY });
    await pinRow.locator('.pin-item__unpin').click();

    // The panel empties and/or the count badge drops to 0 — again waiting on
    // the state round trip rather than a fixed sleep.
    await expect(
      page.getByText('No pinned messages in this channel yet.'),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Close pinned messages' }).click();
    await expect(badge).toHaveCount(0, { timeout: 30_000 });
  });
});
