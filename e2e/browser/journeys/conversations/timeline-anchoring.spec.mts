import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

/**
 * Paging in older history must not move what the reader is looking at.
 *
 * This is the invariant the windowed timeline exists to maintain, and it is one that can be
 * broken from a distance. `VirtualMessageListComponent` captures an anchor before it asks
 * for more history and restores the scroll position afterwards, while fresh rows move from
 * estimated heights to real browser measurements.
 *
 * No linter sees that, and no unit test can: jsdom does no layout, so the relationship
 * between estimated row heights, rendered heights and a physical scroll position is
 * invisible until something renders. What makes it checkable is measuring a real row's
 * position across a real backfill, which is what this does — and it holds whatever the next
 * change is, rather than pinning the one mechanism that happened to break.
 *
 * Needs a Synapse homeserver (Docker) and self-skips otherwise.
 */
const session = synapseSession();

/** Comfortably more than one page, so scrolling to the top pages in real history. */
const MESSAGE_COUNT = 45;

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Timeline anchoring', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps the reader in place when older history pages in', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}an`;
    const user = `anchor-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Anchor ${runId}`;

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
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    for (let i = 0; i < MESSAGE_COUNT; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${i}`,
        { headers, data: { msgtype: 'm.text', body: `line ${i} ${runId}` } },
      );
    }

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const scroll = page.locator('.scroll').first();
    await expect(scroll).toBeVisible();
    await expect(
      scroll.locator(':scope > .vpad'),
      'the anchoring regression must exercise the virtual-list implementation',
    ).toHaveCount(2);

    // Settle by waiting for the NEWEST message to be on screen, rather than polling a
    // distance-from-bottom number. The windowed list renders a moving slice, so that number
    // moves for reasons unrelated to whether the initial scroll has finished.
    await expect(
      page.locator('.msg', { hasText: `line ${MESSAGE_COUNT - 1} ${runId}` }),
    ).toBeVisible({ timeout: 30_000 });

    const rowCount = () => page.locator('.msg').count();
    const before = await rowCount();
    expect(before, 'expected a partial window to page into').toBeGreaterThan(5);

    // Scroll and capture the anchor in ONE evaluate, before yielding to the event loop.
    //
    // Doing them as two Playwright calls is a race: the app reacts to the scroll — asks for
    // history, renders the strip, re-windows the rows — in the gap between them, so the
    // "before" reading is already partly "after" and the comparison means nothing. That is
    // what the first version of this test did, and it reported a 42px shift on a branch with
    // nothing wrong with it.
    const anchor = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.scroll');
      if (!scroller) {
        throw new Error('timeline scroller is missing');
      }
      scroller.scrollTo({ top: 0 });
      const viewport = scroller.getBoundingClientRect();
      const row = Array.from(
        scroller.querySelectorAll<HTMLElement>('.msg[data-mid]'),
      ).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      const id = row?.getAttribute('data-mid');
      if (!row || !id) {
        throw new Error('no event row intersects the timeline viewport');
      }
      return {
        id,
        top: Math.round(row.getBoundingClientRect().top - viewport.top),
      };
    });

    // Wait for the backfill to land.
    await expect.poll(rowCount, { timeout: 30_000 }).toBeGreaterThan(before);
    const settledCount = await rowCount();

    /** The same message's position, once everything has settled. */
    const offsetOf = (id: string) =>
      page.evaluate((mid) => {
        const scroller = document.querySelector<HTMLElement>('.scroll');
        const row = Array.from(
          scroller?.querySelectorAll<HTMLElement>('.msg[data-mid]') ?? [],
        ).find((candidate) => candidate.getAttribute('data-mid') === mid);
        if (!scroller || !row) {
          return null;
        }
        return Math.round(
          row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top,
        );
      }, id);

    await page.waitForTimeout(1500);
    expect(await rowCount(), 'pagination chained after the measured page').toBe(
      settledCount,
    );
    await expect(
      page.locator('.load-older'),
      'the loading strip outlived the settled page',
    ).toHaveCount(0);

    const after = await offsetOf(anchor.id);
    if (after === null) {
      throw new Error('the anchored message left the DOM');
    }
    await page.waitForTimeout(100);
    expect(
      await offsetOf(anchor.id),
      'the anchored message was still moving after pagination settled',
    ).toBe(after);

    const drift = Math.abs(after - anchor.top);
    const moved = `anchored message moved from ${anchor.top} to ${after} (${drift}px)`;

    expect(drift, moved).toBeLessThan(8);
  });
});
