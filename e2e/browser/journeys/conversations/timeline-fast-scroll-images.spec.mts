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
import { solidPng } from '../../support/png.mts';

// "Load images after fast scrolling" (Settings › Experimental): with the flag on, a fling
// through a room of images leaves the rows it passes as placeholders and loads the images
// once the list settles; with it off, every image row shows its image as it mounts, as
// before. Real browser only: jsdom has no scrolling, layout or IntersectionObserver.
const session = homeserverSession();
const FLAG_KEY = 'trinity.flags.defer-media-while-scrolling';
const IMAGES = 40;
/** Text messages after each image: with them the room is well past the 80 rows the list
 * renders in full, so it windows and the fling mounts rows as they pass. */
const TEXTS_PER_IMAGE = 2;
/** Pixels per frame: about 18,000 px/s at 60 fps, a hard fling. */
const FLING_STEP_PX = 300;

interface SeededRoom {
  credentials: HomeserverSession;
  roomName: string;
}

async function seedImageRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<SeededRoom> {
  const user = `fast-scroll-${runId}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const account = await passwordLogin(request, hs, user, pass);
  const headers = { Authorization: `Bearer ${account.accessToken}` };
  const roomName = `Fast scroll images ${runId}`;
  const created = await sendWithRetry('create room', () =>
    request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    }),
  );
  const { room_id: roomId } = (await created.json()) as { room_id: string };
  const room = encodeURIComponent(roomId);
  // 4:3 like the size the events declare, so a loaded image keeps its reserved box.
  const png = solidPng(64, 48);
  for (let i = 0; i < IMAGES; i += 1) {
    // One upload per message: every row has its own media, as in a real room.
    const upload = await sendWithRetry(`upload image ${i}`, () =>
      request.post(
        `${hs}/_matrix/media/v3/upload?filename=fast-scroll-${i}.png`,
        { headers: { ...headers, 'Content-Type': 'image/png' }, data: png },
      ),
    );
    const { content_uri: mxc } = (await upload.json()) as {
      content_uri: string;
    };
    await sendWithRetry(`send image ${i}`, () =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${room}/send/m.room.message/${runId}-img-${i}`,
        {
          headers,
          data: {
            msgtype: 'm.image',
            body: `fast-scroll-${i}.png`,
            url: mxc,
            info: { mimetype: 'image/png', size: png.length, w: 320, h: 240 },
          },
        },
      ),
    );
    for (let t = 0; t < TEXTS_PER_IMAGE; t += 1) {
      await sendWithRetry(`send text ${i}.${t}`, () =>
        request.put(
          `${hs}/_matrix/client/v3/rooms/${room}/send/m.room.message/${runId}-txt-${i}-${t}`,
          {
            headers,
            data: { msgtype: 'm.text', body: `after image ${i}, line ${t}` },
          },
        ),
      );
    }
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

/**
 * Page the whole room in, then walk it from the oldest message to the newest in steps the
 * list settles between, so every image has loaded once before the fling.
 */
async function loadEveryImage(page: Page): Promise<void> {
  const timeline = page.locator('[data-message-scroller]');
  await expect
    .poll(
      async () => {
        await timeline.evaluate((el) => (el.scrollTop = 0));
        return timeline
          .getByText('after image 0, line 0', { exact: true })
          .count();
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
  });
  await expectImagesInViewLoaded(page);
}

/**
 * Fling from the newest message to the oldest, one step per frame, and count the image
 * rows that mounted and the images that appeared while it moved.
 */
async function fling(page: Page): Promise<{ mounted: number; shown: number }> {
  return page.locator('[data-message-scroller]').evaluate(async (el, step) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    let mounted = 0;
    let shown = 0;
    const count = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          const all = (selector: string) =>
            (node.matches(selector) ? 1 : 0) +
            node.querySelectorAll(selector).length;
          mounted += all('trn-media-attachment');
          shown += all('img.media__img');
        }
      }
    };
    // Start from rest: well past the list's 150 ms idle window.
    await new Promise((r) => setTimeout(r, 500));
    const observer = new MutationObserver(count);
    observer.observe(el, { childList: true, subtree: true });
    while (el.scrollTop > 0) {
      el.scrollTop = Math.max(0, el.scrollTop - step);
      await frame();
    }
    // Let the last frame's rows render, still well inside the idle window.
    await frame();
    count(observer.takeRecords());
    observer.disconnect();
    return { mounted, shown };
  }, FLING_STEP_PX);
}

/** Every image row on screen shows its decoded image. */
async function expectImagesInViewLoaded(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.locator('[data-message-scroller]').evaluate((el) => {
          const view = el.getBoundingClientRect();
          const rows = Array.from(
            el.querySelectorAll('trn-media-attachment'),
          ).filter((row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > view.top && box.top < view.bottom;
          });
          const loaded = rows.filter((row) => {
            const img = row.querySelector<HTMLImageElement>('img.media__img');
            return !!img && img.complete && img.naturalWidth > 0;
          });
          return rows.length > 0 && loaded.length === rows.length;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
}

test.describe('Images in a fast-scrolled timeline', () => {
  test.skip(!session.available, 'needs a Matrix homeserver');

  test('with "Load images after fast scrolling" on, images wait for the fling to settle', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}on`;
    const seeded = await seedImageRoom(request, session.hs as string, runId);
    await seedPreference(page, FLAG_KEY, 'true');
    await login(page, seeded.credentials);
    await openRoom(page, seeded.roomName);
    await loadEveryImage(page);

    const { mounted, shown } = await fling(page);

    // The fling passed most of the room's image rows, and they stayed placeholders.
    expect(mounted).toBeGreaterThanOrEqual(IMAGES / 2);
    expect(shown).toBeLessThanOrEqual(mounted / 4);
    // Once it settles, the images on screen load.
    await expectImagesInViewLoaded(page);
  });

  test('with the flag off, every image row shows its image as it passes', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}off`;
    const seeded = await seedImageRoom(request, session.hs as string, runId);
    await login(page, seeded.credentials);
    await openRoom(page, seeded.roomName);
    await loadEveryImage(page);

    const { mounted, shown } = await fling(page);

    expect(mounted).toBeGreaterThanOrEqual(IMAGES / 2);
    expect(shown).toBeGreaterThanOrEqual((mounted * 3) / 4);
    await expectImagesInViewLoaded(page);
  });
});
