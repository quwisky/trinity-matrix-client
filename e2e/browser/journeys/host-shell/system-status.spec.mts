import { devices } from '@playwright/test';
import { expect, test, type Locator, type Page } from '../../../fixtures.mts';

interface SystemStatusDebugWindow extends Window {
  ng: {
    getComponent(element: Element): {
      status: {
        health: {
          reset(): void;
          report(
            fact: Record<string, unknown>,
            recovery: () => Promise<{ kind: string }>,
          ): void;
        };
      };
    };
  };
  settleSystemStatusRecovery?: (outcome: { kind: string }) => void;
}

async function openStatus(page: Page): Promise<Locator> {
  await page.goto('/login');
  const trigger = page
    .getByRole('button', { name: 'System Status', exact: true })
    .first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(
    page.getByRole('dialog', { name: 'System Status' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'System Status', level: 1 }),
  ).toBeFocused();
  return trigger;
}

test.describe('System Status on desktop', () => {
  test('retains the route, protects support details and rejoins recovery', async ({
    page,
  }, testInfo) => {
    const initialTrigger = await openStatus(page);
    const dialog = page.getByRole('dialog', { name: 'System Status' });
    await expect(page.locator('trn-system-status')).not.toHaveClass(
      /system-status--mobile/,
    );

    const directory = dialog.getByRole('navigation', {
      name: 'System Status sections',
    });
    const detail = dialog.getByTestId('system-status-detail');
    await expect(directory).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Overview', exact: true }),
    ).toBeVisible();
    const directoryBox = await directory.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(directoryBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    expect(directoryBox!.x + directoryBox!.width).toBeLessThanOrEqual(
      detailBox!.x + 1,
    );
    expect(detailBox!.width).toBeGreaterThan(500);

    const support = dialog.getByRole('button', {
      name: 'Support details',
      exact: true,
    });
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('[role="dialog"]')),
        ),
      )
      .toBe(true);
    await support.focus();
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('[role="dialog"]')),
        ),
      )
      .toBe(true);

    await page
      .getByRole('button', { name: 'Close System Status', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(initialTrigger).toBeFocused();

    await page.evaluate(() => {
      const target = window as unknown as SystemStatusDebugWindow;
      const root = document.querySelector('trn-root');
      if (!root) throw new Error('Application root unavailable');
      const health = target.ng.getComponent(root).status.health;
      const context = Symbol('private-account-context');
      health.report(
        {
          capability: 'future-capability',
          operation: 'future-operation',
          context,
          generation: 1,
          demanded: true,
          preparation: 'failed',
          ownership: 'retained',
          condition: 'degraded',
          code: 'safe-unknown-fault',
          accountId: '@private:example.org',
          rawError: 'synthetic private adapter response',
        },
        () =>
          new Promise((resolve) => {
            target.settleSystemStatusRecovery = resolve;
          }),
      );
    });

    await expect(page.getByTestId('app-capability-summary')).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Homeserver' }),
    ).toBeVisible();
    await page
      .getByTestId('app-capability-summary')
      .getByRole('button', { name: 'System Status' })
      .click();
    const unknownEntry = dialog
      .locator('article')
      .filter({ hasText: 'A feature needs attention' });
    await expect(unknownEntry).toBeVisible();
    await expect(unknownEntry).not.toContainText('safe-unknown-fault');
    await support.click();
    const details = dialog.locator('pre');
    await expect(details).toContainText('unrecognized-capability-status');
    await expect(details).not.toContainText('safe-unknown-fault');
    await expect(details).not.toContainText('@private:example.org');
    await expect(details).not.toContainText(
      'synthetic private adapter response',
    );

    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy support details' }).click();
    await expect(
      dialog.getByText('Copied locally. Nothing was uploaded.'),
    ).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await details.textContent());

    await dialog.getByRole('button', { name: 'Overview', exact: true }).click();
    await unknownEntry.getByRole('button', { name: 'Try again' }).click();
    const recovering = unknownEntry.getByRole('button', { name: /Recovering/ });
    await expect(recovering).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page
      .getByTestId('app-capability-summary')
      .getByRole('button', { name: 'System Status' })
      .click();
    await expect(recovering).toBeDisabled();
    await expect(dialog).toContainText(
      'Reopening this view follows the same attempt',
    );

    await page.evaluate(() => {
      const target = window as unknown as SystemStatusDebugWindow;
      target.settleSystemStatusRecovery?.({ kind: 'failure' });
      delete target.settleSystemStatusRecovery;
    });
    await expect(dialog).toContainText(
      'Recovery settled without restoring this capability',
    );
    await testInfo.attach('system-status-desktop', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    const surface = dialog.locator('[data-trn-layout="workspace"]');
    const lightBackground = await surface.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect
      .poll(() =>
        surface.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      )
      .not.toBe(lightBackground);
    await expect(
      dialog.getByRole('heading', { name: 'Overview', exact: true }),
    ).toBeVisible();
    const darkControlColor = await dialog.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--trinity-control-foreground)';
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(support).toHaveCSS('color', darkControlColor);
    await testInfo.attach('system-status-desktop-dark', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );
    await dialog.getByRole('button', { name: 'Trinity', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Trinity', exact: true }),
    ).toBeFocused();
    await page.evaluate(() => {
      const target = window as unknown as SystemStatusDebugWindow;
      const root = document.querySelector('trn-root');
      if (!root) throw new Error('Application root unavailable');
      target.ng.getComponent(root).status.health.reset();
    });
    await expect(
      dialog.getByRole('button', { name: 'Trinity', exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('heading', { name: 'Overview', exact: true }),
    ).toBeFocused();
    await expect(dialog.getByTestId('system-status-all-working')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('[role="dialog"]')),
        ),
      )
      .toBe(true);
  });
});

