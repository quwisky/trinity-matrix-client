import {
  testResourceId,
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  seedPreference,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import { cdpSwipe as swipe } from '../../../support/touch-platform.mts';
import { expectForecastStored } from '../../support/encryption-journey.mts';
import { createRoom } from '../../support/space-journey.mts';
import { settleOpenedRoom } from '../../../support/message-composer.mts';

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
const session = homeserverSession();

// Capacitor Preferences namespaces its localStorage keys; seeding the bare key writes
// something the app never reads.
const SWIPE_KEY = 'trinity.message-swipe';
const DRAWER_OPEN_FROM_RIGHT_PX = 44;

/** A throwaway account with one room holding one message from someone else and one of ours. */
async function openRoom(
  page: Page,
  request: APIRequestContext,
  tag: string,
  direction: string | null,
  /** Extra filler messages, for the one test that needs a timeline long enough to scroll. */
  filler = 0,
): Promise<{ own: string; other: string; roomName: string }> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
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
  const room_id = await createRoom(
    request,
    hs,
    { accessToken: token },
    roomName,
    { invite: [`@${friend}:localhost`] },
  );
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
  for (let i = 0; i < filler; i++) {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/f-${runId}-${i}`,
      { headers: auth, data: { msgtype: 'm.text', body: `filler ${i}` } },
    );
  }

  if (direction) {
    await seedPreference(page, SWIPE_KEY, direction);
  }

  await login(page, { available: true, hs, user, pass } as HomeserverSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  // On a phone the encryption prompt of a fresh account waits for the next page switch, so
  // let its status arrive first: opening the room then shows it, and it cannot reflow the
  // surface between boundingBox() and touchStart under parallel load.
  await expectForecastStored(page, 'needs-setup');
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });
  await settleOpenedRoom(page);
  await expect(
    page
      .locator('trn-encryption-banner trn-banner')
      .getByRole('button', { name: 'Set up', exact: true }),
  ).toBeVisible();

  if (filler > 0) {
    // The initial /sync contains only the newest timeline slice, so the two target
    // messages precede it in the long-room cases. Reach the top to trigger one real
    // back-pagination before asking locators for those older rows.
    const scroll = page.locator('.scroll').first();
    await expect
      .poll(
        async () => {
          const loaded = await page
            .locator('.msg[data-mid]', { hasText: `mine ${runId}` })
            .count();
          if (loaded > 0) return true;
          await scroll.evaluate((element) => element.scrollTo({ top: 0 }));
          await page.waitForTimeout(250);
          return false;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  }

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
  const row = page.locator(selector);
  // Besides scrolling, Playwright waits for the element to stop moving here. The
  // incoming row can gain a read-receipt chip just after the room opens; measuring
  // during that reflow occasionally sent the synthetic finger outside the row.
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  await swipe(
    page,
    { x: box.x + box.width * 0.35, y },
    { x: box.x + box.width * 0.95, y },
  );
}

/**
 * Press at the first point, move through the rest a frame at a time, run `during` with the
 * finger still down, then lift. For what can only be read mid-drag.
 */
async function holdDrag(
  page: Page,
  points: readonly { x: number; y: number }[],
  during: () => Promise<void>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const frame = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  try {
    const [first, ...rest] = points;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...first, id: 1 }],
    });
    await frame();
    for (const point of rest) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...point, id: 1 }],
      });
      await frame();
    }
    await during();
  } finally {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await cdp.detach();
  }
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

  test('shows which action it will take, part-way through the drag', async ({
    page,
    request,
  }) => {
    const { own, other } = await openRoom(page, request, 'a', 'right');

    // The whole cost of "one gesture, two outcomes" is paid here: the reader has to know
    // which action is coming before committing to it.
    //
    // What this test does NOT establish is that the icon can be seen. Playwright's
    // `toBeVisible()` ignores opacity entirely — an `opacity: 0` element with a box passes
    // it — so the assertion below would survive the reveal being deleted outright. That
    // claim belongs to `the action fades and grows in`, which measures the computed value.
    const halfway = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!;
      const y = box.y + box.height / 2;
      // Short of the 64px commit distance, and too slow to be a flick: the drag is still
      // abandonable, which is the criterion — "early enough in the drag to abandon it".
      await swipe(
        page,
        { x: box.x + box.width * 0.4, y },
        { x: box.x + box.width * 0.5, y },
      );
    };

    await halfway(own);
    const ownIcon = page.locator(`${own} .msg__swipe`);
    await expect(ownIcon).toBeVisible();
    // The attribute is enough: it and the icon's `[name]` are bound from the SAME
    // `swipeAction()` computed, so they cannot disagree. (`ng-reflect-*` would have been the
    // other way to read the glyph, and it does not exist in a production build.)
    await expect(ownIcon).toHaveAttribute('data-swipe-action', 'edit');

    await halfway(other);
    const otherIcon = page.locator(`${other} .msg__swipe`);
    await expect(otherIcon).toHaveAttribute('data-swipe-action', 'reply');
  });

  test('the action fades and grows in as the drag approaches committing', async ({
    page,
    request,
  }) => {
    // Measured, because this is the half jsdom cannot see: the unit spec pins the progress
    // VALUE, and what a reader actually experiences is the opacity and scale that value
    // drives. A `--swipe-progress` written to an element nothing consumes would satisfy the
    // unit test and show nothing on screen.
    const { other } = await openRoom(page, request, 'p', 'right');
    const row = page.locator(other);
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const icon = page.locator(`${other} .msg__swipe`);

    const shown = () =>
      icon.evaluate((el) => ({
        opacity: Number(getComputedStyle(el).opacity),
        scale: getComputedStyle(el.querySelector('trn-icon')!).scale,
        colour: getComputedStyle(el).color,
      }));

    // A short drag: on its way, not yet committing.
    const cdp = await page.context().newCDPSession(page);
    let currentX = box.x + box.width * 0.35;
    const at = async (x: number) => {
      // Feed the compositor a real path rather than one large move. Android/Chromium can
      // consume the first move to resolve the touch-action axis without forwarding it as a
      // pointermove. Advance on animation frames as well: under parallel browser load,
      // sending the whole path in one renderer turn lets Chromium coalesce every move into
      // the axis-arbitration event, leaving the application with no progress update.
      const from = currentX;
      const steps = 10;
      for (let step = 1; step <= steps; step++) {
        currentX = from + ((x - from) * step) / steps;
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: currentX, y, id: 1 }],
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }
    };
    try {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: currentX, y, id: 1 }],
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );

      // Polled, not read straight after the send: `Input.dispatchTouchEvent` resolves when the
      // event is dispatched, and the handler's style write lands a tick later.
      // 40px is still short of the 64px commit distance, while being far enough past
      // Chromium's gesture-axis arbitration to guarantee pointer moves.
      await at(currentX + 40);
      await expect.poll(async () => (await shown()).opacity).toBeGreaterThan(0);
      const partly = await shown();
      expect(partly.opacity).toBeLessThan(1);

      await at(box.x + box.width * 0.95);
      await expect.poll(async () => (await shown()).opacity).toBe(1);
      const committed = await shown();
      // Grown, and recoloured — "let go now and it will act", said before letting go.
      expect(committed.scale).not.toBe(partly.scale);
      expect(committed.colour).not.toBe(partly.colour);
    } finally {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await cdp.detach();
    }
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
      // Start beyond the viewport-edge dead zone; the old 90% point sits inside the
      // combined native-history and drawer band on this phone profile.
      { x: box.x + box.width * 0.8, y },
      { x: box.x + box.width * 0.1, y },
    );

    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      { timeout: 10_000 },
    );
  });

  test('the affordance waits in the strip the row uncovers', async ({
    page,
    request,
  }) => {
    // The geometry, which nothing else reaches. The unit spec asserts the CLASS and says so;
    // jsdom computes no `justify-content`. The action test asserts WHICH action. Neither
    // notices if `.msg__swipe--end { justify-content: flex-end }` is deleted — and the
    // original bug was exactly that: on a leftward drag the icon stayed at the row's
    // starting left edge, painting over the message text, while the strip that opened on
    // the right stayed empty.
    const { other } = await openRoom(page, request, 'g', 'left');
    const row = page.locator(other);
    const before = (await row.boundingBox())!;
    const y = before.y + before.height / 2;

    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: before.x + before.width * 0.8, y, id: 1 }],
      });
      const fromX = before.x + before.width * 0.8;
      const toX = before.x + before.width * 0.5;
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: fromX + ((toX - fromX) * step) / 10, y, id: 1 }],
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }

      // Mid-drag, before release. A leftward drag opens a strip at the row's right-hand end,
      // so that is where the icon has to be.
      const icon = (await page
        .locator(`${other} .msg__swipe trn-icon`)
        .boundingBox())!;
      const moved = (await row.boundingBox())!;
      const iconCentre = icon.x + icon.width / 2;

      expect(iconCentre).toBeGreaterThan(moved.x + moved.width);
      expect(iconCentre).toBeLessThan(before.x + before.width);
    } finally {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await cdp.detach();
    }
  });

  test("a thumb's arc still replies", async ({ page, request }) => {
    const { other } = await openRoom(page, request, 'v', 'right', 30);
    await page.locator(other).scrollIntoViewIfNeeded();
    const box = (await page.locator(other).boundingBox())!;
    const y = box.y + box.height / 2;

    const scrollTop = () =>
      page
        .locator('.scroll')
        .first()
        .evaluate((el) => el.scrollTop);
    const before = await scrollTop();

    // Opens sideways and drifts 40px up on the way, as a thumb pivoting on its joint does.
    // `touch-action: pan-y` lets the browser decline to pan a drag that opened sideways, so
    // the drift neither scrolls the timeline nor cancels the pointer; the gesture ignores it too.
    // Read before the lift: the reply banner that follows resizes the scroller.
    const startX = box.x + box.width * 0.3;
    const travel = box.width * 0.45;
    await holdDrag(
      page,
      Array.from({ length: 11 }, (_, step) => ({
        x: Math.round(startX + (travel * step) / 10),
        y: Math.round(y - (40 * step) / 10),
      })),
      async () => {
        expect(await scrollTop()).toBe(before);
        await expect(page.locator(`${other}.msg--swipe-armed`)).toHaveCount(1);
      },
    );

    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      { timeout: 10_000 },
    );
  });

  test('a vertical drag still scrolls the timeline', async ({
    page,
    request,
    touchPlatform,
  }) => {
    // The other half of the same criterion, and the one that needs a real browser: the row
    // gesture must not have taken the vertical axis away from the scroller.
    const { other } = await openRoom(page, request, 's', 'right', 30);
    await page.locator(other).scrollIntoViewIfNeeded();
    const box = (await page.locator(other).boundingBox())!;
    const scrollTop = () =>
      page
        .locator('.scroll')
        .first()
        .evaluate((el) => el.scrollTop);
    const { before } = await page
      .locator('.scroll')
      .first()
      .evaluate((el) => ({
        before: el.scrollTop,
      }));
    // scrollIntoView() may place this older row at either end of the currently
    // loaded slice. Swipe toward whichever direction still has scroll range.
    // The target is an older row near the top edge. Prefer dragging downward
    // while there is content above it, which keeps the endpoint on-screen.
    const distance = before > 1 ? 100 : -100;

    await touchPlatform.swipe(
      page,
      { x: box.x + box.width * 0.5, y: box.y + box.height / 2 },
      {
        x: box.x + box.width * 0.5,
        y: box.y + box.height / 2 + distance,
      },
    );

    await expect.poll(scrollTop, { timeout: 5_000 }).not.toBe(before);
    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });

  // The dead zones. What CI can prove is that the gesture declines to arm inside them;
  // whether they are WIDE ENOUGH to clear the platform's own edge recognisers is a device
  // question — a Pixel 5 profile emulates a viewport and a user agent, not WKWebView's or
  // Android's gesture regions.
  test('a rightward swipe refuses the back strip and the drawer band', async ({
    page,
    request,
  }) => {
    const { other } = await openRoom(page, request, 'd', 'right');
    const row = page.locator(other);
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const size = page.viewportSize()!;

    // Inside the 32px strip iOS's and Android's Back pan from.
    await swipe(page, { x: 30, y }, { x: size.width * 0.8, y });
    await expect(page.locator('.composer__banner')).toHaveCount(0);

    // Just past it. Also the positive control: without it every refusal here would pass as
    // happily against a gesture that was broken outright or a seed that never applied.
    await swipe(page, { x: 34, y }, { x: size.width * 0.8, y });
    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      { timeout: 10_000 },
    );

    // Inside 56px of the right edge the row must not arm, or its `stopPropagation` would keep
    // the drawer from seeing the press. This goes last because the drawer's backdrop covers
    // every row for the rest of the test.
    await swipe(
      page,
      { x: size.width - DRAWER_OPEN_FROM_RIGHT_PX, y },
      { x: size.width * 0.2, y },
    );
    await expect(page.locator('.chat-members')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('a leftward swipe arms at the left edge and refuses the drawer band', async ({
    page,
    request,
  }) => {
    const { other } = await openRoom(page, request, 'k', 'left');
    const row = page.locator(other);
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const size = page.viewportSize()!;

    // No Back gesture pans leftward from the left edge, so the row arms there. 20px of room
    // is short of the 32px a flick needs, so arming is all such a start can show.
    await holdDrag(
      page,
      [20, 16, 12, 8, 4, 2].map((x) => ({ x, y })),
      async () => {
        await expect
          .poll(() =>
            row.evaluate((el) => el.style.getPropertyValue('--swipe-drag')),
          )
          .toBe('-18px');
      },
    );
    await expect(page.locator('.composer__banner')).toHaveCount(0);

    // Inside 56px of the right edge: refused, and the drawer gets the press instead.
    await swipe(
      page,
      { x: size.width - DRAWER_OPEN_FROM_RIGHT_PX, y },
      { x: size.width * 0.2, y },
    );
    await expect(page.locator('.chat-members')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });

  for (const setting of ['left', 'off'] as const) {
    test(`leaves the drawer gesture working with the setting ${setting}`, async ({
      page,
      request,
    }) => {
      // #222 asks for the drawer to still work "in both directions and with the setting
      // Off". Covering only one direction would leave the two settings most likely to
      // interfere — Left, which drags the same way the drawer closes — untested.
      // The drawer, which has a close drag; below md the roster is a page that leaves
      // closing to Back.
      await page.setViewportSize({ width: 800, height: 900 });
      await openRoom(
        page,
        request,
        setting[0],
        setting === 'off' ? null : setting,
      );
      const size = page.viewportSize()!;
      const members = page.locator('.chat-members');
      const y = size.height / 2;

      await expect(members).toBeHidden();
      await swipe(
        page,
        { x: size.width - DRAWER_OPEN_FROM_RIGHT_PX, y },
        { x: size.width * 0.3, y },
      );
      await expect(members).toBeVisible({ timeout: 10_000 });

      await swipe(page, { x: size.width * 0.4, y }, { x: size.width - 4, y });
      await expect(members).toBeHidden({ timeout: 10_000 });
    });
  }

  test('leaves the drawer gesture working', async ({ page, request }) => {
    // A positive assertion, not the absence of a failure: with the setting ON, the drawer's
    // own edge drag must still open and close it. A swipe test that only checked the row
    // would pass just as happily with the drawer broken.
    // The drawer, which has a close drag; below md the roster is a page that leaves
    // closing to Back.
    await page.setViewportSize({ width: 800, height: 900 });
    const { other } = await openRoom(page, request, 'w', 'right');
    const size = page.viewportSize()!;
    const members = page.locator('.chat-members');
    await expect(members).toBeHidden();

    const y = size.height / 2;
    await swipe(
      page,
      { x: size.width - DRAWER_OPEN_FROM_RIGHT_PX, y },
      { x: size.width * 0.3, y },
    );
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
    await openSettingsSection(page, 'appearance');
    await page.getByTestId('message-swipe-select').locator('button').click();
    await page.getByTestId('message-swipe-right').click();

    // Dismiss the web modal or unwind the native Settings routes without reloading, then
    // return to the same room. This proves the live signal update rather than merely its
    // persisted reload path.
    await closeSettings(page);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    expect(new URL(page.url()).pathname).not.toMatch(/\/settings/);

    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    await expect(page.locator(`${own} .msg__swipe`)).toHaveCount(1, {
      timeout: 20_000,
    });
  });
});
