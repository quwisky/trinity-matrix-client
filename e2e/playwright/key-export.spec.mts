import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers encrypted room-key export / import (Settings → Security → Encrypted key export):
// exporting prompts for a passphrase and downloads a megolm `.txt`; importing that file back
// with the same passphrase round-trips through CryptoService.export/importRoomKeys. A fresh
// account exports an empty key set, which still exercises the file format + UI plumbing
// end-to-end. Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';
const PASSPHRASE = 'test-export-passphrase';

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

test.describe('Encrypted key export', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('exports room keys to a file and imports them back', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ke`;
    const user = `keyexp-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as SynapseSession);

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-security').click();
    await page.waitForURL(/\/settings\/security$/, { timeout: 20_000 });
    await expect(page.getByTestId('security-key-export')).toBeVisible({
      timeout: 15_000,
    });

    // Export: enter a passphrase, confirm, and capture the downloaded file.
    await page.getByTestId('security-export-keys').click();
    const dialog = page.locator('trn-alert-dialog');
    await dialog.locator('input').fill(PASSPHRASE);
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('alert-confirm').click();
    const download = await downloadPromise;
    const filePath = await download.path();
    await expect(page.getByText('Room keys exported.')).toBeVisible({
      timeout: 20_000,
    });

    // Import the same file back with the same passphrase.
    await page
      .locator('[data-testid=security-key-export] input[type=file]')
      .setInputFiles(filePath);
    const importDialog = page.locator('trn-alert-dialog');
    await importDialog.locator('input').fill(PASSPHRASE);
    await page.getByTestId('alert-confirm').click();

    await expect(page.getByText('Room keys imported.')).toBeVisible({
      timeout: 20_000,
    });
  });
});
