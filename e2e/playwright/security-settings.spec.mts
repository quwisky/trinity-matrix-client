import { test, expect } from './support/fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';
import { openSettingsSection } from './journeys/navigation.mts';

// Covers the Security settings section (Settings → Security): it surfaces this account's
// encryption posture from TrustService and launches the existing setup/verify flows. A
// freshly-registered first device has no secret storage (status `needs-setup`) and an
// unverified session, so the section offers "Set up recovery" (routes to /encryption/setup)
// and "Verify with another device". A fresh user keeps the crypto state deterministic.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

test.describe('Security settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows the encryption posture and launches recovery setup', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sec`;
    const user = `sec-user-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as SynapseSession);

    await openSettingsSection(page, 'security');

    // The section renders its status cards.
    await expect(page.getByTestId('security-settings')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('security-session')).toBeVisible();
    await expect(page.getByTestId('security-backup')).toBeVisible();

    // A fresh session isn't verified, so it offers to verify with another device.
    await expect(page.getByTestId('security-verify')).toBeVisible({
      timeout: 15_000,
    });

    // Encryption needs setting up; the setup action routes to the setup flow.
    const setUp = page.getByTestId('security-setup');
    await expect(setUp).toBeVisible({ timeout: 20_000 });
    await setUp.click();
    // setUp() navigates with a `returnTo` query param, so the URL is
    // `/encryption/setup?returnTo=…` — don't anchor the match to the path end.
    await page.waitForURL(/\/encryption\/setup(\?|$)/, { timeout: 20_000 });
  });

  test('keeps verification nested in the narrow settings surface', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}narrow-sec`;
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

    if (isAndroidE2E) {
      await page.waitForURL((url) => url.pathname === '/encryption/verify', {
        timeout: 20_000,
      });
      await expect(page.getByTestId('verify-page')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Verify device', exact: true }),
      ).toBeFocused();

      await page.getByRole('button', { name: 'Close' }).click();
      await page.waitForURL((url) => url.pathname === '/settings/security', {
        timeout: 20_000,
      });
      await expect(
        page.getByRole('heading', { name: 'Security', exact: true }),
      ).toBeFocused();
      return;
    }

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
});
