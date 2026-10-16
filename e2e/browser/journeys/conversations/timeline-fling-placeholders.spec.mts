import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  seedPreference,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { sendWithRetry } from '../../support/cs-api.mts';

// "Blank rows while scrolling fast" (Settings › Experimental): with the flag on, a fling
// through a long room mounts blank placeholders for the rows it passes instead of full rows,
// and the real rows mount once it settles; with it off, every row mounts in full, as before.
// Real browser only: jsdom has no scrolling or layout.
const session = homeserverSession();
const FLAG_KEY = 'trinity.flags.fling-placeholders';
const MESSAGES = 160;
/** Pixels per frame: about 18,000 px/s at 60 fps, a hard fling. */
const FLING_STEP_PX = 300;

interface SeededRoom {
  credentials: HomeserverSession;
  roomName: string;
}

async function seedLongRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<SeededRoom> {
  const user = `fling-rows-${runId}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const account = await passwordLogin(request, hs, user, pass);
  const headers = { Authorization: `Bearer ${account.accessToken}` };
  const roomName = `Fling rows ${runId}`;
  const created = await sendWithRetry('create room', () =>
    request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    }),
  );
  const { room_id: roomId } = (await created.json()) as { room_id: string };
  const room = encodeURIComponent(roomId);
  for (let i = 0; i < MESSAGES; i += 1) {
    // Every fourth message runs to a few lines, so rows differ in height as in a real room.
    const body =
      i % 4 === 0
        ? `message ${i}: ${'a longer line of text that wraps '.repeat(6)}`
        : `message ${i}`;
    await sendWithRetry(`send message ${i}`, () =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${room}/send/m.room.message/${runId}-${i}`,
        { headers, data: { msgtype: 'm.text', body } },
      ),
    );
  }
  return { credentials: { available: true, hs, user, pass }, roomName };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const room = page.locator('.channel', { hasText: roomName }).first();
  await room.waitFor({ state: 'visible', timeout: 30_000 });
  await room.click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });
}

/** Page the whole room in, then walk back to the newest message in steps the list settles between. */
async function loadWholeRoom(page: Page): Promise<void> {
  const timeline = page.locator('[data-message-scroller]');
  await expect
    .poll(
      async () => {
        await timeline.evaluate((el) => (el.scrollTop = 0));
        return timeline.getByText('message 0:', { exact: false }).count();
      },
      { timeout: 60_000, intervals: [400] },
    )
    .toBeGreaterThan(0);
  await timeline.evaluate(async (el) => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await pause(500);
    while (el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
      el.scrollTop += el.clientHeight / 2;
      await pause(300);
    }
    await pause(500);
  });
}

/**
 * Fling from the newest message to the oldest, one step per frame, and count the full rows
 * and the placeholders that mounted while it moved.
 */
async function fling(page: Page): Promise<{
  rows: number;
  placeholders: number;
  hiddenPlaceholders: boolean;
}> {
  return page.locator('[data-message-scroller]').evaluate(async (el, step) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    let rows = 0;
    let placeholders = 0;
    let hiddenPlaceholders = true;
    const count = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.matches('trn-message-row')) rows += 1;
          if (node.matches('[data-placeholder-mid]')) {
            placeholders += 1;
            hiddenPlaceholders &&= node.getAttribute('aria-hidden') === 'true';
          }
        }
      }
    };
    await new Promise((r) => setTimeout(r, 500));
    const observer = new MutationObserver(count);
    observer.observe(el, { childList: true, subtree: true });
    while (el.scrollTop > 0) {
      el.scrollTop = Math.max(0, el.scrollTop - step);
      await frame();
    }
    await frame();
    count(observer.takeRecords());
    observer.disconnect();
    return { rows, placeholders, hiddenPlaceholders };
  }, FLING_STEP_PX);
}

/** Once the list has settled, every row on screen is a full row. */
async function expectRealRowsOnScreen(page: Page): Promise<void> {
  const timeline = page.locator('[data-message-scroller]');
  await expect(timeline.locator('[data-placeholder-mid]')).toHaveCount(0);
  await expect
    .poll(() =>
      timeline.evaluate((el) => {
        const view = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll('.msg[data-mid]')).filter(
          (row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > view.top && box.top < view.bottom;
          },
        ).length;
      }),
    )
    .toBeGreaterThan(0);
}

test.describe('Rows in a fast-scrolled timeline', () => {
  test.skip(!session.available, 'needs a Matrix homeserver');

  test('with "Blank rows while scrolling fast" on, rows flying past are placeholders until the fling settles', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}on`;
    const seeded = await seedLongRoom(request, session.hs as string, runId);
    await seedPreference(page, FLAG_KEY, 'true');
    await login(page, seeded.credentials);
    await openRoom(page, seeded.roomName);
    await loadWholeRoom(page);

    const { rows, placeholders, hiddenPlaceholders } = await fling(page);

    // The fling passed most of the room as placeholders, hidden from assistive technology,
    // and mounted few full rows.
    expect(placeholders).toBeGreaterThanOrEqual(MESSAGES / 2);
    expect(hiddenPlaceholders).toBe(true);
    expect(rows).toBeLessThanOrEqual(placeholders / 4);
    await expectRealRowsOnScreen(page);
  });

  test('with the flag on, a row holding focus keeps it through a fling that leaves it on screen', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}focus`;
    const seeded = await seedLongRoom(request, session.hs as string, runId);
    await seedPreference(page, FLAG_KEY, 'true');
    await login(page, seeded.credentials);
    await openRoom(page, seeded.roomName);
    await loadWholeRoom(page);

    const timeline = page.locator('[data-message-scroller]');
    const focused = await timeline.evaluate(async (el) => {
      const view = el.getBoundingClientRect();
      const row = Array.from(
        el.querySelectorAll<HTMLElement>('.msg[data-mid][tabindex]'),
      ).find((candidate) => {
        const box = candidate.getBoundingClientRect();
        return box.top > view.top + 100 && box.bottom < view.bottom - 100;
      });
      if (!row) return null;
      row.focus();
      // A short, fast fling: 600 px in four frames, within the window's overscan.
      for (let i = 0; i < 4; i += 1) {
        el.scrollTop -= 150;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return row.getAttribute('data-mid');
    });
    expect(focused).not.toBeNull();

    // Through the fling and after it settles, the same row element keeps focus.
    await expect(timeline.locator(`.msg[data-mid="${focused}"]`)).toBeFocused();
    await expectRealRowsOnScreen(page);
    await expect(timeline.locator(`.msg[data-mid="${focused}"]`)).toBeFocused();
  });

  test('with the flag off, every row mounts in full as it passes', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}off`;
    const seeded = await seedLongRoom(request, session.hs as string, runId);
    await login(page, seeded.credentials);
    await openRoom(page, seeded.roomName);
    await loadWholeRoom(page);

    const { rows, placeholders } = await fling(page);

    expect(placeholders).toBe(0);
    expect(rows).toBeGreaterThanOrEqual(MESSAGES / 2);
    await expectRealRowsOnScreen(page);
  });
});
