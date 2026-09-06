import {
  testResourceId,
  devices,
  expect,
  test,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { installWidgetFixture } from '../../support/widget.mts';

// A real device profile is essential here: a touch-enabled desktop user agent keeps the
// desktop dialog path and would not prove that the mobile settings surface stays usable.
test.use({ ...devices['Pixel 5'] });

const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Room settings widgets on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps every widget and the modal actions reachable', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}wm`;
    const user = `widget-mobile-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Many widgets ${runId}`;
    const widgetCount = 8;
    const longWidgetName = `Planning-${'continuity-'.repeat(18)}board`;
    const longWidgetUrl =
      `https://widgets.example/${'long-segment-'.repeat(18)}` +
      '?room=$matrix_room_id';
    const widgetFixture = await installWidgetFixture(page);

    await registerUser(request, user, pass);
    const accessToken = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((response) => response.json())
      .then((body) => body.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        name: roomName,
        preset: 'private_chat',
        initial_state: Array.from({ length: widgetCount }, (_, index) => ({
          type: 'im.vector.modular.widgets',
          state_key: `board-${index}`,
          content: {
            name:
              index === widgetCount - 1
                ? longWidgetName
                : `Planning board ${index + 1}`,
            type: 'm.custom',
            url:
              index === widgetCount - 1
                ? longWidgetUrl
                : `https://widgets.example/board/${index}`,
          },
        })),
      },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'widgets');

    await page.getByTestId('room-widget-create-name').fill('Mobile board');
    await page
      .getByTestId('room-widget-create-url')
      .fill('https://widgets.example/mobile?room=$matrix_room_id');

    await page.getByTestId('room-settings-mobile-back').tap();
    const discard = page.locator('trn-alert-dialog');
    await expect(discard).toContainText('unsaved Room details');
    await discard.getByRole('button', { name: 'Keep editing' }).tap();
    await expect(page.getByTestId('room-widget-create-name')).toHaveValue(
      'Mobile board',
    );
    await expect(page.getByTestId('room-widget-create-url')).toHaveValue(
      'https://widgets.example/mobile?room=$matrix_room_id',
    );
    await page.getByTestId('room-widget-create-url').press('Enter');
    await expect(
      page.locator('article.room-widgets__widget', {
        hasText: 'Mobile board',
      }),
    ).toBeVisible({ timeout: 30_000 });
    expect(widgetFixture.requestCount()).toBe(0);

    const scrollRegion = page.locator('.room-settings__section-scroll');
    await expect
      .poll(() =>
        scrollRegion.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);

    const widgetCards = page.locator('[data-testid^="room-widget-board-"]');
    await expect(widgetCards).toHaveCount(widgetCount);
    for (let index = 0; index < widgetCount; index += 1) {
      await expect(
        page.getByTestId(`room-widget-board-${index}`),
      ).toContainText(
        index === widgetCount - 1
          ? longWidgetName
          : `Planning board ${index + 1}`,
      );
    }

    const lastWidget = page.getByTestId(`room-widget-board-${widgetCount - 1}`);
    await lastWidget.scrollIntoViewIfNeeded();
    await expect(lastWidget).toBeVisible();
    await expect(lastWidget).toContainText(longWidgetUrl);
    await expect
      .poll(() =>
        page
          .getByTestId('room-settings')
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      )
      .toBe(true);
    await page
      .getByTestId(`room-widget-open-board-${widgetCount - 1}`)
      .click({ trial: true });

    expect(widgetFixture.requestCount()).toBe(0);
    await page
      .getByTestId(`room-widget-embed-board-${widgetCount - 1}`)
      .click();
    await expect(page.getByTestId('widget-frame-status')).toContainText(
      'Widget API ready',
    );
    const frame = page.locator('iframe.widget-frame__iframe');
    const frameBox = await frame.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(frameBox?.width).toBeGreaterThanOrEqual(
      (page.viewportSize()?.width ?? 0) - 1,
    );
    const visualViewport = await page.evaluate(() => ({
      top: window.visualViewport?.offsetTop ?? 0,
      height: window.visualViewport?.height ?? window.innerHeight,
    }));
    expect(frameBox?.y ?? -1).toBeGreaterThanOrEqual(visualViewport.top - 1);
    expect((frameBox?.y ?? 0) + (frameBox?.height ?? 0)).toBeLessThanOrEqual(
      visualViewport.top + visualViewport.height + 1,
    );
    await page.getByTestId('room-widget-frame-close').click();
    await expect(frame).toHaveCount(0);

    const cancel = page.getByTestId('room-settings-cancel');
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox).not.toBeNull();
    expect((cancelBox?.y ?? 0) + (cancelBox?.height ?? 0)).toBeLessThanOrEqual(
      page.viewportSize()?.height ?? 0,
    );

    const appearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
      fontSize: document.documentElement.style.fontSize,
    }));
    for (const theme of [null, 'amethyst', 'onyx'] as const) {
      for (const dark of [false, true]) {
        await page.evaluate(
          ({ selectedTheme, selectedDark }) => {
            document.documentElement.classList.toggle('dark', selectedDark);
            if (selectedTheme === null)
              document.documentElement.removeAttribute('data-theme');
            else
              document.documentElement.setAttribute(
                'data-theme',
                selectedTheme,
              );
          },
          { selectedTheme: theme, selectedDark: dark },
        );
        await expect(cancel).toBeVisible();
        await expect(
          page.getByTestId(`room-widget-open-board-${widgetCount - 1}`),
        ).toBeVisible();
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    await lastWidget.scrollIntoViewIfNeeded();
    await expect(lastWidget).toBeVisible();
    await test.info().attach('room-widgets-mobile', {
      body: await page.getByTestId('room-settings').screenshot(),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme, fontSize }) => {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.fontSize = fontSize;
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, appearance);
  });
});
