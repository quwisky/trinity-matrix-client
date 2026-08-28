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
import { passwordLogin, registerUser } from '../playwright/support/account.mts';
import {
  AA_NORMAL_TEXT,
  measureContrast,
} from '../playwright/support/contrast.mts';

const session = synapseSession();
const ROOM_MESSAGES = [
  'The shipped interface keeps the conversation as the visual focus.',
  'Compact density and larger text remain independent choices.',
  'Web, Electron and Android share this exact application payload.',
] as const;

type Mode = 'light' | 'dark';
type Palette = 'trinity' | 'amethyst' | 'onyx';
type Density = 'cosy' | 'compact';
type TextScale = 'default' | 'larger';
interface Appearance {
  mode: Mode;
  palette: Palette;
  density: Density;
  textScale: TextScale;
}

const MATRIX: Record<string, Appearance> = {
  'wide-dark-cosy': {
    mode: 'dark',
    palette: 'trinity',
    density: 'cosy',
    textScale: 'default',
  },
  'standard-amethyst-cosy': {
    mode: 'dark',
    palette: 'amethyst',
    density: 'cosy',
    textScale: 'default',
  },
  'tablet-light-compact': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'default',
  },
  'compact-light-large': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'larger',
  },
  'pixel-onyx-cosy': {
    mode: 'dark',
    palette: 'onyx',
    density: 'cosy',
    textScale: 'default',
  },
  'small-light-large': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'larger',
  },
  'webkit-compact-light': {
    mode: 'light',
    palette: 'trinity',
    density: 'compact',
    textScale: 'default',
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
  const reader = `phase7-${suffix}-reader`;
  const readerPass = `${reader}-pass`;
  const sender = `phase7-${suffix}-sender`;
  const senderPass = `${sender}-pass`;
  const roomName = `Phase 7 ${suffix}`;
  await registerUser(request, reader, readerPass);
  await registerUser(request, sender, senderPass);
  const readerSession = await passwordLogin(
    request,
    session.hs as string,
    reader,
    readerPass,
  );
  const senderSession = await passwordLogin(
    request,
    session.hs as string,
    sender,
    senderPass,
  );
  const readerHeaders = {
    Authorization: `Bearer ${readerSession.accessToken}`,
  };
  const senderHeaders = {
    Authorization: `Bearer ${senderSession.accessToken}`,
  };
  const created = await request.post(
    `${session.hs}/_matrix/client/v3/createRoom`,
    {
      headers: readerHeaders,
      data: {
        name: roomName,
        preset: 'private_chat',
        invite: [senderSession.userId],
      },
    },
  );
  expect(created.ok(), 'create shipped-interface room').toBe(true);
  const roomId = ((await created.json()) as { room_id: string }).room_id;
  const joined = await request.post(
    `${session.hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: senderHeaders },
  );
  expect(joined.ok(), 'join shipped-interface sender').toBe(true);

  for (const [index, body] of ROOM_MESSAGES.entries()) {
    const response = await request.put(
      `${session.hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${suffix}-${index}`,
      { headers: senderHeaders, data: { msgtype: 'm.text', body } },
    );
    expect(response.ok(), `seed message ${index}`).toBe(true);
  }
  return {
    credentials: {
      available: true,
      hs: session.hs,
      user: reader,
      pass: readerPass,
    },
    roomName,
  };
}

async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
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
    await document.fonts.ready;
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
  await expect(room.locator('.channel__badge')).toBeVisible({
    timeout: 20_000,
  });
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

async function expectAppearanceApplied(
  page: Page,
  appearance: Appearance,
): Promise<void> {
  const expectedScale = appearance.textScale === 'larger' ? 1.25 : 1;
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return {
          mode: root.classList.contains('dark') ? 'dark' : 'light',
          palette: root.getAttribute('data-theme') ?? 'trinity',
          density: root.getAttribute('data-density') ?? 'cosy',
          rootSize: Number.parseFloat(getComputedStyle(root).fontSize),
        };
      }),
    )
    .toEqual({
      mode: appearance.mode,
      palette: appearance.palette,
      density: appearance.density,
      rootSize: 16 * expectedScale,
    });

  const message = page.locator('.main .msg__text', {
    hasText: ROOM_MESSAGES[0],
  });
  await expect
    .poll(() =>
      message.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          lineHeight: Number.parseFloat(style.lineHeight),
          size: Number.parseFloat(style.fontSize),
        };
      }),
    )
    .toEqual({ lineHeight: 24 * expectedScale, size: 16 * expectedScale });
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

  test('satisfies the representative semantic and responsive matrix', async ({
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
    await expectInsideViewport(page, loginCard, 'login card');
    await expectNoHorizontalScroll(page);
    await expectReadable(page, page.getByRole('heading', { level: 1 }));

    await signIn(page, credentials);
    await openRoom(page, roomName);
    await stabilize(page);
    const shell = page.locator('.rooms-shell');
    await expectInsideViewport(page, shell, 'room shell');
    await expectInsideViewport(
      page,
      page.getByTestId('composer-field'),
      'message composer',
    );
    await expectNoHorizontalScroll(page);
    await expectReadable(page, page.getByRole('heading', { name: roomName }));
    for (const body of ROOM_MESSAGES) {
      await expect(
        page.locator('.main .msg__text', { hasText: body }),
      ).toBeVisible();
    }
    await expectAppearanceApplied(page, appearance);
    await expect(page.getByTestId('composer-input')).toHaveAccessibleName(
      new RegExp(roomName),
    );
    if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) < 768) {
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

    const emojiTrigger = page.getByRole('button', { name: 'Insert emoji' });
    await emojiTrigger.click();
    const emoji = page.locator('trn-emoji-picker');
    await expect(emoji).toBeVisible({ timeout: 20_000 });
    await stabilize(page);
    await expectInsideViewport(page, emoji, 'emoji picker');
    await expect(
      emoji.locator('.emoji-mart-search input'),
    ).toHaveAccessibleName(/search/i);
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
    await expect(
      page.getByTestId('text-scale-select').getByRole('combobox'),
    ).toHaveAccessibleName('Text size');
    const settingsNavigation = page.getByRole('navigation', {
      name: 'Settings sections',
    });
    if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) < 768) {
      await expect(settingsNavigation).toBeHidden();
    } else {
      await expect(settingsNavigation).toBeVisible();
    }

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
    await expect(page.getByTestId('recovery-key')).toHaveCount(0);

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
