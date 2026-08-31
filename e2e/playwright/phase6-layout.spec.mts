import type { APIResponse } from '@playwright/test';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from './support/fixtures.mts';
import {
  fillLabeledInput,
  isAndroidE2E,
  seedPreference,
  synapseSession,
  waitForRooms,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

const session = synapseSession();
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface SeededRoom {
  credentials: SynapseSession;
  roomName: string;
}

async function requireOk(
  response: APIResponse,
  operation: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${operation} returned ${response.status()}: ${await response.text()}`,
    );
  }
}

async function seedImageRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<SeededRoom> {
  const user = `phase6-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Phase 6 layout ${runId}`;
  await registerUser(request, user, pass);

  const loginResponse = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  await requireOk(loginResponse, 'log in seeded user');
  const login = (await loginResponse.json()) as { access_token: string };
  const headers = { Authorization: `Bearer ${login.access_token}` };

  const roomResponse = await request.post(
    `${hs}/_matrix/client/v3/createRoom`,
    { headers, data: { name: roomName, preset: 'private_chat' } },
  );
  await requireOk(roomResponse, 'create seeded room');
  const roomId = ((await roomResponse.json()) as { room_id: string }).room_id;

  const uploadResponse = await request.post(
    `${hs}/_matrix/media/v3/upload?filename=phase-6-lightbox.png`,
    {
      headers: { ...headers, 'Content-Type': 'image/png' },
      data: PNG_1X1,
    },
  );
  await requireOk(uploadResponse, 'upload lightbox image');
  const mxc = ((await uploadResponse.json()) as { content_uri: string })
    .content_uri;

  const sendResponse = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}`,
    {
      headers,
      data: {
        msgtype: 'm.image',
        body: 'phase-6-lightbox.png',
        url: mxc,
        info: { mimetype: 'image/png', size: PNG_1X1.length, w: 1, h: 1 },
      },
    },
  );
  await requireOk(sendResponse, 'send lightbox image');

  return {
    credentials: { available: true, hs, user, pass },
    roomName,
  };
}

async function signInFromPasswordStage(
  page: Page,
  credentials: SynapseSession,
): Promise<void> {
  await fillLabeledInput(page, 'Username', credentials.user as string);
  await fillLabeledInput(page, 'Password', credentials.pass as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForRooms(page);
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

async function expectNoHorizontalDocumentScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

async function expectInsideViewport(
  page: Page,
  target: Locator,
  label: string,
): Promise<void> {
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} has a layout box`).not.toBeNull();
  expect(viewport, 'page has a viewport').not.toBeNull();
  expect(box!.x, `${label} starts inside the viewport`).toBeGreaterThanOrEqual(
    -1,
  );
  expect(
    box!.x + box!.width,
    `${label} ends inside the viewport`,
  ).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y, `${label} starts inside the viewport`).toBeGreaterThanOrEqual(
    -1,
  );
  expect(
    box!.y + box!.height,
    `${label} ends inside the viewport`,
  ).toBeLessThanOrEqual(viewport!.height + 1);
}

test.describe('Phase 6 responsive surfaces', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.skip(
    isAndroidE2E,
    'browser-only viewport matrix; Android WebView has its own installed-package suite',
  );

  test('keeps auth, picker and crypto surfaces bounded with larger compact UI', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}layout`;
    const { credentials, roomName } = await seedImageRoom(
      request,
      session.hs as string,
      runId,
    );
    await seedPreference(page, 'trinity.text-scale', 'larger');
    await seedPreference(page, 'trinity.density', 'compact');

    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', credentials.hs as string);
    await page.getByText('Continue', { exact: true }).click();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('html')).toHaveAttribute(
      'data-density',
      'compact',
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).fontSize,
        ),
      )
      .toBe('20px');
    await expectNoHorizontalDocumentScroll(page);
    const authCard = page.locator('.login-card');
    const phoneCard = await authCard.boundingBox();
    expect(phoneCard).not.toBeNull();
    expect(phoneCard!.x).toBeGreaterThanOrEqual(-1);
    expect(phoneCard!.x + phoneCard!.width).toBeLessThanOrEqual(321);

    await page.setViewportSize({ width: 1280, height: 720 });
    await expectInsideViewport(page, authCard, 'desktop auth card');
    await expectNoHorizontalDocumentScroll(page);
    await signInFromPasswordStage(page, credentials);
    await openRoom(page, roomName);

    const emojiTrigger = page.getByRole('button', { name: 'Insert emoji' });
    await emojiTrigger.click();
    const picker = page.locator('trn-emoji-picker');
    await expect(picker).toBeVisible({ timeout: 20_000 });
    await expectInsideViewport(page, picker, 'desktop emoji picker');
    await expectNoHorizontalDocumentScroll(page);
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();

    // The wide shell deliberately starts with the member column open. Close it before
    // exercising the phone reflow so a desktop-only panel is not left covering the
    // composer while the media query transition settles.
    const members = page.getByTestId('toggle-members');
    await expect(members).toHaveAttribute('aria-pressed', 'true');
    await members.click();
    await expect(members).toHaveAttribute('aria-pressed', 'false');

    await page.setViewportSize({ width: 320, height: 568 });
    await emojiTrigger.click();
    await expect(picker).toBeVisible({ timeout: 20_000 });
    await expectInsideViewport(page, picker, 'phone emoji picker');
    await expectNoHorizontalDocumentScroll(page);
    await page.keyboard.press('Escape');

    await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: 'Secure your messages' }),
    ).toBeVisible({ timeout: 20_000 });
    await expectInsideViewport(
      page,
      page.locator('.crypto-surface'),
      'phone encryption surface',
    );
    await expectNoHorizontalDocumentScroll(page);

    await page.setViewportSize({ width: 1280, height: 720 });
    await expectInsideViewport(
      page,
      page.locator('.crypto-surface'),
      'desktop encryption surface',
    );
    await expectNoHorizontalDocumentScroll(page);
  });

  test('lightbox preserves keyboard, backdrop and focus behavior', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}lightbox`;
    const { credentials, roomName } = await seedImageRoom(
      request,
      session.hs as string,
      runId,
    );

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', credentials.hs as string);
    await page.getByText('Continue', { exact: true }).click();
    await signInFromPasswordStage(page, credentials);
    await openRoom(page, roomName);

    const source = page.getByRole('button', {
      name: 'Open image phase-6-lightbox.png',
    });
    await expect(source).toBeVisible({ timeout: 20_000 });
    await source.click();

    const dialog = page.getByRole('dialog', { name: 'phase-6-lightbox.png' });
    const close = page.getByTestId('lightbox-close');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(close).toBeVisible();
    await expectInsideViewport(page, dialog, 'lightbox dialog');
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(source).toBeFocused();

    await source.click();
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // The viewer itself fills the pane, so its padded surround is the usable backdrop.
    // Click outside the centred image rather than force-clicking through the full-screen
    // dialog to CDK's physically covered backdrop element.
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeHidden();
    await expect(source).toBeFocused();
  });
});
