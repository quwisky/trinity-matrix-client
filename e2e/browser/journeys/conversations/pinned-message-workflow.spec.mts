import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

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

const OTHER_BODY = 'just chatting';
const PIN_BODY = 'pin me please';
const REPEAT_PIN_BODY = 'pin me twice please';

// How much live filler traffic to flood the room with for the repeat-jump
// regression, below. Comfortably past whatever a 1280x720 viewport's worth of
// compact message rows can show at once (real overflow, not a guess), and — more
// importantly — pushed *after* the reader is already logged in and the room is
// open, so every filler message lands as ordinary live sync traffic in the
// client's already-open (uncapped) live timeline, rather than via the initial
// `/sync`, which `MatrixClientService` caps at `initialSyncLimit: 20` — history
// beyond that window only loads via an explicit scroll-to-top backfill (see
// timeline-virtualization.spec.mts). Seeding this many *before* login would put
// the target outside that window — not just scrolled off, but genuinely unloaded
// — and PinnedMessagesPanelComponent → MessageListBase.jumpTo() only scrolls to
// an event already in the rendered DOM; it never fetches context for a jump.
const FILLER_COUNT = 32;

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

/**
 * Register a fresh reader, have them create their own plain room, post one lead-in
 * message then the pin target — both trivially inside the client's ~20-event
 * initial-sync window — and pin the target directly via the CS API's
 * `m.room.pinned_events` state event (the same authoritative state the Conversation
 * pins child writes), skipping the hover/⋯/"Pin message" UI flow the other test in this file
 * already covers. Returns the reader's own API session (token + roomId) too, so the
 * caller can flood the room with *live* filler traffic once the reader is logged in
 * and the room is open — see {@link FILLER_COUNT}'s comment for why that has to
 * happen post-login rather than here.
 */
