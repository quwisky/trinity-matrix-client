import {
  devices,
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { captureScreenshot } from '../../../support/screenshot.mts';

// Covers the rendered thread summary on a real timeline: keyboard activation on desktop,
// touch activation on a Pixel 5, and the long-preview layout in the browser engine.
// Needs a Synapse homeserver (Docker) and self-skips when it is unavailable.
const session = synapseSession();
const { defaultBrowserType: pixel5BrowserType, ...pixel5 } = devices['Pixel 5'];
void pixel5BrowserType;
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

interface SeededThread {
  reader: SynapseSession;
  roomName: string;
  rootBody: string;
  latestBody: string;
  latestPrefix: string;
  authorName: string;
  imageRootBody?: string;
  imageFilename?: string;
  imageLatestBody?: string;
}

interface SeedThreadOptions {
  authorName?: string;
  rootBody?: string;
  latestBody?: string;
  includeImageRoot?: boolean;
  imageLatestBody?: string;
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((response) => response.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

async function sendMessage(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  user: ApiUser,
  transactionId: string,
  body: string,
  rootEventId?: string,
): Promise<string> {
  const content: Record<string, unknown> = { msgtype: 'm.text', body };
  if (rootEventId) {
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: rootEventId,
      'm.in_reply_to': { event_id: rootEventId },
    };
  }
  return request
    .put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
      { headers: user.headers, data: content },
    )
    .then((response) => response.json())
    .then((json) => json.event_id as string);
}

async function seedThread(
  request: APIRequestContext,
  runId: string,
  options: SeedThreadOptions = {},
): Promise<SeededThread> {
  const hs = session.hs as string;
  const readerUser = `thread-preview-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  const authorUser = `thread-preview-author-${runId}`;
  const authorPass = `${authorUser}-pass`;
  const roomName = `Thread preview ${runId.slice(-8)}`;
  const authorName =
    options.authorName ?? 'Preview Author With An Unusually Long Display Name';
  const rootBody = options.rootBody ?? 'Thread root message';
  const latestBody =
    options.latestBody ?? `Latest reply ${'long preview text '.repeat(24)}`;
  const latestPrefix = latestBody.slice(0, 32);

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, authorUser, authorPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const author = await apiLogin(request, hs, authorUser, authorPass);
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(author.userId)}/displayname`,
    { headers: author.headers, data: { displayname: authorName } },
  );

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName, invite: [author.userId], preset: 'private_chat' },
    })
    .then((response) => response.json())
    .then((json) => json.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: author.headers },
  );

  const seedRoot = async (
    root: string,
    rootTransactionId: string,
    replyPrefix: string,
    image = false,
  ): Promise<void> => {
    let rootEventId: string;
    if (image) {
      const upload = await request.post(
        `${hs}/_matrix/media/v3/upload?filename=short-root.png`,
        {
          headers: { ...reader.headers, 'Content-Type': 'image/png' },
          data: PNG_1X1,
        },
      );
      const { content_uri: mxc } = (await upload.json()) as {
        content_uri: string;
      };
      rootEventId = await request
        .put(
          `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${rootTransactionId}`,
          {
            headers: reader.headers,
            data: {
              msgtype: 'm.image',
              body: 'short-root.png',
              url: mxc,
              info: {
                mimetype: 'image/png',
                size: PNG_1X1.length,
                w: 320,
                h: 480,
              },
            },
          },
        )
        .then((response) => response.json())
        .then((json) => json.event_id as string);
    } else {
      rootEventId = await sendMessage(
        request,
        hs,
        roomId,
        reader,
        rootTransactionId,
        root,
      );
    }
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      {
        headers: reader.headers,
        data: { 'm.fully_read': rootEventId, 'm.read': rootEventId },
      },
    );
    await sendMessage(
      request,
      hs,
      roomId,
      author,
      `${replyPrefix}-1`,
      'first reply',
      rootEventId,
    );
    await sendMessage(
      request,
      hs,
      roomId,
      author,
      `${replyPrefix}-2`,
      image ? (options.imageLatestBody ?? latestBody) : latestBody,
      rootEventId,
    );
  };

  await seedRoot(rootBody, `${runId}-root`, `${runId}-reply`);
  const imageRootBody = options.includeImageRoot ? 'short-root.png' : undefined;
  if (imageRootBody) {
    await seedRoot(
      imageRootBody,
      `${runId}-image-root`,
      `${runId}-image-reply`,
      true,
    );
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    rootBody,
    latestBody,
    latestPrefix,
    authorName,
    imageRootBody,
    imageFilename: imageRootBody ? 'short-root.png' : undefined,
    imageLatestBody: options.imageLatestBody,
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });
}

