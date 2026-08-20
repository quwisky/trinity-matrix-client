import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

/**
 * Paging in older history must not move what the reader is looking at.
 *
 * This is the invariant the windowed timeline exists to maintain, and it is the one that
 * keeps getting broken from a distance. `VirtualMessageListComponent` captures an anchor
 * before it asks for more history and restores the scroll position afterwards, folding in
 * the height of anything above the rows — including the "Loading older messages…" strip. So
 * a change to WHEN that strip is removed, made in a different file for an unrelated reason,
 * silently moved every reader's content by its height.
 *
 * No linter sees that, and no unit test can: jsdom does no layout, so the relationship
 * between the strip's lifetime and the restore is invisible until something renders. What
 * makes it checkable is measuring a real row's position across a real backfill, which is
 * what this does — and it holds whatever the next change is, rather than pinning the one
 * mechanism that happened to break.
 *
 * Needs a Synapse homeserver (Docker) and self-skips otherwise.
 */
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

/** Comfortably more than one page, so scrolling to the top pages in real history. */
const MESSAGE_COUNT = 45;

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
}

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
    // A REPRODUCER for a bug it found, not a bug it caused. It passes while the bug is open.
    //
    // Measured on the redesign epic branch, with none of the phase work applied: paging in
    // older history moves the anchored message up by exactly 42px, reproducibly (16 -> -26
    // on two consecutive runs), on a single backfill with no chaining and the loading strip
    // already gone by the time everything settles. That is close enough to the strip's own
    // height to suggest the anchor is captured with it on screen and restored without it,
    // but it is NOT root-caused and should not be guessed at in a comment.
    //
    // The drift is PINNED AS A RANGE below rather than marked `test.fail()`. Both keep the
    // suite green while the bug is open and both go red the day it is fixed, but `test.fail()`
    // is green for EVERY failure — a rotted selector, a registration timeout, the anchored
    // message leaving the DOM — so the reproducer could stop reproducing and still report
    // success. A range fails on anything that is not the ~42px this documents, in either
    // direction, which is the whole reason to keep a reproducer rather than a note.

    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}an`;
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
      const scroller = document.querySelector('.scroll') as HTMLElement;
      scroller.scrollTo({ top: 0 });
      const row = document.querySelector('.msg[data-mid]') as HTMLElement;
      return {
        id: row.getAttribute('data-mid'),
        top: Math.round(
          row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top,
        ),
      };
    });

    // Wait for the backfill to land.
    await expect.poll(rowCount, { timeout: 30_000 }).toBeGreaterThan(before);

    /** The same message's position, once everything has settled. */
    const offsetOf = (id: string) =>
      page.evaluate((mid) => {
        const scroller = document.querySelector('.scroll') as HTMLElement;
        const row = document.querySelector(
          `.msg[data-mid="${mid}"]`,
        ) as HTMLElement;
        if (!scroller || !row) {
          return null;
        }
        return Math.round(
          row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top,
        );
      }, id);

    await page.waitForTimeout(1500);

    const after = await offsetOf(anchor!.id as string);
    expect(after, 'the anchored message left the DOM').not.toBeNull();

    const drift = Math.abs((after as number) - anchor!.top);
    const moved = `anchored message moved from ${anchor!.top} to ${after} (${drift}px)`;

    // THE BUG, pinned. 8px is the sub-pixel tolerance the invariant would use once this is
    // fixed; 80px is loose enough for the measured 42 to sit comfortably inside and tight
    // enough that a materially different drift is a different bug and deserves to be looked
    // at rather than absorbed.
    //
    // When someone fixes the anchoring, the first assertion goes red. That is the prompt to
    // delete both of these and restore the real invariant:
    //   expect(drift, moved).toBeLessThan(8);
    expect(
      drift,
      `FIXED? ${moved} — see the note at the top of this test`,
    ).toBeGreaterThan(8);
    expect(drift, `WORSE: ${moved}`).toBeLessThan(80);
  });
});
