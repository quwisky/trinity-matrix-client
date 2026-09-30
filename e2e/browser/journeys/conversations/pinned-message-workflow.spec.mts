import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// The pin, panel, jump and unpin workflows moved to the Android suite
// `android.pinned-message-workflow` (#757); only the desktop-only panel
// geometry below stays here. What follows describes the seeded room both share.
//
// Covers the pin-messages feature end to end: a message's hover toolbar's ⋯
// menu (`data-testid="msg-more"`) offers "Pin message" (`data-testid="msg-pin"`),
// which writes `m.room.pinned_events` through the exact Conversation pins child.
// The room toolbar's pin button (`data-testid="open-pinned"`)
// shows a count badge (`.header-pin__badge`) and opens the pinned-messages side
// panel (PinnedMessagesPanelComponent), whose rows (`.pin-item`) list each pin's
// body/sender/time, jump the timeline to that message on click
// (`.pin-item__main`), and offer an inline Unpin (`.pin-item__unpin`).
//
// Seeds a single fresh user via Synapse's shared-secret admin endpoint (same
// trick as unread-badges.spec.mts) who creates their own
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

const OTHER_BODY = 'just chatting';
const PIN_BODY = 'pin me please';

interface ApiUser {
  token: string;
  userId: string;
  headers: { Authorization: string };
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

  test('the panel takes its own width, and only offers a divider where one means something', async ({
    page,
    request,
  }) => {
    // Two things the panel's geometry has to get right, both invisible to every unit test
    // and to the rest of this suite, which only ever runs at the default 1280px viewport.
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}pg`;
    const { reader, roomName } = await seedPinRoom(request, hs, runId);

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

    // 1. Explicitly open the fixed 240px member column. It does not read
    //    `--shell-right-panel-w`, so a divider there would move a value while the pane beside
    //    it stayed put.
    const divider = page.getByRole('separator', { name: 'Panel width' });
    await expect(page.locator('.chat-members')).toBeHidden();
    await page.getByTestId('toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible({
      timeout: 10_000,
    });
    await expect(divider).toHaveCount(0);

    await page.getByTestId('open-pinned').click();
    const panel = page.getByTestId('pinned-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toHaveAttribute('data-trn-variant', 'neutral');
    await expect(panel).toHaveAttribute('data-trn-size', 'md');
    await expect(panel).toHaveAttribute('data-trn-layout', 'fullscreen');
    await expect(divider).toBeVisible();

    // 2. Below the `members` breakpoint the panel is an overlay drawer, and it is NOT the
    //    240px one the roster uses: a thread or a list of search results in 240px is not
    //    readable. It was full-screen as a dialog and has to stay so.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(divider).toBeHidden();
    const width = (await panel.boundingBox())?.width ?? 0;
    expect(width).toBeGreaterThan(400);
  });
});
