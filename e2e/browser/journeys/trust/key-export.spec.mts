import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Covers encrypted room-key export / import (Settings → Security → Encrypted key export):
// exporting prompts for a passphrase and downloads a megolm `.txt`; importing that file back
// with the same passphrase round-trips through TrustService.export/importRoomKeys. A fresh
// account exports an empty key set, which still exercises the file format + UI plumbing
// end-to-end. Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

const PASSPHRASE = 'test-export-passphrase';

test.describe('Encrypted key export', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('exports room keys to a file and imports them back', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'native WebView export needs a production Files/Share implementation before this browser download journey is portable',
    );
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ke`;
    const user = `keyexp-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as SynapseSession);

    await openSettingsSection(page, 'security');
    await expect(page.getByTestId('security-key-export')).toBeVisible({
      timeout: 15_000,
    });

    // Export: enter a passphrase, confirm, and capture the downloaded file.
    await page.getByTestId('security-export-keys').click();
    const dialog = page.locator('trn-alert-dialog');
    await dialog.locator('input').fill(PASSPHRASE);
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('alert-confirm').click();
    const inputFile = await downloadPromise.then((download) => download.path());
    await expect(page.getByText('Room keys exported.')).toBeVisible({
      timeout: 20_000,
    });

    // Import the same file back with the same passphrase.
    await page
      .locator('[data-testid=security-key-export] input[type=file]')
      .setInputFiles(inputFile);
    const importDialog = page.locator('trn-alert-dialog');
    await importDialog.locator('input').fill(PASSPHRASE);
    await page.getByTestId('alert-confirm').click();

    await expect(page.getByText('Room keys imported.')).toBeVisible({
      timeout: 20_000,
    });
  });
});
