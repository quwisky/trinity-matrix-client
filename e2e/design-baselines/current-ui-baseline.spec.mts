import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../playwright/support/app.mts';
import {
  passwordLogin,
  registerUser,
  type AccountSession,
} from '../playwright/support/account.mts';

const session = synapseSession();
const captureRoot = resolve(
  import.meta.dirname,
  '../../dist/.playwright/current-baselines/captures',
);

const MAIN_ROOM = 'design-systems-and-accessibility-review';
const MAIN_MESSAGES = [
  'I updated the focus treatment so keyboard and selected states stay distinct.',
  'Thanks. I am comparing the light, dark and Onyx palettes side by side.',
  'The compact layout keeps the composer reachable without hiding the timeline.',
  'I checked the unread badge against both short and very long room names.',
  'Can we preserve the dense information hierarchy without making it feel cramped?',
  'Yes. The next pass increases separation between navigation and conversation content.',
  'The phone layout still needs comfortable targets around the header actions.',
  'I verified the back button and send button remain at least forty-four pixels square.',
  'The settings view now has evidence at the compact height that exposed the old scroll bug.',
  'Great. Please keep keyboard focus visible independently from selected navigation state.',
  'The prototype also keeps errors and empty states visually quieter than primary content.',
  'That should help the active conversation remain the strongest region on screen.',
  'I am documenting the exact viewport and browser versions with every capture.',
  'The current application baseline is ready for review.',
] as const;

interface ApiUser extends AccountSession {
  headers: { Authorization: string };
}

function apiUser(account: AccountSession): ApiUser {
  return {
    ...account,
    headers: { Authorization: `Bearer ${account.accessToken}` },
  };
}

async function requireOk(
  response: Awaited<ReturnType<APIRequestContext['post']>>,
  operation: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${operation} returned ${response.status()}: ${await response.text()}`,
    );
  }
}

async function setDisplayName(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  displayName: string,
): Promise<void> {
  const response = await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(user.userId)}/displayname`,
    { headers: user.headers, data: { displayname: displayName } },
  );
  await requireOk(response, `set display name for ${user.userId}`);
}

async function createSeededRoom(
  request: APIRequestContext,
  hs: string,
  reader: ApiUser,
  sender: ApiUser,
  slug: string,
  name: string,
  messages: readonly string[],
  mentionReader = false,
  alternateAuthors = false,
): Promise<string> {
  const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: reader.headers,
    data: {
      name,
      preset: 'private_chat',
      room_alias_name: `baseline-${slug}`,
      topic: 'Deterministic Phase 0 current-interface evidence',
      invite: [sender.userId],
    },
  });
  await requireOk(created, `create room ${name}`);
  const roomId = ((await created.json()) as { room_id: string }).room_id;

  const joined = await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: sender.headers },
  );
  await requireOk(joined, `join sender to ${name}`);

  for (const [index, body] of messages.entries()) {
    const author = alternateAuthors && index % 2 === 1 ? reader : sender;
    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${slug}-${index}`,
      {
        headers: author.headers,
        data: {
          msgtype: 'm.text',
          body,
          ...(mentionReader && index === messages.length - 1
            ? { 'm.mentions': { user_ids: [reader.userId] } }
            : {}),
        },
      },
    );
    await requireOk(sent, `send message ${index} to ${name}`);
  }

  return roomId;
}

async function seedAccount(
  request: APIRequestContext,
  projectName: string,
): Promise<SynapseSession> {
  const hs = session.hs as string;
  const suffix = projectName.replaceAll(/[^a-z0-9]+/g, '-');
  const readerName = `baseline-reader-${suffix}`;
  const readerPass = `baseline-reader-${suffix}-pass`;
  const senderName = `baseline-sender-${suffix}`;
  const senderPass = `baseline-sender-${suffix}-pass`;

  await registerUser(request, readerName, readerPass);
  await registerUser(request, senderName, senderPass);
  const reader = apiUser(
    await passwordLogin(request, hs, readerName, readerPass),
  );
  const sender = apiUser(
    await passwordLogin(request, hs, senderName, senderPass),
  );
  await setDisplayName(request, hs, reader, 'quwisky baseline');
  await setDisplayName(request, hs, sender, 'Mira Okafor');

  await createSeededRoom(
    request,
    hs,
    reader,
    sender,
    `${suffix}-engineering`,
    'engineering',
    ['Android, Web and Electron checks are green.'],
  );
  await createSeededRoom(
    request,
    hs,
    reader,
    sender,
    `${suffix}-release`,
    'release-planning-for-multiple-platforms',
    ['Please review the long-name compact layout.'],
    true,
  );
  await createSeededRoom(
    request,
    hs,
    reader,
    sender,
    `${suffix}-main`,
    MAIN_ROOM,
    MAIN_MESSAGES,
    false,
    true,
  );

  return {
    available: true,
    hs,
    user: readerName,
    pass: readerPass,
  };
}

async function assertInsideViewport(
  page: Page,
  target: Locator,
  label: string,
): Promise<void> {
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} has a layout box`).not.toBeNull();
  expect(viewport, 'project has a viewport').not.toBeNull();
  expect(
    box!.x,
    `${label} begins horizontally in viewport`,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    box!.x + box!.width,
    `${label} ends horizontally in viewport`,
  ).toBeLessThanOrEqual(viewport!.width + 1);
  expect(
    box!.y,
    `${label} begins vertically in viewport`,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    box!.y + box!.height,
    `${label} ends vertically in viewport`,
  ).toBeLessThanOrEqual(viewport!.height + 1);
}

