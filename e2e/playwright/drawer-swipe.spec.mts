import { test, expect, devices, type Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// The drawer gesture, on the only kind of device that has one.
//
// Below the `members` breakpoint the shell's right-hand slot is a fixed overlay; above it the
// slot is a column sharing the row and there is nothing to swipe. Every other authenticated
// spec runs the desktop project, where the drawer does not exist and `pointerType` is `mouse`
// — which the directive ignores on purpose, since a mouse has the toolbar button.
//
// The unit spec pins the arithmetic against synthetic events. What only a real device profile
// and REAL touch input can show is whether the gesture is REACHABLE: whether the browser hands
// the horizontal moves to the page at all, or consumes them as a scroll. That is what
// `touch-action: pan-y` on the chat body is for; it is invisible to jsdom, and invisible to a
// synthetic `dispatchEvent` too — see `swipe` below.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

// Centre of DrawerSwipeDirective's 24px opening band, which begins after the 32px strip
// reserved for native history gestures. This spec cannot make Chromium perform iOS Forward,
// but real touch input proves the drawer leaves that extreme strip alone.
const DRAWER_OPEN_FROM_RIGHT_PX = 44;

/**
 * A REAL touch drag, through the browser's own input pipeline.
 *
 * Not `page.dispatchEvent`: that constructs a `PointerEvent` inside the page and dispatches it
 * from JavaScript, so it never passes hit-testing and never consults `touch-action`. A
 * synthetic swipe proves nothing about the one thing this spec exists for — it stays green
 * with `touch-action` deleted from `.chat-body`, which is exactly the regression the pairing
 * guard in `styling-tokens.spec.mjs` is there to catch and this spec claimed to.
 *
 * CDP `Input.dispatchTouchEvent` goes in the way a device touch does, so the browser gets to
 * decide whether to hand the moves to the page or eat them as a scroll. Chromium-only, which
 * is the only project this suite runs.
 */
async function swipe(page: Page, fromX: number, toX: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  const STEPS = 10;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: fromX, y, id: 1 }],
  });
  for (let step = 1; step <= STEPS; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: Math.round(fromX + ((toX - fromX) * step) / STEPS), y, id: 1 },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
}

test.use({ ...devices['Pixel 5'] });

test.describe('Drawer swipe on a touch device', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('reserves native history edge, then opens from its inset band and closes', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sw`;
    const user = `swipe-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Swipe ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    const members = page.locator('.chat-members');
    // A phone seeds the slot closed — the drawer must not render open on a mobile load.
    await expect(members).toBeHidden();

    const size = page.viewportSize()!;
    const y = Math.round(size.height / 2);

    // The extreme edge belongs to native history and must not summon the drawer.
    await swipe(page, size.width - 4, Math.round(size.width * 0.3), y);
    await expect(members).toBeHidden();

    // The adjacent inset band is the drawer affordance.
    await swipe(
      page,
      size.width - DRAWER_OPEN_FROM_RIGHT_PX,
      Math.round(size.width * 0.3),
      y,
    );
    await expect(members).toBeVisible({ timeout: 10_000 });

    // And away again, from anywhere on the drawer.
    await swipe(page, Math.round(size.width * 0.4), size.width - 4, y);
    await expect(members).toBeHidden({ timeout: 10_000 });
  });

  test('leaves the drawer alone for a swipe that starts away from the edge', async ({
    page,
    request,
  }) => {
    // Otherwise every leftward flick over the timeline would summon the roster, and the
    // timeline is the surface people swipe over most.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}nw`;
    const user = `noswipe-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `NoSwipe ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    const size = page.viewportSize()!;
    await swipe(
      page,
      Math.round(size.width / 2),
      20,
      Math.round(size.height / 2),
    );

    await expect(page.locator('.chat-members')).toBeHidden();
  });
});
