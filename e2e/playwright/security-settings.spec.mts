import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the Security settings section (Settings → Security): it surfaces this account's
// encryption posture from CryptoService and launches the existing setup/verify flows. A
// freshly-registered first device has no secret storage (status `needs-setup`) and an
// unverified session, so the section offers "Set up recovery" (routes to /encryption/setup)
// and "Verify with another device". A fresh user keeps the crypto state deterministic.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

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

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-security').click();
    await page.waitForURL(/\/settings\/security$/, { timeout: 20_000 });

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
    await page.waitForURL(/\/encryption\/setup$/, { timeout: 20_000 });
  });
});
