import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// End-to-end for the message list's jump-to-latest pill: once the user scrolls up
// away from the newest message a pill appears (`data-testid="jump-to-latest"`), and
// clicking it scrolls back to the bottom and hides the pill again
// (SimpleMessageListComponent.scrollToLatest / the notAtBottom signal). Seeds a room
// with enough long messages that the loaded timeline overflows the viewport, so
// scrolling up is actually possible. Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

// The initial /sync caps the timeline at ~20 events, so seed 20 tall (wrapping)
// messages — comfortably past a 1280x720 viewport's worth of rows once loaded.
const MESSAGE_COUNT = 20;
const LONG_BODY = `lorem ipsum dolor sit amet `.repeat(18);

interface ApiUser {
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
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/** A reader who creates a room and posts enough long messages to overflow the view. */
async function seedBusyRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; roomName: string }> {
  const readerUser = `jump-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  const roomName = `Jump E2E ${runId}`;
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  let lastEventId = '';
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const sent = await request
      .put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${i}`,
        {
          headers: reader.headers,
          data: { msgtype: 'm.text', body: `Message ${i}: ${LONG_BODY}` },
        },
      )
      .then((r) => r.json());
    lastEventId = sent.event_id as string;
  }

  // Mark the room read up to the newest message so no "New messages" divider (and its
  // jump-to-unread pill) competes with the jump-to-latest pill under test.
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
    {
      headers: reader.headers,
      data: { 'm.fully_read': lastEventId, 'm.read': lastEventId },
    },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

test.describe('Jump to latest', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('offers a jump-to-latest pill after scrolling up and returns to the bottom', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}j`;
    const { reader, roomName } = await seedBusyRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoom(page, roomName);

    const scroll = page.locator('.scroll');
    const pill = page.getByTestId('jump-to-latest');

    // The timeline opens pinned to the newest message; wait for that initial
    // auto-scroll to settle at the bottom before touching the scroll position,
    // otherwise it overrides the scroll-up and the pill never shows.
    await expect(scroll).toBeVisible();
    await expect
      .poll(
        () =>
          scroll.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        { timeout: 15_000 },
      )
      .toBeLessThan(50);
    await expect(pill).toBeHidden();

    // The loaded timeline overflows the viewport, so scrolling up is possible.
    const range = await scroll.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    expect(range, `scrollable range ${range}px`).toBeGreaterThan(300);

    // Desktop Chromium accepts a wheel gesture. Android's attached WebView does
    // not receive Playwright's synthetic mouse wheel, so drive the same scroll
    // container directly there and let its real scroll event update the signal.
    if (isAndroidE2E) {
      await scroll.evaluate((element) => element.scrollBy({ top: -3000 }));
    } else {
      await scroll.hover();
      await page.mouse.wheel(0, -3000);
    }
    await expect(pill).toBeVisible({ timeout: 15_000 });

    // Jumping returns to the newest message and dismisses the pill.
    await pill.click();
    await expect(pill).toBeHidden({ timeout: 15_000 });
  });
});
