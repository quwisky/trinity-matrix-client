import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { cdpSwipe } from '../../../support/touch-platform.mts';
import { createRoom } from '../../support/space-journey.mts';

// The image viewer on a phone: a tap shows and hides the controls, a swipe down dismisses,
// a double tap zooms. Real touch goes through CDP so the browser's own touch-action and
// click synthesis apply. Needs Synapse (Docker).
const session = homeserverSession();
const FILENAME = 'viewer-gestures.png';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function openViewer(
  page: Page,
  request: Parameters<Parameters<typeof test>[2]>[0]['request'],
) {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}vg`;
  const user = `viewer-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Viewer ${runId}`;
  await registerUser(request, user, pass);
  const { access_token: token } = (await (
    await request.post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
  ).json()) as { access_token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const roomId = await createRoom(
    request,
    hs,
    { accessToken: token },
    roomName,
  );
  const { content_uri: mxc } = (await (
    await request.post(
      `${hs}/_matrix/media/v3/upload?filename=${encodeURIComponent(FILENAME)}`,
      { headers: { ...headers, 'Content-Type': 'image/png' }, data: PNG_1X1 },
    )
  ).json()) as { content_uri: string };
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}`,
    {
      headers,
      data: {
        msgtype: 'm.image',
        body: FILENAME,
        url: mxc,
        info: { mimetype: 'image/png', size: PNG_1X1.length, w: 1, h: 1 },
      },
    },
  );
  await login(page, { available: true, hs, user, pass } as HomeserverSession);
  await openRoom(page, roomName);
  await page.getByRole('button', { name: `Open image ${FILENAME}` }).click();
  const dialog = page.getByRole('dialog', { name: FILENAME });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

async function cdpTap(page: Page, x: number, y: number, times = 1) {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let i = 0; i < times; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    }
  } finally {
    await cdp.detach();
  }
}

const imageScale = (page: Page) =>
  page.locator('img.lightbox__image').evaluate((img) => {
    const m = getComputedStyle(img).transform;
    return m === 'none' ? 1 : Number(m.slice(7).split(',')[0]);
  });

test.describe('Image viewer on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('a tap toggles the controls and does not close', async ({
    page,
    request,
  }) => {
    const dialog = await openViewer(page, request);
    const close = page.getByTestId('lightbox-close');
    await expect(close).toBeVisible();
    await cdpTap(page, 195, 422);
    await expect(close).toBeHidden();
    await expect(dialog).toBeVisible();
    await cdpTap(page, 195, 422);
    await expect(close).toBeVisible();
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(dialog).toBeHidden();
  });

  test('a swipe down past the threshold dismisses', async ({
    page,
    request,
  }) => {
    const dialog = await openViewer(page, request);
    await cdpSwipe(page, { x: 195, y: 300 }, { x: 195, y: 600 });
    await expect(dialog).toBeHidden();
  });

  test('a small swipe springs back', async ({ page, request }) => {
    const dialog = await openViewer(page, request);
    await cdpSwipe(page, { x: 195, y: 300 }, { x: 195, y: 340 });
    await page.waitForTimeout(500);
    await expect(dialog).toBeVisible();
    expect(
      await page
        .locator('img.lightbox__image')
        .evaluate((img) => getComputedStyle(img).transform),
    ).toMatch(/^none$|^matrix\(1, 0, 0, 1, 0, 0\)$/);
  });

  test('a double tap zooms in and back out, and a zoomed swipe does not dismiss', async ({
    page,
    request,
  }) => {
    const dialog = await openViewer(page, request);
    await cdpTap(page, 195, 422, 2);
    await expect.poll(() => imageScale(page)).toBeGreaterThan(1.5);
    await cdpSwipe(page, { x: 195, y: 300 }, { x: 195, y: 600 });
    await page.waitForTimeout(500);
    await expect(dialog).toBeVisible();
    await cdpTap(page, 195, 422, 2);
    await expect.poll(() => imageScale(page)).toBe(1);
  });
});

test.describe('Image viewer on a desktop', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a click outside the image still closes it', async ({
    page,
    request,
  }) => {
    const dialog = await openViewer(page, request);
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeHidden();
  });
});
