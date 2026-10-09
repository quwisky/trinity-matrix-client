import { testResourceId, expect, test, type Page } from './fixtures.mts';

import { login, homeserverSession, type Navigate } from '../support/app.mts';
import { passwordLogin, registerUser } from '../support/account.mts';
import { launchApp } from './support/launch.mts';

const session = homeserverSession();
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** BACKGROUND_RELEASE_DELAY_MS (60 s) plus slack for a loaded machine. */
const RELEASE_WAIT_MS = 90_000;

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const room = page.locator('.channel', { hasText: roomName }).first();
  await room.waitFor({ state: 'visible', timeout: 30_000 });
  await room.click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });
}

/** Wait for an image to render and return its object URL. */
async function readyImageSrc(page: Page, alt: string): Promise<string> {
  const image = page.locator(`img[alt="${alt}"]`).first();
  await expect
    .poll(
      () =>
        image.evaluate(
          (element: HTMLImageElement) =>
            element.complete && element.naturalWidth > 0,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  return (await image.getAttribute('src')) as string;
}

/** Whether an object URL still loads; CSP leaves `blob:` to images, not to fetch. */
const blobReadable = (page: Page, url: string) =>
  page.evaluate(
    (src) =>
      new Promise<boolean>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = src;
      }),
    url,
  );

test.describe('Electron memory release while hidden', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('frees off-screen avatars while hidden and still renders the focused room', async ({
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = testResourceId('run');
    const signUp = async (name: string) => {
      await registerUser(request, name, `${name}-pass`);
      const signedIn = await passwordLogin(request, hs, name, `${name}-pass`);
      return {
        ...signedIn,
        headers: { Authorization: `Bearer ${signedIn.accessToken}` },
      };
    };
    const user = `hidden-release-${runId}`;
    const pass = `${user}-pass`;
    const me = await signUp(user);
    const visitor = await signUp(`hidden-visitor-${runId}`);
    const visitorName = `Visitor ${runId}`;

    const upload = async (filename: string): Promise<string> => {
      const response = await request.post(
        `${hs}/_matrix/media/v3/upload?filename=${filename}`,
        {
          headers: { ...me.headers, 'Content-Type': 'image/png' },
          data: PNG_1X1,
        },
      );
      expect(response.ok()).toBe(true);
      return ((await response.json()) as { content_uri: string }).content_uri;
    };
    const visitorProfile = `${hs}/_matrix/client/v3/profile/${encodeURIComponent(visitor.userId)}`;
    for (const [field, value] of [
      ['displayname', visitorName],
      ['avatar_url', await upload('visitor.png')],
    ]) {
      const response = await request.put(`${visitorProfile}/${field}`, {
        headers: visitor.headers,
        data: { [field]: value },
      });
      expect(response.ok()).toBe(true);
    }
    const createRoom = async (name: string, invite: string[] = []) => {
      const response = await request.post(
        `${hs}/_matrix/client/v3/createRoom`,
        {
          headers: me.headers,
          data: { name, invite },
        },
      );
      expect(response.ok()).toBe(true);
      return ((await response.json()) as { room_id: string }).room_id;
    };
    const send = async (
      account: typeof me,
      roomId: string,
      content: Record<string, unknown>,
    ) => {
      const response = await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${Math.random()}`,
        { headers: account.headers, data: content },
      );
      expect(response.ok()).toBe(true);
    };

    // The left room is the only place the visitor's avatar is shown.
    const rooms = { focused: `Shown ${runId}`, left: `Left ${runId}` };
    const leftRoom = await createRoom(rooms.left, [visitor.userId]);
    const joined = await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(leftRoom)}/join`,
      { headers: visitor.headers, data: {} },
    );
    expect(joined.ok()).toBe(true);
    await send(visitor, leftRoom, { msgtype: 'm.text', body: 'hello' });
    await send(me, await createRoom(rooms.focused), {
      msgtype: 'm.image',
      body: 'focused.png',
      url: await upload('focused.png'),
      info: { mimetype: 'image/png', size: PNG_1X1.length, w: 1, h: 1 },
    });

    const app = await launchApp();
    try {
      const page = await app.firstWindow();
      await login(page, { available: true, hs, user, pass }, electronNavigate);
      await openRoom(page, rooms.left);
      const offScreen = await readyImageSrc(page, visitorName);
      await openRoom(page, rooms.focused);
      const shown = await readyImageSrc(page, 'focused.png');
      // Off screen but still cached until the app is hidden long enough.
      expect(await blobReadable(page, offScreen)).toBe(true);

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.hide(),
      );
      // The release is timer-driven, so this waits in real time.
      await expect
        .poll(() => blobReadable(page, offScreen), {
          timeout: RELEASE_WAIT_MS,
          intervals: [5_000],
        })
        .toBe(false);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.show(),
      );

      // The focused room kept its on-screen media and avatars: nothing is broken.
      expect(await readyImageSrc(page, 'focused.png')).toBe(shown);
      expect(await blobReadable(page, shown)).toBe(true);
      const brokenBlobImages = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')]
          .filter((image) => !image.complete || image.naturalWidth === 0)
          .map((image) => image.alt || image.src),
      );
      expect(brokenBlobImages).toEqual([]);

      // The left room reopens cold and fetches the released avatar again.
      await openRoom(page, rooms.left);
      expect(await readyImageSrc(page, visitorName)).not.toBe(offScreen);
    } finally {
      await app.close();
    }
  });
});