async function assertPreview(
  page: Page,
  seeded: SeededThread,
): Promise<Locator> {
  const root = page
    .locator('.scroll .msg', { hasText: seeded.rootBody })
    .first();
  await expect(root).toBeVisible({ timeout: 20_000 });
  const summary = root.getByTestId('message-thread-summary');
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await expect(summary).toContainText('2 replies');
  await expect(summary).toContainText(seeded.authorName);
  await expect(summary.locator('.msg__thread-preview')).toContainText(
    seeded.latestPrefix,
  );
  const previewText = summary.locator('.msg__thread-text');
  const previewAuthor = summary.locator('.msg__thread-author');
  await expect(previewText).toBeVisible();
  await expect(previewAuthor).toBeVisible();
  await expect(summary.locator('.msg__thread-time')).toHaveText(
    /just now|ago|minute|hour|day/u,
  );
  await expect(previewText).toHaveCSS('white-space', 'nowrap');
  await expect(previewText).toHaveCSS('overflow', 'hidden');
  await expect(previewText).toHaveCSS('text-overflow', 'ellipsis');
  await expect(summary.locator('.msg__thread-badge')).toContainText('2');

  const measurements = await summary.evaluate((element) => {
    const button = element as HTMLElement;
    const preview = element.querySelector<HTMLElement>('.msg__thread-preview');
    const previewText = element.querySelector<HTMLElement>('.msg__thread-text');
    const previewAuthor = element.querySelector<HTMLElement>(
      '.msg__thread-author',
    );
    if (!preview || !previewText || !previewAuthor) {
      throw new Error('thread preview content is missing');
    }
    const avatar = element.closest('.msg')?.querySelector('.msg__avatar');
    if (!avatar) throw new Error('thread root avatar is missing');
    const avatarBox = avatar.getBoundingClientRect();
    const connector = getComputedStyle(element, '::before');
    const previewBox = preview.getBoundingClientRect();
    const textBox = previewText.getBoundingClientRect();
    return {
      button: button.getBoundingClientRect(),
      preview: previewBox,
      previewAuthor: previewAuthor.getBoundingClientRect(),
      authorAllowance: button.parentElement!.clientWidth * 0.4,
      previewText: textBox,
      previewFitsContainer:
        previewBox.left >= button.getBoundingClientRect().left &&
        previewBox.right <= button.getBoundingClientRect().right + 1,
      textFitsPreview:
        textBox.left >= previewBox.left &&
        textBox.right <= previewBox.right + 1,
      isTruncated: previewText.scrollWidth > previewText.clientWidth,
      connectorCenter:
        button.getBoundingClientRect().left +
        Number.parseFloat(connector.left) +
        Number.parseFloat(connector.borderLeftWidth) / 2,
      avatarCenter: avatarBox.left + avatarBox.width / 2,
      connectorContent: connector.content,
      connectorWidth: Number.parseFloat(connector.width) || 0,
      connectorBorder: Number.parseFloat(connector.borderLeftWidth) || 0,
    };
  });
  expect(measurements.previewFitsContainer).toBe(true);
  expect(measurements.textFitsPreview).toBe(true);
  expect(measurements.isTruncated).toBe(true);
  expect(measurements.previewText.width).toBeGreaterThan(0);
  expect(
    measurements.previewAuthor.width / measurements.preview.width,
  ).toBeGreaterThanOrEqual(0.3);
  expect(measurements.previewAuthor.width).toBeLessThanOrEqual(
    measurements.authorAllowance + 1,
  );
  expect(
    Math.abs(measurements.connectorCenter - measurements.avatarCenter),
  ).toBeLessThanOrEqual(0.5);
  expect(measurements.connectorContent).not.toBe('none');
  expect(
    measurements.connectorWidth + measurements.connectorBorder,
  ).toBeGreaterThan(0);
  return summary;
}