test.describe('System Status on a touch-capable desktop', () => {
  test.use({ hasTouch: true });

  test('keeps the desktop interaction model', async ({ page }) => {
    await openStatus(page);
    await expect(page.locator('trn-system-status')).not.toHaveClass(
      /system-status--mobile/,
    );
  });
});

test.describe('System Status on a mobile OS', () => {
  const profile = devices['Pixel 5'];
  test.use({
    viewport: profile.viewport,
    userAgent: profile.userAgent,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
  });

  test('uses the viewport-safe bottom-sheet interaction model', async ({
    page,
  }, testInfo) => {
    await openStatus(page);
    const host = page.locator('trn-system-status');
    const dialog = page.getByRole('dialog', { name: 'System Status' });
    await expect(host).toHaveClass(/system-status--mobile/);
    await expect(dialog.locator('[data-trn-layout="sheet"]')).toHaveCSS(
      'border-bottom-left-radius',
      '0px',
    );
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(
      Math.abs((box?.y ?? 0) + (box?.height ?? 0) - profile.viewport.height),
    ).toBeLessThanOrEqual(1);
    const back = dialog.getByRole('button', { name: 'Back to sections' });
    const directory = dialog.getByRole('navigation', {
      name: 'System Status sections',
    });
    await expect(directory).toBeHidden();
    await expect(
      dialog.getByRole('heading', { name: 'Overview', exact: true }),
    ).toBeVisible();
    await back.click();
    await expect(directory).toBeVisible();
    await expect(
      directory.getByRole('button', { name: 'Overview', exact: true }),
    ).toBeFocused();
    await directory
      .getByRole('button', { name: 'Support details', exact: true })
      .click();
    await expect(directory).toBeHidden();
    await expect(
      dialog.getByRole('heading', { name: 'Support details', exact: true }),
    ).toBeFocused();
    await back.click();
    await expect(
      directory.getByRole('button', { name: 'Support details', exact: true }),
    ).toBeFocused();
    await directory
      .getByRole('button', { name: 'Overview', exact: true })
      .click();
    await page.evaluate(
      () => (document.documentElement.style.fontSize = '24px'),
    );
    await expect(back).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Close System Status' }),
    ).toBeInViewport();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await testInfo.attach('system-status-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  });
});
