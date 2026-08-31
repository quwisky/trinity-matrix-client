import { testResourceId, test, expect } from '../fixtures.mts';
import { login, seedPreference, synapseSession } from '../support/app.mts';

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
const FLAG_KEY = 'trinity.flags.virtual-timeline';

test.describe('Timeline virtualization', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('windows a long room while keeping both ends reachable', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const testInfo = test.info();
    const roomName = `Virtualization E2E ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}-${testResourceId('run')}`;

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
        data: { name: roomName, preset: 'private_chat' },
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

    await seedPreference(page, FLAG_KEY, 'true');

    await login(page, session);

    // The seeded room is a plain (non-DM) room, so it lives under the Rooms
    // pill's view, not the default Home view (which shows direct messages
    // only — see RoomsPage.visibleRooms()). Switch to Rooms before looking
    // for its channel row.
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).click();

    // Scoped to the open timeline rather than the whole page — the sidebar's
    // `.channel__preview` row (ChannelSidebarComponent's last-message preview)
    // mirrors the same "seeded message N" text, which would otherwise make a
    // page-wide getByText strict-mode-ambiguous.
    const timeline = page.locator('.scroll');
    const rows = timeline.locator('trn-message-row');
    const positionTimeline = async (bottomGap = 0): Promise<void> => {
      await expect
        .poll(() =>
          timeline.evaluate(async (element, targetGap) => {
            element.scrollTop = Math.max(
              0,
              element.scrollHeight - element.clientHeight - targetGap,
            );
            element.dispatchEvent(new Event('scroll'));
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              );
            });

            const actualGap =
              element.scrollHeight - element.scrollTop - element.clientHeight;
            return Math.abs(actualGap - targetGap);
          }, bottomGap),
        )
        .toBeLessThan(1);
    };
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });

    // The flag selected the windowed component (not the simple one).
    await expect(page.locator('trn-virtual-message-list')).toBeVisible();
    expect(await page.locator('trn-simple-message-list').count()).toBe(0);

    // Opens pinned to the bottom: the newest seeded message is on screen.
    await expect(
      timeline.getByText(`seeded message ${SEED - 1}`, { exact: true }),
    ).toBeVisible();

    // Page the whole room in by scrolling to the top until the oldest arrives
    // (backfill pulls ~30 at a time). Once message 0 renders, all SEED are loaded.
    await expect
      .poll(
        async () => {
          await timeline.evaluate((el) => (el.scrollTop = 0));
          return timeline
            .getByText('seeded message 0', { exact: true })
            .count();
        },
        { timeout: 60_000, intervals: [400] },
      )
      .toBeGreaterThan(0);

    // Everything below is polled rather than read once. The poll above stops the moment
    // message 0 appears, and the virtualizer keeps re-windowing for a frame or two after
    // that — so a single count() can land on the window mid-update. That is what made
    // this spec flaky in CI, and it read as a virtualization bug rather than a race.

    // The core guarantee: with all SEED messages loaded, the DOM holds only a
    // window of rows — and the scroll container is far taller than the viewport
    // (the spacers stand in for the off-screen rows).
    await expect
      .poll(() => rows.count(), { timeout: 10_000 })
      .toBeLessThan(MAX_RENDERED);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = document.querySelector('.scroll') as HTMLElement | null;
            return s ? s.scrollHeight > s.clientHeight * 3 : false;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);

    // At the top, the newest is windowed out of the DOM…
    await expect
      .poll(
        () =>
          timeline
            .getByText(`seeded message ${SEED - 1}`, { exact: true })
            .count(),
        { timeout: 10_000 },
      )
      .toBe(0);

    // …and scrolling back to the bottom brings it back (and drops the oldest).
    await positionTimeline();
    await expect(
      timeline.getByText(`seeded message ${SEED - 1}`, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => rows.count(), { timeout: 10_000 })
      .toBeLessThan(MAX_RENDERED);

    // Composer-driven viewport resizes must exercise the ACTUAL windowed path, not a short
    // room that the virtual list deliberately renders in full. A bottom pin follows growth;
    // even one pixel of deliberate reading offset does not.
    const composer = page.getByTestId('composer-input');
    await positionTimeline();
    await composer.fill('one line');
    await composer.fill('one\ntwo\nthree\nfour\nfive\nsix');
    await expect
      .poll(() =>
        timeline.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(1);
    await expect
      .poll(() => rows.count(), { timeout: 10_000 })
      .toBeLessThan(MAX_RENDERED);

    for (const bottomGap of [1, 119]) {
      await positionTimeline();
      await composer.fill('one line');
      await positionTimeline(bottomGap);
      const before = await timeline.evaluate((element) => element.scrollTop);
      await composer.fill('one\ntwo\nthree\nfour\nfive\nsix');
      await expect
        .poll(() => timeline.evaluate((element) => element.scrollTop))
        .toBe(before);
    }
  });
});