async function assertShortPreviewLayout(
  page: Page,
  seeded: SeededThread,
  image = false,
): Promise<Locator> {
  if (image) {
    const imageRoot = page
      .locator('.scroll .msg', { has: page.getByTestId('media-bubble') })
      .first();
    const bubble = imageRoot.getByTestId('media-bubble');
    await expect(bubble).toHaveAttribute('data-media-state', 'ready', {
      timeout: 30_000,
    });
    const rendered = bubble.locator(`img[alt="${seeded.imageFilename}"]`);
    await expect(rendered).toBeVisible();
    await expect
      .poll(() =>
        rendered.evaluate(
          (element) => (element as HTMLImageElement).naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
  }
  const root = image
    ? page
        .locator('.scroll .msg', { has: page.getByTestId('media-bubble') })
        .first()
    : page.locator('.scroll .msg', { hasText: seeded.rootBody }).first();
  await expect(root).toBeVisible({ timeout: 20_000 });
  const summary = root.getByTestId('message-thread-summary');
  await expect(summary).toContainText('2 replies');
  await expect(summary).toContainText(seeded.authorName);
  await expect(summary).toContainText(
    image ? (seeded.imageLatestBody ?? seeded.latestBody) : seeded.latestBody,
  );
  const geometry = await summary.evaluate((element) => {
    const summaryBox = element.getBoundingClientRect();
    const body = element
      .closest('.msg')
      ?.querySelector<HTMLElement>('.msg__body');
    const avatar = element
      .closest('.msg')
      ?.querySelector<HTMLElement>('.msg__avatar, .msg__gutter');
    if (!body || !avatar)
      throw new Error('short preview geometry target missing');
    const bodyBox = body.getBoundingClientRect();
    const avatarBox = avatar.getBoundingClientRect();
    const connector = getComputedStyle(element, '::before');
    return {
      summary: summaryBox,
      body: bodyBox,
      avatar: avatarBox,
      connectorCenter:
        summaryBox.left +
        Number.parseFloat(connector.left) +
        Number.parseFloat(connector.borderLeftWidth) / 2,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(geometry.summary.top).toBeGreaterThanOrEqual(geometry.body.bottom - 1);
  expect(
    Math.abs(geometry.summary.left - geometry.body.left),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      geometry.connectorCenter -
        (geometry.avatar.left + geometry.avatar.width / 2),
    ),
  ).toBeLessThanOrEqual(0.5);
  expect(geometry.summary.right).toBeLessThanOrEqual(
    geometry.viewportWidth + 1,
  );
  return summary;
}

test.describe('Thread preview', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('opens the long thread preview from the keyboard on desktop', async ({
    page,
    request,
  }) => {
    const seeded = await seedThread(request, `${testResourceId('run')}desk`);
    await login(page, seeded.reader);
    await openRoom(page, seeded.roomName);
    const summary = await assertPreview(page, seeded);
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-density', 'compact'),
    );
    await assertPreview(page, seeded);
    await page.evaluate(() =>
      document.documentElement.removeAttribute('data-density'),
    );
    const testInfo = test.info();
    const screenshotPath = testInfo.outputPath('thread-preview-desktop.png');
    await captureScreenshot(page, () =>
      page.screenshot({ path: screenshotPath }),
    );
    await testInfo.attach('thread-preview-desktop', {
      path: screenshotPath,
      contentType: 'image/png',
    });

    await summary.focus();
    await expect(summary).toBeFocused();
    await summary.press('Enter');
    await expect(page.getByTestId('thread-view')).toBeVisible({
      timeout: 15_000,
    });
  });

  test.describe('Pixel 5', () => {
    test.use(pixel5);

    test('opens the long thread preview by touch and keeps the target touch-sized', async ({
      page,
      request,
      touchPlatform,
    }) => {
      const seeded = await seedThread(request, `${testResourceId('run')}phone`);
      await login(page, seeded.reader);
      await openRoom(page, seeded.roomName);
      const summary = await assertPreview(page, seeded);
      const testInfo = test.info();
      const screenshotPath = testInfo.outputPath('thread-preview-mobile.png');
      await captureScreenshot(page, () =>
        page.screenshot({ path: screenshotPath }),
      );
      await testInfo.attach('thread-preview-mobile', {
        path: screenshotPath,
        contentType: 'image/png',
      });

      const box = await summary.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await touchPlatform.tap(page, summary);
      await expect(page.getByTestId('thread-view')).toBeVisible({
        timeout: 15_000,
      });
    });
  });

  for (const mobile of [false, true]) {
    test.describe(
      mobile ? 'short previews on Pixel 5' : 'short previews on desktop',
      () => {
        if (mobile) test.use(pixel5);

        test(`keeps short text and image previews below their roots`, async ({
          page,
          request,
          touchPlatform,
        }, testInfo) => {
          await page.emulateMedia({ colorScheme: mobile ? 'dark' : 'light' });
          const seeded = await seedThread(
            request,
            `${testResourceId('run')}${mobile ? 'shortphone' : 'shortdesk'}`,
            {
              authorName: 'Quwisky Example',
              rootBody: 'Short text root',
              latestBody: 'OK',
              includeImageRoot: true,
              imageLatestBody:
                'A longer reply makes the preview wider but must not change the username allowance.',
            },
          );
          await login(page, seeded.reader);
          await openRoom(page, seeded.roomName);
          const textSummary = await assertShortPreviewLayout(page, seeded);
          const imageSummary = await assertShortPreviewLayout(
            page,
            seeded,
            true,
          );
          const authorWidth = (summary: Locator) =>
            summary
              .locator('.msg__thread-author')
              .evaluate((element) => element.getBoundingClientRect().width);
          expect(
            Math.abs(
              (await authorWidth(textSummary)) -
                (await authorWidth(imageSummary)),
            ),
          ).toBeLessThanOrEqual(1);
          const colors = await textSummary.evaluate((element) => ({
            connector: getComputedStyle(element, '::before').borderBottomColor,
            replyToken: getComputedStyle(
              element.querySelector('.msg__thread-time')!,
            ).color,
          }));
          expect(colors.connector).toBe(colors.replyToken);
          await textSummary.scrollIntoViewIfNeeded();
          const textProofPath = testInfo.outputPath(
            `thread-preview-short-text-${mobile ? 'mobile' : 'desktop'}.png`,
          );
          await captureScreenshot(page, () =>
            textSummary
              .locator('xpath=ancestor::div[contains(@class, "msg")][1]')
              .screenshot({ path: textProofPath }),
          );
          await testInfo.attach(
            `thread-preview-short-text-${mobile ? 'mobile' : 'desktop'}`,
            { path: textProofPath, contentType: 'image/png' },
          );
          const screenshotPath = testInfo.outputPath(
            `thread-preview-short-${mobile ? 'mobile' : 'desktop'}.png`,
          );
          await captureScreenshot(page, () =>
            page.screenshot({ path: screenshotPath }),
          );
          await testInfo.attach(
            `thread-preview-short-${mobile ? 'mobile' : 'desktop'}`,
            {
              path: screenshotPath,
              contentType: 'image/png',
            },
          );
          if (mobile) {
            await touchPlatform.tap(page, textSummary);
          } else {
            await textSummary.focus();
            await textSummary.press('Enter');
          }
          await expect(page.getByTestId('thread-view')).toBeVisible({
            timeout: 15_000,
          });
        });
      },
    );
  }
});
