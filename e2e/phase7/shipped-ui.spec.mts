import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  fillLabeledInput,
  seedPreference,
  synapseSession,
  type SynapseSession,
} from '../playwright/support/app.mts';
import { registerUser } from '../playwright/support/account.mts';
import {
  AA_NORMAL_TEXT,
  measureContrast,
} from '../playwright/support/contrast.mts';

const session = synapseSession();
const regularFont = readFileSync(
  resolve(
    import.meta.dirname,
    '../../node_modules/storybook/assets/browser/nunito-sans-regular.woff2',
  ),
);
const boldFont = readFileSync(
  resolve(
    import.meta.dirname,
    '../../node_modules/storybook/assets/browser/nunito-sans-bold.woff2',
  ),
);

type Mode = 'light' | 'dark';
type Palette = 'trinity' | 'amethyst' | 'onyx';
type Density = 'cosy' | 'compact';
type TextScale = 'default' | 'larger';
type Surface = 'login' | 'room' | 'settings' | 'crypto' | 'emoji';

interface Appearance {
  mode: Mode;
  palette: Palette;
  density: Density;
  textScale: TextScale;
  screenshots: readonly Surface[];
}

const MATRIX: Record<string, Appearance> = {
  'wide-dark-cosy': {
    mode: 'dark',
    palette: 'trinity',
    density: 'cosy',
    textScale: 'default',
    screenshots: ['room'],
  },
  'standard-amethyst-cosy': {
    mode: 'dark',
    palette: 'amethyst',
    density: 'cosy',
    textScale: 'default',
    screenshots: ['room', 'emoji'],
  },
  'tablet-light-compact': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'default',
    screenshots: ['room'],
  },
  'compact-light-large': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'larger',
    screenshots: ['settings'],
  },
  'pixel-onyx-cosy': {
    mode: 'dark',
    palette: 'onyx',
    density: 'cosy',
    textScale: 'default',
    screenshots: ['room', 'emoji'],
  },
  'small-light-large': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'larger',
    screenshots: ['login', 'crypto'],
  },
  'webkit-compact-light': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'default',
    screenshots: [],
  },
};

function slug(value: string): string {
  return value.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase();
}

async function seedRoom(
  request: APIRequestContext,
  projectName: string,
): Promise<{ credentials: SynapseSession; roomName: string }> {
  const suffix = slug(projectName);
  const user = `phase7-${suffix}`;
  const pass = `${user}-pass`;
  const roomName = `Phase 7 ${suffix}`;
  await registerUser(request, user, pass);
  const auth = await request
    .post(`${session.hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((response) => response.json());
  const headers = { Authorization: `Bearer ${auth.access_token as string}` };
  const roomId = await request
    .post(`${session.hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((response) => response.json())
    .then((json) => json.room_id as string);

  const messages = [
    'The shipped interface keeps the conversation as the visual focus.',
    'Compact density and larger text remain independent choices.',
    'Web, Electron and Android share this exact application payload.',
  ];
  for (const [index, body] of messages.entries()) {
    const response = await request.put(
      `${session.hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${suffix}-${index}`,
      { headers, data: { msgtype: 'm.text', body } },
    );
    expect(response.ok(), `seed message ${index}`).toBe(true);
  }
  return {
    credentials: { available: true, hs: session.hs, user, pass },
    roomName,
  };
}

async function installDeterministicFont(page: Page): Promise<void> {
  await page.route('**/__phase7-font-regular.woff2', (route) =>
    route.fulfill({ body: regularFont, contentType: 'font/woff2' }),
  );
  await page.route('**/__phase7-font-bold.woff2', (route) =>
    route.fulfill({ body: boldFont, contentType: 'font/woff2' }),
  );
}

async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      @font-face {
        font-family: "Trinity Phase 7";
        src: url("/__phase7-font-regular.woff2") format("woff2");
        font-weight: 400 600;
        font-display: block;
      }
      @font-face {
        font-family: "Trinity Phase 7";
        src: url("/__phase7-font-bold.woff2") format("woff2");
        font-weight: 700 900;
        font-display: block;
      }
      html, body, button, input, select, textarea {
        font-family: "Trinity Phase 7", sans-serif !important;
      }
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      [role="tooltip"] {
        visibility: hidden !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.load('16px "Trinity Phase 7"');
    await document.fonts.load('700 16px "Trinity Phase 7"');
    await document.fonts.ready;
    for (const time of document.querySelectorAll('.msg__gutter, .msg__time')) {
      time.textContent = '09:41';
    }
    const build = document.querySelector('[data-testid="settings-build"]');
    if (build) build.textContent = 'Trinity shipped interface';
  });
}