async function seedRepeatJumpPinRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: SynapseSession;
  roomName: string;
  roomId: string;
  api: ApiUser;
}> {
  const readerUser = `pin-repeat-reader-${runId}`;
  const readerPass = `reader-pass-${runId}`;
  const roomName = `Pin Repeat E2E ${runId}`;

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
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/pin-repeat-lead-${runId}`,
    { headers: reader.headers, data: { msgtype: 'm.text', body: OTHER_BODY } },
  );
  const targetEventId = await request
    .put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/pin-repeat-target-${runId}`,
      {
        headers: reader.headers,
        data: { msgtype: 'm.text', body: REPEAT_PIN_BODY },
      },
    )
    .then((r) => r.json())
    .then((j) => j.event_id as string);

  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.pinned_events/`,
    { headers: reader.headers, data: { pinned: [targetEventId] } },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    roomId,
    api: reader,
  };
}

test.describe('Pin messages', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('pin a message, see it (and its count) in the pinned panel, jump to it, then unpin it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}p`;

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
    // clickable. The room has only just opened, so the timeline can still shift
    // under the cursor: re-hover per attempt rather than clicking once.
    // The ⋯ overlay menu renders at page root (CDK overlay), not nested under
    // the row — select its "Pin message" item at page scope.
    if (isAndroidE2E) {
      const sheet = await openMessageActionSheet(page, targetRow.first());
      await sheet.getByTestId('sheet-pin').click();
    } else {
      await clickRowMenuItem(targetRow.first(), page.getByTestId('msg-pin'));
    }

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

    // The jump also briefly flashes the target row — jumpTo() scrolls it into view
    // and MessageListBase.flash() adds `msg--flash` (message-row.component.scss: a
    // 1.6s fade-out animation that self-removes the class on `animationend`).
    // Assert it lands promptly, with a timeout SHORTER than the 1.6s animation, so
    // a later poll can't false-pass on a stale (already-faded) state — the panel's
    // dialog-close → messageSearchTarget → jumpTo chain runs asynchronously, and
    // Playwright's own polling (well under the 1.5s window) catches the class
    // whether it lands on this tick or the next render.
    await expect(targetRow.first()).toHaveClass(/msg--flash/, {
      timeout: 1_500,
    });

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

  // Regression for a fixed bug: clicking a pinned row jumped the timeline the
  // FIRST time, but a second click on the SAME row silently did nothing, because
  // RoomsPage.messageSearchTarget is a signal — setting it to the same event id
  // twice in a row is a no-op, so MessageListBase's jump effect never re-fired. The
  // fix pairs it with `jumpRequest`, a nonce bumped on every panel jump (and
  // in-room search jump), which the list's jump effect also reads so a repeat
  // request to the SAME id still re-triggers `jumpTo()`. This test proves the
  // SECOND jump to an unchanged target works, not just the first.
  test('re-jumping to the SAME pinned message a second time still scrolls it into view', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}pr`;

    const { reader, roomName, roomId, api } = await seedRepeatJumpPinRoom(
      request,
      hs,
      runId,
    );

    await login(page, reader);

    await page.getByTestId('rail-rooms').click();

    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

    const targetRow = page.locator('.scroll .msg[data-mid]', {
      hasText: REPEAT_PIN_BODY,
    });
    // Sanity check: it's genuinely loaded before the flood (trivially true here,
    // with only two messages so far) — not itself the regression assertion.
    await targetRow.first().waitFor({ state: 'visible', timeout: 15_000 });

    // Flood the room with live filler traffic — see FILLER_COUNT's comment for why
    // this runs post-login rather than as part of seeding. Sequential + awaited to
    // match the seeding style already used across this suite and
    // timeline-virtualization.spec.mts.
    const lastFillerBody = `pin-repeat filler ${runId} ${FILLER_COUNT - 1}`;
    for (let i = 0; i < FILLER_COUNT; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/pin-repeat-filler-${runId}-${i}`,
        {
          headers: api.headers,
          data: {
            msgtype: 'm.text',
            body: `pin-repeat filler ${runId} ${i}`,
          },
        },
      );
    }

    // The flood lands via live sync and the list's stick-to-bottom effect (the user
    // hasn't scrolled up, so it's still "at bottom") rides it down — the last filler
    // arrives on screen, and the target (now dozens of rows above) scrolls out.
    const lastFillerRow = page.locator('.scroll .msg[data-mid]', {
      hasText: lastFillerBody,
    });
    await expect(lastFillerRow.first()).toBeInViewport({ timeout: 30_000 });
    await expect(targetRow.first()).not.toBeInViewport({ timeout: 15_000 });

    const pinButton = page.getByTestId('open-pinned');
    const heading = page.getByRole('heading', { name: 'Pinned messages' });
    const pinRow = page.locator('.pin-item', { hasText: REPEAT_PIN_BODY });

    // --- First jump: the target is currently out of view — this must bring it
    // into view (unremarkable on its own; the point is proving the SECOND jump,
    // below, does too). ---
    await pinButton.click();
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(pinRow).toBeVisible({ timeout: 10_000 });
    await pinRow.locator('.pin-item__main').click();

    await expect(targetRow.first()).toHaveClass(/msg--flash/, {
      timeout: 1_500,
    });
    // Picking a row closes the slot, so wait for it to be fully hidden before re-opening
    // it below. (It used to be a dialog whose `openAndWait` resolved on jump, with a
    // re-entrancy guard that cleared in the resolve's `finally`; the slot needs no guard
    // because there is one of it.)
    await expect(heading).toBeHidden({ timeout: 10_000 });
    await expect(targetRow.first()).toBeInViewport({ timeout: 15_000 });

    // --- Scroll back away from the target so it's out of view again, exactly as
    // it was before the first jump. ---
    await page
      .locator('.scroll')
      .evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(targetRow.first()).not.toBeInViewport({ timeout: 15_000 });

    // --- Second jump to the SAME event id — the regression assertion. Before the
    // fix, `messageSearchTarget` was already set to this id, so setting it again
    // was a signal no-op and the list's jump effect never re-ran: the target
    // stayed off screen. ---
    await pinButton.click();
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(pinRow).toBeVisible({ timeout: 10_000 });
    await pinRow.locator('.pin-item__main').click();

    await expect(targetRow.first()).toHaveClass(/msg--flash/, {
      timeout: 1_500,
    });
    await expect(heading).toBeHidden({ timeout: 10_000 });
    await expect(targetRow.first()).toBeInViewport({ timeout: 15_000 });
  });

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

    // 1. The slot is seeded to the member roster at this width, and the roster is a fixed
    //    240px navigation column that does not read `--shell-right-panel-w`. A divider there
    //    highlights and moves its value while the pane beside it stays put — and it is the
    //    first divider anyone meets.
    const divider = page.getByRole('separator', { name: 'Panel width' });
    await expect(page.locator('.chat-members')).toBeVisible({
      timeout: 10_000,
    });
    await expect(divider).toHaveCount(0);

    await page.getByTestId('open-pinned').click();
    const panel = page.getByTestId('pinned-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });
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
