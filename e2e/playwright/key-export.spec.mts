import { test, expect } from './support/fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers encrypted room-key export / import (Settings → Security → Encrypted key export):
// exporting prompts for a passphrase and downloads a megolm `.txt`; importing that file back
// with the same passphrase round-trips through CryptoService.export/importRoomKeys. A fresh
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
    if (isAndroidE2E) {
      await page.evaluate(() => {
        const state = window as typeof window & {
          __trinityDownload?: {
            name: string;
            mimeType: string;
            base64: string;
          };
        };
        const click = HTMLAnchorElement.prototype.click;
        URL.revokeObjectURL = () => undefined;
        HTMLAnchorElement.prototype.click = function captureDownload() {
          const name = this.download || 'trinity-room-keys.txt';
          const encoded = this.href.slice(this.href.indexOf(',') + 1);
          const bytes = new TextEncoder().encode(decodeURIComponent(encoded));
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          state.__trinityDownload = {
            name,
            mimeType: 'text/plain',
            base64: btoa(binary),
          };
          HTMLAnchorElement.prototype.click = click;
        };
      });
    }
    const downloadPromise = isAndroidE2E
      ? undefined
      : page.waitForEvent('download');
    await page.getByTestId('alert-confirm').click();
    const inputFile = isAndroidE2E
      ? await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (
                    window as typeof window & {
                      __trinityDownload?: {
                        name: string;
                        mimeType: string;
                        base64: string;
                      };
                    }
                  ).__trinityDownload,
              ),
            { timeout: 20_000 },
          )
          .not.toBeUndefined()
          .then(() =>
            page.evaluate(
              () =>
                (
                  window as typeof window & {
                    __trinityDownload: {
                      name: string;
                      mimeType: string;
                      base64: string;
                    };
                  }
                ).__trinityDownload,
            ),
          )
          .then((download) => ({
            name: download.name,
            mimeType: download.mimeType,
            buffer: Buffer.from(download.base64, 'base64'),
          }))
      : await downloadPromise!.then((download) => download.path());
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