async function prepareEvidence(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const image of document.querySelectorAll('img')) {
      if (!image.complete) {
        await new Promise<void>((done) => {
          image.addEventListener('load', () => done(), { once: true });
          image.addEventListener('error', () => done(), { once: true });
        });
      }
    }
    document.getSelection()?.removeAllRanges();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    for (const time of document.querySelectorAll('.msg__gutter, .msg__time')) {
      time.textContent = '09:41';
    }
    const build = document.querySelector('[data-testid="settings-build"]');
    if (build) build.textContent = 'Trinity current baseline';
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
    'document has no horizontal overflow',
  ).toBeLessThanOrEqual(1);
}

async function capture(
  page: Page,
  surface: string,
  testInfo: TestInfo,
): Promise<void> {
  await prepareEvidence(page);
  mkdirSync(captureRoot, { recursive: true });
  const filename = `${surface}-${testInfo.project.name}-linux.png`;
  const path = join(captureRoot, filename);
  await page.screenshot({
    path,
    animations: 'disabled',
    caret: 'hide',
    fullPage: false,
  });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test.describe('Phase 0 current application evidence', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('captures a deterministic safe journey', async ({
    page,
    request,
  }, testInfo) => {
    const credentials = await seedAccount(request, testInfo.project.name);
    const phone = testInfo.project.name === 'phone-pixel-5';

    await test.step('signed-out login', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await expect(
        page.getByLabel('Homeserver', { exact: true }),
      ).toBeVisible();
      await page
        .getByLabel('Homeserver', { exact: true })
        .fill(credentials.hs!);
      await page.getByText('Continue', { exact: true }).click();
      await expect(page.getByLabel('Username', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await assertInsideViewport(
        page,
        page.locator('trn-auth-card'),
        'login card',
      );
      await capture(page, 'login', testInfo);
    });

    await test.step('room shell', async () => {
      await login(page, credentials);
      const room = page.locator('.channel', { hasText: MAIN_ROOM }).first();
      await expect(room).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.channel__badge').first()).toBeVisible({
        timeout: 30_000,
      });
      await room.click();
      await expect(
        page
          .locator('.main .msg__text')
          .filter({ hasText: MAIN_MESSAGES[2] })
          .last(),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('.main .msg__author')).toHaveCount(
        MAIN_MESSAGES.length,
      );
      await expect(page.getByTestId('composer-input')).toHaveAccessibleName(
        new RegExp(MAIN_ROOM),
      );
      await expect(
        page.getByRole('heading', { name: MAIN_ROOM }),
      ).toBeVisible();
      await assertInsideViewport(
        page,
        page.locator('.rooms-shell'),
        'room shell',
      );
      await assertInsideViewport(
        page,
        page.getByTestId('composer-field'),
        'message composer',
      );
      if (phone) {
        for (const target of [
          page.getByTestId('back-to-rooms'),
          page.getByTestId('composer-send'),
        ]) {
          const box = await target.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
      }
      await capture(page, 'room-shell', testInfo);
    });

    await test.step('appearance settings', async () => {
      await page.goto('/settings/appearance', {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('settings-detail')).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.getByRole('heading', { name: 'Appearance' }),
      ).toBeVisible();
      await expect(page.getByTestId('text-scale-select')).toHaveAccessibleName(
        'Text size',
      );
      await expect(page.getByTestId('palette-select')).toHaveAccessibleName(
        'Palette',
      );
      const settingsNavigation = page.getByRole('navigation', {
        name: 'Settings sections',
      });
      if (phone) {
        await expect(settingsNavigation).toBeHidden();
      } else {
        await expect(settingsNavigation).toBeVisible();
      }
      await assertInsideViewport(
        page,
        page.locator('trn-settings'),
        'settings workspace',
      );
      await capture(page, 'appearance-settings', testInfo);
    });

    await test.step('safe encryption setup introduction', async () => {
      await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
      await expect(
        page.getByRole('heading', { name: 'Set up encryption' }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByRole('heading', { name: 'Secure your messages' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Set up encryption' }),
      ).toBeVisible();
      await expect(page.getByTestId('recovery-key')).toHaveCount(0);
      await assertInsideViewport(
        page,
        page.locator('trn-encryption-setup'),
        'encryption setup',
      );
      await capture(page, 'encryption-setup', testInfo);
    });
  });
});