async function expectProductionReducedMotionContract(page: Page) {
  const evidence = await page.evaluate(() => ({
    requested: matchMedia('(prefers-reduced-motion: reduce)').matches,
    fastDuration: getComputedStyle(document.documentElement)
      .getPropertyValue('--trinity-duration-fast')
      .trim(),
  }));
  expect(evidence.requested).toBe(true);
  expect(evidence.fastDuration).toMatch(/ms$/);
  expect(Number.parseFloat(evidence.fastDuration)).toBe(0.01);
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error('Keyboard navigation did not reach the expected control');
}

async function seedAppearance(
  page: Page,
  appearance: Appearance,
): Promise<void> {
  await seedPreference(page, 'trinity.theme', appearance.mode);
  await seedPreference(page, 'trinity.palette', appearance.palette);
  await seedPreference(page, 'trinity.density', appearance.density);
  await seedPreference(page, 'trinity.text-scale', appearance.textScale);
}

async function signIn(page: Page, credentials: SynapseSession): Promise<void> {
  await fillLabeledInput(page, 'Username', credentials.user as string);
  await fillLabeledInput(page, 'Password', credentials.pass as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
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

async function expectInsideViewport(
  page: Page,
  target: Locator,
  label: string,
): Promise<void> {
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} has a box`).not.toBeNull();
  expect(viewport, 'project has a viewport').not.toBeNull();
  expect(box!.x, `${label} left`).toBeGreaterThanOrEqual(-1);
  expect(box!.y, `${label} top`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} right`).toBeLessThanOrEqual(
    viewport!.width + 1,
  );
  expect(box!.y + box!.height, `${label} bottom`).toBeLessThanOrEqual(
    viewport!.height + 1,
  );
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

async function expectReadable(page: Page, heading: Locator): Promise<void> {
  await heading.evaluate((element) =>
    element.setAttribute('data-testid', 'phase7-contrast-target'),
  );
  const contrast = await measureContrast(page, 'phase7-contrast-target');
  expect(contrast.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
}

async function screenshot(
  target: Locator,
  surface: Surface,
  appearance: Appearance,
): Promise<void> {
  if (!appearance.screenshots.includes(surface)) return;
  await expect(target).toHaveScreenshot(`${surface}.png`, {
    animations: 'disabled',
    caret: 'hide',
  });
}

async function attachPerformanceEvidence(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  const evidence = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType(
      'resource',
    ) as PerformanceResourceTiming[];
    return {
      domInteractiveMs: navigation?.domInteractive ?? null,
      loadEventEndMs: navigation?.loadEventEnd ?? null,
      resourceCount: resources.length,
      transferBytes: resources.reduce(
        (total, resource) => total + resource.transferSize,
        0,
      ),
      longTasks: performance
        .getEntriesByType('longtask')
        .map(({ duration, startTime }) => ({ duration, startTime })),
    };
  });
  await testInfo.attach('performance-evidence.json', {
    body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    contentType: 'application/json',
  });
}

