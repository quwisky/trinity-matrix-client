import {
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Swiping a message row sideways to edit or reply to it (#222), on a real phone profile.
//
// `devices['Pixel 5']` and not `hasTouch`: the gesture is gated on `isMobileOs()`, which
// reads the PLATFORM. A touch-emulated desktop Chromium keeps its desktop user agent, takes
// the desktop path, and a spec written that way would assert nothing at all.
//
// The drag goes in through CDP rather than `page.dispatchEvent` for the reason the drawer's
// spec records: a `PointerEvent` constructed inside the page never passes hit-testing and
// never consults `touch-action`, so it would stay green with the `swipe-through` claim
// deleted from `.scroll` — which is the one thing that makes this gesture reach the page.
const session = synapseSession();

// Capacitor Preferences namespaces its localStorage keys; seeding the bare key writes
// something the app never reads.
const SWIPE_KEY = 'CapacitorStorage.trinity.message-swipe';

/**
 * A real touch drag, through the browser's own input pipeline.
 *
 * Takes an END y as well as a start, unlike the drawer's helper, so a drag that turns
 * vertical is drivable — that is a whole acceptance criterion and a horizontal-only
 * signature cannot express it.
 */
async function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const STEPS = 10;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  for (let step = 1; step <= STEPS; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: Math.round(from.x + ((to.x - from.x) * step) / STEPS),
          y: Math.round(from.y + ((to.y - from.y) * step) / STEPS),
          id: 1,
        },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
}

/** A throwaway account with one room holding one message from someone else and one of ours. */
async function openRoom(
  page: Page,
  request: APIRequestContext,
  tag: string,
  direction: string | null,
): Promise<{ own: string; other: string; roomName: string }> {
  const hs = session.hs as string;
  const runId = `${Date.now().toString(36)}${tag}`;
  const user = `swipeact-${runId}`;
  const pass = `${user}-pass`;
  const friend = `swipefr-${runId}`;
  const roomName = `Swipe ${runId}`;

  await registerUser(request, user, pass);
  await registerUser(request, friend, pass);
  const tokenFor = (who: string) =>
    request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: who },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);

  const token = await tokenFor(user);
  const friendToken = await tokenFor(friend);
  const auth = { Authorization: `Bearer ${token}` };
  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: auth,
      data: { name: roomName, invite: [`@${friend}:localhost`] },
    })
    .then((r) => r.json());
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
    { headers: { Authorization: `Bearer ${friendToken}` } },
  );
  // Someone else's message first, then one of ours: the two outcomes the gesture chooses
  // between, in one room, so a single setup serves both.
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/o-${runId}`,
    {
      headers: { Authorization: `Bearer ${friendToken}` },
      data: { msgtype: 'm.text', body: `theirs ${runId}` },
    },
  );
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/m-${runId}`,
    { headers: auth, data: { msgtype: 'm.text', body: `mine ${runId}` } },
  );

  if (direction) {
    // Capacitor Preferences is localStorage on the web, and this runs before the app boots —
    // which also exercises the restore path the service's `init()` is for.
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [SWIPE_KEY, direction] as const,
    );
  }

  await login(page, { available: true, hs, user, pass } as SynapseSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });

  // Located by their BODY, not by position: `.msg[data-mid]` also matches the system lines
  // the room creation puts at the top (`msg--event`), which render a different element with
  // no gesture on it at all — so `.first()` picks a row that can never swipe.
  const rowFor = async (body: string) => {
    const row = page.locator('.msg[data-mid]', { hasText: body }).last();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    return `.msg[data-mid="${await row.getAttribute('data-mid')}"]`;
  };
  return {
    own: await rowFor(`mine ${runId}`),
    other: await rowFor(`theirs ${runId}`),
    roomName,
  };
}

/** Drag a row rightwards across enough of its width to commit. */
async function swipeRow(page: Page, selector: string): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  const y = box.y + box.height / 2;
  await swipe(
    page,
    { x: box.x + box.width * 0.35, y },
    { x: box.x + box.width * 0.95, y },
  );
}

test.use({ ...devices['Pixel 5'] });

