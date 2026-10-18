import { expect, test, testResourceId } from '../../../fixtures.mts';
import {
  fillLabeledInput,
  homeserverSession,
  settleSignIn,
  webNavigate,
} from '../../../support/app.mts';
import { registerMasUser, type MasAccount } from '../../support/mas.mts';
import {
  ExistingDevice,
  readQrBytes,
} from '../../support/qr-existing-device.mts';

// Sign in on a new device by showing a QR code (MSC4108) against a real MAS. The new device
// is the app on its login page. The existing device is scripted with matrix-js-sdk in Node
// until the app can link a device itself; it scans the code, compares the check code,
// approves on MAS's device page and shares its secrets.
//
// Opt-in: TRINITY_E2E_MAS=1 adds the stack (e2e/support/homeserver/mas/).
const mas = homeserverSession().mas;

function masAccount(): MasAccount {
  if (!mas) throw new Error('the MAS stack is not running (TRINITY_E2E_MAS=1)');
  return mas;
}

test.describe('QR sign-in on a new device', () => {
  test.skip(!mas, 'needs the opt-in MAS stack (TRINITY_E2E_MAS=1)');

  test('signs in verified by showing a code to a signed-in device', async ({
    page,
    authPlatform,
  }) => {
    test.setTimeout(240_000);
    const account = await registerMasUser(
      masAccount(),
      `qr-new-${testResourceId('run')}`,
    );
    // The existing device's requests go to the stack's self-signed TLS from Node.
    const tlsPolicy = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    let existing: ExistingDevice | undefined;
    let approver:
      Awaited<ReturnType<typeof authPlatform.openIsolatedPage>> | undefined;
    try {
      approver = await authPlatform.openIsolatedPage();
      const device = await ExistingDevice.signIn(account);
      existing = device;
      await webNavigate(page, '/login');
      await fillLabeledInput(page, 'Homeserver', account.hs);
      await page.getByText('Continue', { exact: true }).click();
      await page.getByTestId('qr-sign-in').click({ timeout: 30_000 });
      const code = page.getByAltText('QR code to sign in on this device');
      await expect(code).toBeVisible({ timeout: 30_000 });

      const flow = await device.scan(await readQrBytes(code));
      // The person compares the two check codes before anything is shared.
      await expect(page.getByTestId('qr-sign-in-check-code')).toHaveText(
        flow.checkCode!,
      );
      const { verificationUri } = await flow.deviceAuthorizationGrant();
      const userCode = page
        .getByTestId('qr-sign-in-user-code')
        .locator('strong');
      await expect(userCode).toBeVisible();
      const shared = flow.shareSecrets();
      shared.catch(() => undefined);

      // MAS 1.26 pages/device_link.html asks for the code the new device shows, then
      // signs in (pages/login.html) and asks for consent (pages/device_consent.html).
      const provider = approver.page;
      await provider.goto(verificationUri!);
      await provider.locator('input:not([type="hidden"])').first().click();
      await provider.keyboard.type((await userCode.textContent())!.trim());
      await provider.getByRole('button', { name: 'Continue' }).click();
      await provider.locator('input[name="username"]').fill(account.user);
      await provider.locator('input[name="password"]').fill(account.pass);
      await provider.getByRole('button', { name: 'Continue' }).click();
      await provider.getByRole('checkbox').check();
      await provider.locator('button[name="action"][value="consent"]').click();

      // A device that imported the secrets is cross-signed, so no device check opens.
      await settleSignIn(page, 'forbid', 90_000);
      await shared;
      const devices = await device.client.getDevices();
      const signedIn = devices.devices.find(
        (other) => other.device_id !== device.client.getDeviceId(),
      );
      expect(signedIn).toBeDefined();
      await expect
        .poll(() => device.trusts(signedIn!.device_id), { timeout: 30_000 })
        .toBe(true);
    } finally {
      await approver?.close();
      existing?.stop();
      if (tlsPolicy === undefined)
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = tlsPolicy;
    }
  });
});
