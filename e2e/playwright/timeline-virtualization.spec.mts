import { test, expect } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// Seeds a long room over the CS API, turns on the virtualized-timeline flag, and
// asserts the timeline windows: even after every message is paged into the client,
// only a bounded number of rows are in the DOM, and both ends of the room stay
// reachable (oldest at the top, newest at the bottom). This is the real-browser
// check the unit tests can't do (jsdom has no layout). Needs a Synapse homeserver
// (Docker) and self-skips otherwise, like the other web e2e specs.
const session = synapseSession();
const SEED = 200;
/** Upper bound on rows kept in the DOM at once — comfortably above the window,
 * far below SEED, so a bounded DOM is unambiguous. */
const MAX_RENDERED = 80;
const FLAG_KEY = 'CapacitorStorage.trinity.flags.virtual-timeline';

test.describe('Timeline virtualization', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('windows a long room while keeping both ends reachable', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;

    // Seed a room with SEED messages straight through the CS API (fast).
    const auth = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: session.user },
          password: session.pass,
        },
      })
      .then((r) => r.json())
      .then((j) => ({ Authorization: `Bearer ${j.access_token}` }));

    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: 'Virtualization E2E', preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    for (let i = 0; i < SEED; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(
          roomId,
        )}/send/m.room.message/vt-${i}`,
        {
          headers: auth,
          data: { msgtype: 'm.text', body: `seeded message ${i}` },
        },
      );
    }

    // Turn the flag on before the app boots (Capacitor Preferences → localStorage).
    await page.addInitScript(
      (key) => localStorage.setItem(key, 'true'),
      FLAG_KEY,
    );

    await login(page, session);
    await page
      .locator('.channel', { hasText: 'Virtualization E2E' })
      .first()
      .click();

    const rows = page.locator('.scroll trn-message-row');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });

    // Opens pinned to the bottom: the newest seeded message is on screen.
    await expect(
      page.getByText(`seeded message ${SEED - 1}`, { exact: true }),
    ).toBeVisible();

    // Page the whole room in by scrolling to the top until the oldest arrives
    // (backfill pulls ~30 at a time). Once message 0 renders, all SEED are loaded.
    await expect
      .poll(
        async () => {
          await page.locator('.scroll').evaluate((el) => (el.scrollTop = 0));
          return page.getByText('seeded message 0', { exact: true }).count();
        },
        { timeout: 60_000, intervals: [400] },
      )
      .toBeGreaterThan(0);

    // The core guarantee: with all SEED messages loaded, the DOM holds only a
    // window of rows — and the scroll container is far taller than the viewport
    // (the spacers stand in for the off-screen rows).
    expect(await rows.count()).toBeLessThan(MAX_RENDERED);
    expect(
      await page.evaluate(() => {
        const s = document.querySelector('.scroll') as HTMLElement | null;
        return s ? s.scrollHeight > s.clientHeight * 3 : false;
      }),
    ).toBe(true);

    // At the top, the newest is windowed out of the DOM…
    expect(
      await page
        .getByText(`seeded message ${SEED - 1}`, { exact: true })
        .count(),
    ).toBe(0);

    // …and scrolling back to the bottom brings it back (and drops the oldest).
    await page
      .locator('.scroll')
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(
      page.getByText(`seeded message ${SEED - 1}`, { exact: true }),
    ).toBeVisible();
    expect(await rows.count()).toBeLessThan(MAX_RENDERED);
  });
});