test.describe('@phase7 shipped UI', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('matches the approved representative visual and semantic matrix', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    const appearance = MATRIX[testInfo.project.name];
    if (!appearance)
      throw new Error(`Missing Phase 7 matrix entry: ${testInfo.project.name}`);
    if (testInfo.project.name === 'webkit-compact-light') {
      expect(browserName).toBe('webkit');
    }
    const { credentials, roomName } = await seedRoom(
      request,
      testInfo.project.name,
    );
    await installDeterministicFont(page);
    await page.emulateMedia({
      colorScheme: appearance.mode,
      reducedMotion: 'reduce',
    });
    await seedAppearance(page, appearance);

    await page.goto('/login', { waitUntil: 'networkidle' });
    await expectProductionReducedMotionContract(page);
    await fillLabeledInput(page, 'Homeserver', credentials.hs as string);
    await page.getByText('Continue', { exact: true }).click();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await stabilize(page);
    const loginCard = page.locator('.login-card');
    await expectNoHorizontalScroll(page);
    await expectReadable(page, page.getByRole('heading', { level: 1 }));
    await screenshot(loginCard, 'login', appearance);

    await signIn(page, credentials);
    await openRoom(page, roomName);
    await stabilize(page);
    const shell = page.locator('.rooms-shell');
    await expectInsideViewport(page, shell, 'room shell');
    await expectNoHorizontalScroll(page);
    await expectReadable(page, page.getByRole('heading', { name: roomName }));
    await screenshot(shell, 'room', appearance);

    const emojiTrigger = page.getByRole('button', { name: 'Insert emoji' });
    await emojiTrigger.click();
    const emoji = page.locator('trn-emoji-picker');
    await expect(emoji).toBeVisible({ timeout: 20_000 });
    await stabilize(page);
    await expectInsideViewport(page, emoji, 'emoji picker');
    await expect(
      emoji.locator('.emoji-mart-search input'),
    ).toHaveAccessibleName(/search/i);
    await screenshot(emoji, 'emoji', appearance);
    await page.keyboard.press('Escape');
    await expect(emoji).toBeHidden();
    await expect(emojiTrigger).toBeFocused();

    await page.goto('/settings/appearance', { waitUntil: 'domcontentloaded' });
    const settings = page.getByTestId('settings-workspace');
    await expect(settings).toBeVisible({ timeout: 20_000 });
    await stabilize(page);
    await expectInsideViewport(page, settings, 'settings workspace');
    await expectNoHorizontalScroll(page);
    await expectReadable(
      page,
      page.getByRole('heading', { name: 'Appearance' }),
    );
    await expect(
      page.getByTestId('palette-select').getByRole('combobox'),
    ).toHaveAccessibleName('Palette');
    await screenshot(settings, 'settings', appearance);

    await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
    const crypto = page.locator('.crypto-surface');
    await expect(crypto).toBeVisible({ timeout: 20_000 });
    await stabilize(page);
    await expectInsideViewport(page, crypto, 'encryption surface');
    await expectNoHorizontalScroll(page);
    await expectReadable(
      page,
      page.getByRole('heading', { name: 'Secure your messages' }),
    );
    await screenshot(crypto, 'crypto', appearance);

    if (testInfo.project.name === 'tablet-light-compact') {
      await page.emulateMedia({
        forcedColors: 'active',
        reducedMotion: 'reduce',
      });
      expect(
        await page.evaluate(
          () => matchMedia('(forced-colors: active)').matches,
        ),
      ).toBe(true);
      const action = page.getByRole('button', { name: 'Set up encryption' });
      await tabTo(page, action);
      await expect(action).toBeFocused();
      const focusIndicator = await action.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          color: style.outlineColor,
          style: style.outlineStyle,
          width: Number.parseFloat(style.outlineWidth),
        };
      });
      expect(focusIndicator.style).not.toBe('none');
      expect(focusIndicator.width).toBeGreaterThanOrEqual(1);
      expect(focusIndicator.color).not.toBe('rgba(0, 0, 0, 0)');
    }
    await attachPerformanceEvidence(page, testInfo);
  });
});
