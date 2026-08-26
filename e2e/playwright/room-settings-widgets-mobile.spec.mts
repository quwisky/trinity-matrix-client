import { devices, expect, test, type Page } from '@playwright/test';
import {
  login,
  openSettingsTab,
  synapseSession,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';
import { installWidgetFixture } from './support/widget.mts';

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
    const runId = `${Date.now().toString(36)}wm`;
    const user = `widget-mobile-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Many widgets ${runId}`;
    const widgetCount = 8;
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
            name: `Planning board ${index + 1}`,
            type: 'm.custom',
            url: `https://widgets.example/board/${index}`,
          },
        })),
      },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'widgets');

    const scrollRegion = page.locator('.room-settings__tabs');
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
      ).toContainText(`Planning board ${index + 1}`);
    }

    const lastWidget = page.getByTestId(`room-widget-board-${widgetCount - 1}`);
    await lastWidget.scrollIntoViewIfNeeded();
    await expect(lastWidget).toBeVisible();
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
  });
});