test.describe('Swipe a message', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 120_000 });

  test('swiping your own message opens the editor for it', async ({
    page,
    request,
  }) => {
    const { own } = await openRoom(page, request, 'e', 'right');

    await swipeRow(page, own);

    await expect(page.locator('.composer__banner')).toContainText('Editing', {
      timeout: 10_000,
    });
  });

  test("swiping someone else's message starts a reply to it", async ({
    page,
    request,
  }) => {
    const { other } = await openRoom(page, request, 'r', 'right');

    await swipeRow(page, other);

    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      { timeout: 10_000 },
    );
  });

  test('says which action it will take before you let go', async ({
    page,
    request,
  }) => {
    const { own, other } = await openRoom(page, request, 'a', 'right');

    // The whole cost of "one gesture, two outcomes" is paid here: the reader has to know
    // which they will get, and the icon behind the row is where that is said.
    await expect(page.locator(`${own} .msg__swipe`)).toHaveAttribute(
      'data-swipe-action',
      'edit',
    );
    await expect(page.locator(`${other} .msg__swipe`)).toHaveAttribute(
      'data-swipe-action',
      'reply',
    );
  });

  test('does nothing at all while the setting is off', async ({
    page,
    request,
  }) => {
    // Off must mean the gesture never arms — no affordance rendered, nothing to abandon.
    const { own } = await openRoom(page, request, 'o', null);

    await expect(page.locator(`${own} .msg__swipe`)).toHaveCount(0);
    await swipeRow(page, own);

    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });

  test('follows the direction it was set to, and only that one', async ({
    page,
    request,
  }) => {
    const { other } = await openRoom(page, request, 'l', 'left');

    // Set to Left, a rightward drag is not the gesture.
    await swipeRow(page, other);
    await expect(page.locator('.composer__banner')).toHaveCount(0);

    const box = (await page.locator(other).boundingBox())!;
    const y = box.y + box.height / 2;
    await swipe(
      page,
      { x: box.x + box.width * 0.9, y },
      { x: box.x + box.width * 0.1, y },
    );

    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      { timeout: 10_000 },
    );
  });

  test('a drag that turns vertical is a scroll, not an action', async ({
    page,
    request,
  }) => {
    const { other } = await openRoom(page, request, 'v', 'right');
    const box = (await page.locator(other).boundingBox())!;

    await swipe(
      page,
      { x: box.x + box.width * 0.35, y: box.y + box.height / 2 },
      { x: box.x + box.width * 0.95, y: box.y + box.height / 2 + 120 },
    );

    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });

  test('refuses to start from either screen edge', async ({
    page,
    request,
  }) => {
    // The dead zones. What CI can prove is that the gesture declines to arm inside them;
    // whether they are WIDE ENOUGH to clear the platform's own edge recognisers is a device
    // question — a Pixel 5 profile emulates a viewport and a user agent, not WKWebView's or
    // Android's gesture regions.
    const { other } = await openRoom(page, request, 'd', 'right');
    const box = (await page.locator(other).boundingBox())!;
    const y = box.y + box.height / 2;
    const size = page.viewportSize()!;

    await swipe(page, { x: 4, y }, { x: size.width * 0.8, y });
    await expect(page.locator('.composer__banner')).toHaveCount(0);

    await swipe(page, { x: size.width - 4, y }, { x: size.width * 0.2, y });
    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });

  test('leaves the drawer gesture working', async ({ page, request }) => {
    // A positive assertion, not the absence of a failure: with the setting ON, the drawer's
    // own edge drag must still open and close it. A swipe test that only checked the row
    // would pass just as happily with the drawer broken.
    const { other } = await openRoom(page, request, 'w', 'right');
    const size = page.viewportSize()!;
    const members = page.locator('.chat-members');
    await expect(members).toBeHidden();

    const y = size.height / 2;
    await swipe(page, { x: size.width - 4, y }, { x: size.width * 0.3, y });
    await expect(members).toBeVisible({ timeout: 10_000 });

    // And the row gesture must not arm over an open drawer — the page forces it off, because
    // the drawer arms on any pointerdown anywhere while it is open.
    await expect(page.locator(`${other} .msg__swipe`)).toHaveCount(0);

    await swipe(page, { x: size.width * 0.4, y }, { x: size.width - 4, y });
    await expect(members).toBeHidden({ timeout: 10_000 });
  });

  test('takes effect as soon as it is changed, with no reload', async ({
    page,
    request,
  }) => {
    // Driven through the UI rather than seeded, deliberately: seeding is a reload path and
    // would not establish this at all.
    const { own, roomName } = await openRoom(page, request, 'c', null);
    await expect(page.locator(`${own} .msg__swipe`)).toHaveCount(0);

    // Below the members breakpoint the room is its own PAGE and the user panel that holds
    // the settings button lives on the room list, so the way there is Back first.
    await page.getByTestId('back-to-rooms').click();
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-appearance').click();
    await page.getByTestId('message-swipe-select').locator('button').click();
    await page.getByTestId('message-swipe-right').click();

    // Out of settings the way the app offers, and back to the same room. In-app navigation
    // throughout — a `goto` would be a reload and would not establish the claim at all.
    // Twice, because below the members breakpoint a section is its own sub-page: the first
    // Back leaves Appearance for the section list, the second leaves settings.
    await expect
      .poll(
        async () => {
          if (/\/settings/.test(page.url())) {
            await page.getByRole('button', { name: 'Back' }).click();
          }
          return page.url();
        },
        { timeout: 30_000 },
      )
      .not.toMatch(/\/settings/);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    await expect(page.locator(`${own} .msg__swipe`)).toHaveCount(1, {
      timeout: 20_000,
    });
  });
});
