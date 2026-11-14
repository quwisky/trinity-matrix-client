import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DESIGN_VIEWPORTS } from '../browser/support/design-viewports.mts';
import { setUpEncryption } from '../browser/support/encryption-journey.mts';
import { urlSegment } from '../browser/support/space-journey.mts';
import {
  homeserverSession,
  login,
  waitForRooms,
  webNavigate,
  type HomeserverSession,
} from '../support/app.mts';
import { e2eEndpoint } from '../support/playwright-config.mts';
import { seedScenes, type SceneAccount, type SceneData } from './seed.mts';

// The landing page's scenes, one file per scene × viewport × theme. Scenes open by URL and
// state is seeded through the API, so this script can drive older release builds too.

const workspaceRoot = resolve(import.meta.dirname, '../..');
const OUT = join(workspaceRoot, 'dist/site-shots');
const VIEWPORTS = { desktop: 'desktop-wide', phone: 'phone-pixel-5' } as const;
const SCENES = ['hero', 'accounts', 'encryption', 'chat'] as const;
const THEMES = ['dark', 'light'] as const;
// Message times change with every run; hide them rather than paint mask boxes over them.
const HIDE_CLOCK =
  'trn-message-time, .msg__thread-time { visibility: hidden !important; }';

type Scene = (typeof SCENES)[number];
type Viewport = keyof typeof VIEWPORTS;
type Theme = (typeof THEMES)[number];

const session = homeserverSession();
const shots: {
  scene: Scene;
  viewport: Viewport;
  theme: Theme;
  file: string;
}[] = [];
let data: SceneData;
let recoveryKey = '';

const asSession = (account: SceneAccount): HomeserverSession => ({
  available: true,
  hs: session.hs as string,
  user: account.user,
  pass: account.pass,
});

function roomUrl(roomId: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    account: data.alex.userId,
    space: urlSegment(data.spaceId),
    ...extra,
  });
  return `/rooms/${urlSegment(roomId)}?${query}`;
}

/** Open the scene and resolve the element whose presence means it has rendered. */
async function openScene(
  page: Page,
  scene: Scene,
  viewport: Viewport,
): Promise<Locator> {
  switch (scene) {
    case 'hero': {
      await page.goto(roomUrl(data.generalId));
      await expect(page.locator('.mx-maths .katex').first()).toBeVisible({
        timeout: 30_000,
      });
      return page.getByRole('main').getByText('Capped at thirty seconds');
    }
    case 'chat': {
      await page.goto(
        roomUrl(data.launchId, { panel: 'thread', root: data.threadRootId }),
      );
      const thread = page.getByTestId('thread-view');
      await expect(thread.getByText('we are good to go')).toBeVisible({
        timeout: 30_000,
      });
      return thread;
    }
    case 'accounts': {
      // The phone shows the room list, where its account bar lives; the desktop shows both.
      await page.goto(
        viewport === 'phone'
          ? `/rooms?${new URLSearchParams({ account: data.alex.userId, space: urlSegment(data.spaceId) })}`
          : roomUrl(data.generalId),
      );
      await page.getByTestId('user-menu-trigger').click({ timeout: 30_000 });
      const rows = page.getByTestId('account-row');
      await expect(rows).toHaveCount(2, { timeout: 30_000 });
      return rows.last();
    }
    case 'encryption': {
      await page.goto('/settings/security');
      await expect(
        page.getByTestId('security-encryption-unavailable'),
      ).toHaveCount(0, {
        timeout: 30_000,
      });
      return page.getByTestId('security-session-verified');
    }
  }
}

test.beforeAll(async ({ playwright }) => {
  if (!session.available)
    throw new Error('needs the disposable homeserver (Docker)');
  const request = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
  });
  try {
    data = await seedScenes(request, session.hs as string);
  } finally {
    await request.dispose();
  }
  mkdirSync(OUT, { recursive: true });
});

for (const [viewport, profile] of Object.entries(VIEWPORTS) as [
  Viewport,
  (typeof VIEWPORTS)[Viewport],
][]) {
  test.describe.serial(viewport, () => {
    let page: Page;

    // One signed-in device per viewport: a context per shot would add a device per shot.
    test.beforeAll(async ({ browser }) => {
      test.setTimeout(300_000);
      const context = await browser.newContext({
        ...DESIGN_VIEWPORTS[profile],
        baseURL: e2eEndpoint('application'),
        ignoreHTTPSErrors: true,
        colorScheme: 'dark',
        locale: 'en-US',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
      });
      page = await context.newPage();
      // Headless Chromium declines persistent storage, which an installed app holds;
      // without this every scene carries the storage notice.
      await page.addInitScript(() =>
        Object.defineProperties(StorageManager.prototype, {
          persist: { configurable: true, value: () => Promise.resolve(true) },
          persisted: { configurable: true, value: () => Promise.resolve(true) },
        }),
      );
      await login(page, asSession(data.work), webNavigate, 'forbid');
      // Alex signs in last, so the scenes show the account that was added most recently.
      const addAccount = (target: Page) =>
        target
          .goto('/login?add', { waitUntil: 'domcontentloaded' })
          .then(() => undefined);
      if (!recoveryKey) {
        await login(page, asSession(data.alex), addAccount, 'forbid');
        recoveryKey = await setUpEncryption(page, data.alex.pass);
      } else {
        // A later viewport is a new device: verify it with the recovery key.
        await login(page, asSession(data.alex), addAccount, 'expect');
        await page.getByTestId('device-confirmation-recovery-key').click();
        await page.getByTestId('recovery-key-input').fill(recoveryKey);
        await page.getByTestId('unlock-submit').click();
        await waitForRooms(page, 60_000);
      }
    });

    test.afterAll(async () => {
      await page?.context().close();
    });

    for (const scene of SCENES) {
      for (const theme of THEMES) {
        test(`${scene} ${theme}`, async () => {
          await page.emulateMedia({ colorScheme: theme });
          const anchor = await openScene(page, scene, viewport);
          await expect(anchor).toBeVisible({ timeout: 30_000 });
          const root = expect(page.locator('html'));
          await (theme === 'dark' ? root : root.not).toHaveClass(/\bdark\b/);
          if (scene !== 'accounts') {
            // An opened panel focuses its close button, which then shows its tooltip.
            await page.evaluate(() =>
              (document.activeElement as HTMLElement | null)?.blur(),
            );
          }
          // Let fonts, avatars and entrance transitions settle before the frame is taken.
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.waitForTimeout(1_000);
          const file = `${scene}-${viewport}-${theme}.png`;
          await page.screenshot({
            path: join(OUT, file),
            animations: 'disabled',
            style: HIDE_CLOCK,
          });
          shots.push({ scene, viewport, theme, file });
        });
      }
    }
  });
}

test('writes the manifest', () => {
  expect(shots).toHaveLength(
    SCENES.length * THEMES.length * Object.keys(VIEWPORTS).length,
  );
  const { version } = JSON.parse(
    readFileSync(join(workspaceRoot, 'package.json'), 'utf8'),
  ) as {
    version: string;
  };
  writeFileSync(
    join(OUT, 'manifest.json'),
    `${JSON.stringify({ appVersion: version, capturedAt: new Date().toISOString(), shots }, null, 2)}\n`,
  );
});
