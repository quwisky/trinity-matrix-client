import { test, expect } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';
import { openSettingsSection } from './journeys/navigation.mts';

// Covers the Security settings section (Settings → Security): it surfaces this account's
// encryption posture from CryptoService and launches the existing setup/verify flows. A
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
});
