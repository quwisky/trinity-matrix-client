import { captureScreenshot } from '../../../support/screenshot.mts';
import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Covers the Security settings section (Settings → Security) in the browser. Its
// encryption posture, recovery-setup launch and the Android full-page verification route
// run through android.security-settings (#725); what stays here is the desktop
// narrow-surface verification dialog and the development-only Trust-read fault recovery.
// A fresh user keeps the crypto state deterministic.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

interface TrustFaultWindow extends Window {
  ng: {
    getComponent(element: Element): {
      runtime: {
        adapter: {
          session: {
            trust: {
              health: {
                healthRuntime: {
                  cryptoPort: {
                    active(): {
                      crypto: {
                        isCrossSigningReady: () => Promise<boolean>;
                      } | null;
                    };
                  };
                  retryProjection(): void;
                };
              };
            };
          };
        };
      };
    };
  };
  restoreTrustRead?: () => void;
}

test.describe('Security settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps verification nested in the narrow settings surface', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'Android runs this through android.security-settings (#725).',
    );
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}narrow-sec`;
    const user = `sec-user-${runId}`;
    const pass = `${user}-pass`;

    await page.setViewportSize({ width: 700, height: 760 });
    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const roomUrl = page.url();

    await openSettingsSection(page, 'security');
    const verify = page.getByTestId('security-verify');
    await expect(verify).toBeVisible({ timeout: 15_000 });
    await verify.click();

    const encryption = page.getByRole('dialog', { name: 'Encryption' });
    await expect(encryption).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(page).toHaveURL(roomUrl);

    await encryption.getByRole('button', { name: 'Close' }).click();
    await expect(encryption).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(page).toHaveURL(roomUrl);
    await expect(verify).toBeFocused();
  });

  test('labels failed Trust reads and recovers through the scoped action', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      process.env['TRINITY_E2E_PLATFORM'] === 'android',
      'fault injection requires Angular development hooks; the installed APK is production',
    );
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}trust-health`;
    const user = `trust-health-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSettingsSection(page, 'security');
    await expect(page.getByTestId('security-setup')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('security-verify')).toBeVisible();

    await page.evaluate(() => {
      const target = window as unknown as TrustFaultWindow;
      const root = document.querySelector('trn-root');
      if (!root) throw new Error('Application root unavailable');
      const health =
        target.ng.getComponent(root).runtime.adapter.session.trust.health
          .healthRuntime;
      const crypto = health.cryptoPort.active().crypto;
      if (!crypto) throw new Error('Trust crypto unavailable');
      const read = crypto.isCrossSigningReady;
      target.restoreTrustRead = () => {
        crypto.isCrossSigningReady = read;
      };
      crypto.isCrossSigningReady = async () => {
        throw new Error('synthetic private Trust response');
      };
      health.retryProjection();
    });

    await expect(
      page.getByTestId('security-encryption-unavailable'),
    ).toContainText('last known status may be outdated');
    await expect(
      page.getByTestId('security-session-unavailable'),
    ).toBeVisible();
    await expect(page.getByTestId('security-setup')).toHaveCount(0);
    await expect(page.getByTestId('security-unlock')).toHaveCount(0);
    await expect(page.getByTestId('security-verify')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page
      .getByTestId('app-capability-summary')
      .getByRole('button', { name: 'System Status' })
      .click();
    const status = page.getByRole('dialog', { name: 'System Status' });
    const problem = status
      .locator('article')
      .filter({ hasText: 'Encryption trust status is unavailable' });
    await expect(problem).toContainText(
      'Verification and recovery status may be out of date',
    );
    await testInfo.attach('trust-unavailable', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });

    await page.evaluate(() => {
      const target = window as unknown as TrustFaultWindow;
      target.restoreTrustRead?.();
      delete target.restoreTrustRead;
    });
    await problem.getByRole('button', { name: 'Retry trust status' }).click();

    await expect(problem).toHaveCount(0);
    await status.getByRole('button', { name: 'Close' }).click();
    await openSettingsSection(page, 'security');
    await expect(
      page.getByTestId('security-encryption-unavailable'),
    ).toHaveCount(0);
    await expect(page.getByTestId('security-setup')).toBeVisible();
    await expect(page.getByTestId('security-verify')).toBeVisible();
    await testInfo.attach('trust-recovered', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });
  });
});
