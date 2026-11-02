import { testResourceId, test, expect, devices } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { waitUntilStill } from '../../../support/touch-platform.mts';
import { createRoom } from '../../support/space-journey.mts';

/**
 * A page of older history landing under a finger on an iPhone. iOS's native scroll view overwrites
 * a `scrollTop` written during a touch, so the list holds the correction back as a negative margin
 * until the touch ends.
 *
 * Chromium honours those writes, so this cannot show the overwrite; the iPhone user agent only
 * turns the iOS behaviour on, to prove its layout: a real row keeps its place through the page and
 * through the settle, and no second page is asked for. That the overwrite happens, and that this
 * beats it, only the iOS Simulator or a phone can show.
 *
 * Needs a Synapse homeserver (Docker) and self-skips otherwise.
 */
const session = homeserverSession();
const { defaultBrowserType: _browser, ...iPhone } = devices['iPhone 14'];
// Rows stay one line on any font: a wrapped row leaves the gesture short of the load zone.
const MESSAGE_COUNT = 60;

test.describe('Older history under a finger on an iPhone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use(iPhone);

  test('keeps the row in place until the finger lifts, then keeps it there', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ot`;
    const user = `older-touch-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Older touch ${runId}`;
    await registerUser(request, user, pass);
    const { access_token: token } = (await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())) as { access_token: string };
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: token },
      roomName,
    );
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${i}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          data: { msgtype: 'm.text', body: `line ${i}` },
        },
      );
    }

    let pages = 0;
    page.on('request', (r) => {
      if (/\/messages\?.*dir=b/.test(r.url())) pages++;
    });
    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    const scroll = page.locator('.scroll').first();
    await expect(
      page.locator('.msg', { hasText: `line ${MESSAGE_COUNT - 1}` }),
    ).toBeVisible({ timeout: 30_000 });

    // Hold the page back until the finger is down and the row is read.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    page.once('close', release);
    await page.route(/\/messages\?/, async (route) => {
      await gate;
      if (!page.isClosed()) await route.continue();
    });

    const box = await scroll.boundingBox();
    if (!box) throw new Error('no timeline box');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 },
      ],
    });
    // Moved, so holding on does not turn into a long press and open the message sheet.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: box.x + box.width / 2, y: box.y + box.height / 2 + 30, id: 1 },
      ],
    });
    // Let the gesture's own scroll land, or it counts as the page moving the row below.
    await waitUntilStill(page.locator('.msg').last());

    const anchor = await scroll.evaluate((el) => {
      el.scrollTop = 100;
      const top = el.getBoundingClientRect().top;
      const row = Array.from(
        el.querySelectorAll<HTMLElement>('.msg[data-mid]'),
      ).find((candidate) => candidate.getBoundingClientRect().bottom > top);
      if (!row) throw new Error('no row in the viewport');
      return {
        id: row.getAttribute('data-mid') ?? '',
        top: Math.round(row.getBoundingClientRect().top - top),
      };
    });
    const offset = () =>
      scroll.evaluate((el, id) => {
        const row = el.querySelector(`[data-mid="${id}"]`);
        return row
          ? Math.round(
              row.getBoundingClientRect().top - el.getBoundingClientRect().top,
            )
          : null;
      }, anchor.id);
    const held = () =>
      scroll.evaluate((el) =>
        Number.parseFloat(el.style.getPropertyValue('--scroll-hold') || '0'),
      );
    const scrollTop = () => scroll.evaluate((el) => el.scrollTop);

    await expect.poll(() => pages).toBe(1);
    release();

    // The page lands above the reader while the finger stays down.
    await expect.poll(held, { timeout: 30_000 }).toBeLessThan(-200);
    await page.waitForTimeout(500);
    expect(await scrollTop(), 'the list wrote under the finger').toBeLessThan(
      150,
    );
    const whileHeld = await offset();
    expect(whileHeld, 'the row left the DOM under the finger').not.toBeNull();
    expect(
      Math.abs((whileHeld ?? 0) - anchor.top),
      'the page moved the row under the finger',
    ).toBeLessThan(8);
    expect(pages, 'pagination chained under the finger').toBe(1);

    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });

    await expect.poll(held, { timeout: 5_000 }).toBe(0);
    await waitUntilStill(scroll.locator(`.msg[data-mid="${anchor.id}"]`));
    expect(await scrollTop(), 'the settle was not written').toBeGreaterThan(
      200,
    );
    const settled = await offset();
    expect(
      Math.abs((settled ?? 0) - anchor.top),
      'the settle moved the row',
    ).toBeLessThan(8);
    expect(pages, 'pagination chained after the settle').toBe(1);
  });
});
