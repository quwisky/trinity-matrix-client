// The app's own failure copy, so a wording change can't leave these journeys behind.
import { QR_SIGN_IN_FAILURE_MESSAGES } from '../../../../libs/data-access/auth/src/lib/qr-sign-in/qr-sign-in.model.ts';
import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  fillLabeledInput,
  homeserverSession,
  settleSignIn,
  webNavigate,
} from '../../../support/app.mts';
import type { AuthPlatform } from '../../../support/platform-contracts.mts';
import { openNamedRoom } from '../../../support/message-composer.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import {
  installSyntheticCamera,
  showOnCamera,
} from '../../../support/qr-camera.mts';
import { freshAccount } from '../../support/encryption-journey.mts';
import { registerMasUser } from '../../support/mas.mts';
import {
  ExistingDevice,
  readQrBytes,
  type QrAccount,
  type QrServerKind,
} from '../../support/qr-existing-device.mts';

// Sign in on a new device by showing a QR code (MSC4108), on each server that offers it:
// Synapse behind MAS (TRINITY_E2E_MAS=1) and Tuwunel's own OAuth server
// (TRINITY_E2E_HOMESERVER=tuwunel-oauth). The journeys need a first device that holds the
// account's identity. The web app can't be it on Tuwunel, whose OAuth server refuses the
// app's http redirect, so a matrix-js-sdk device in Node plays it, and links the app's first
// device the way a phone would. That app device then links a second one from Settings.
const session = homeserverSession();

interface QrServer {
  readonly kind: QrServerKind;
  account(request: APIRequestContext, prefix: string): Promise<QrAccount>;
}

const servers: QrServer[] = [];
if (session.mas) {
  const mas = session.mas;
  servers.push({
    kind: 'mas',
    account: (_request, prefix) =>
      registerMasUser(mas, `${prefix}-${testResourceId('run')}`),
  });
}
if (session.kind === 'tuwunel-oauth' && session.hs) {
  const hs = session.hs;
  servers.push({
    kind: 'tuwunel-oauth',
    account: (request, prefix) => freshAccount(request, hs, prefix),
  });
}

/** Open the login page's QR panel for `hs` and return the code it shows. */
async function showCode(page: Page, hs: string): Promise<Locator> {
  await webNavigate(page, '/login');
  await fillLabeledInput(page, 'Homeserver', hs);
  await page.getByText('Continue', { exact: true }).click();
  await page.getByTestId('qr-sign-in').click({ timeout: 30_000 });
  const code = page.getByAltText('QR code to sign in on this device');
  await expect(code).toBeVisible({ timeout: 30_000 });
  return code;
}

/** The user code the new device shows while it waits for approval. */
async function userCodeOn(page: Page): Promise<string> {
  const code = page.getByTestId('qr-sign-in-user-code').locator('strong');
  await expect(code).toBeVisible({ timeout: 30_000 });
  return (await code.textContent())!.trim();
}

/** Sign in on the server's approval page open in `provider`, and approve the new device. */
async function approve(
  provider: Page,
  server: QrServerKind,
  account: QrAccount,
  userCode: string,
): Promise<void> {
  if (server === 'tuwunel-oauth') {
    // Tuwunel 1.9.3: /_tuwunel/oidc/native signs in, then "Authorize device" approves.
    await provider.locator('input[name="username"]').fill(account.user);
    await provider.locator('input[name="password"]').fill(account.pass);
    await provider.getByRole('button', { name: 'Sign in' }).click();
    await provider.getByRole('button', { name: 'Approve' }).click();
    return;
  }
  // MAS 1.26 pages/device_link.html asks for the code the new device shows, then signs in
  // (pages/login.html) and asks for consent (pages/device_consent.html).
  await provider.locator('input:not([type="hidden"])').first().click();
  await provider.keyboard.type(userCode);
  await provider.getByRole('button', { name: 'Continue' }).click();
  await provider.locator('input[name="username"]').fill(account.user);
  await provider.locator('input[name="password"]').fill(account.pass);
  await provider.getByRole('button', { name: 'Continue' }).click();
  await provider.getByRole('checkbox').check();
  await provider.locator('button[name="action"][value="consent"]').click();
}

/**
 * Sign `page` in by showing a code to the Node device, which scans it, matches the check code,
 * approves in `provider` and shares its secrets. Returns the new device's ID.
 */
async function linkFromNode(
  page: Page,
  provider: Page,
  device: ExistingDevice,
  server: QrServerKind,
  account: QrAccount,
): Promise<string> {
  // Tuwunel's registration leaves a device of its own, so the new one is the one added here.
  const before = new Set(
    (await device.client.getDevices()).devices.map((known) => known.device_id),
  );
  const flow = await device.scan(
    await readQrBytes(await showCode(page, account.hs)),
  );
  // The person compares the two check codes before anything is shared.
  await expect(page.getByTestId('qr-sign-in-check-code')).toHaveText(
    flow.checkCode!,
    { timeout: 30_000 },
  );
  const { verificationUri } = await flow.deviceAuthorizationGrant();
  const userCode = await userCodeOn(page);
  const shared = flow.shareSecrets();
  shared.catch(() => undefined);
  await provider.goto(verificationUri!);
  await approve(provider, server, account, userCode);
  // A device that imported the secrets is cross-signed, so no device check opens.
  await settleSignIn(page, 'forbid', 90_000);
  await shared;
  const devices = await device.client.getDevices();
  const signedIn = devices.devices.find(
    (other) => !before.has(other.device_id),
  );
  expect(signedIn).toBeDefined();
  return signedIn!.device_id;
}

/** On a signed-in app device, open Settings › Devices › Link a new device. */
async function openLinkDevice(page: Page): Promise<void> {
  await openSettingsSection(page, 'devices');
  await page.getByTestId('link-device').click({ timeout: 30_000 });
}

/** Scan the new device's code with the existing one; both then show the same check code. */
async function scanToCheckCode(
  existing: Page,
  code: Locator,
  newDevice: Page,
): Promise<void> {
  await showOnCamera(existing, (await code.getAttribute('src'))!);
  await openLinkDevice(existing);
  const shown = existing.getByTestId('link-device-check-code');
  await expect(shown).toHaveText(/^\d{2}$/, { timeout: 60_000 });
  await expect(newDevice.getByTestId('qr-sign-in-check-code')).toHaveText(
    (await shown.textContent())!,
    { timeout: 30_000 },
  );
}

async function evidence(page: Page, name: string): Promise<void> {
  await test.info().attach(name, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}

test.describe('QR sign-in on an unsupported server', () => {
  test.skip(
    !session.available || session.kind !== 'tuwunel',
    'needs plain Tuwunel, which offers SSO and passwords but not MSC4108',
  );

  test('offers no QR sign-in', async ({ page }) => {
    // The login page reads auth_metadata twice: to choose the sign-in options, then for the
    // QR availability probe, which starts only once those options are on screen.
    let metadataReads = 0;
    const count = (request: { url(): string }) => {
      if (
        new URL(request.url()).pathname === '/_matrix/client/v1/auth_metadata'
      )
        metadataReads += 1;
    };
    page.on('requestfinished', count);
    page.on('requestfailed', count);
    await webNavigate(page, '/login');
    await fillLabeledInput(page, 'Homeserver', session.hs!);
    await page.getByText('Continue', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole('button', { name: 'Continue with SSO' }),
    ).toBeVisible();
    await expect.poll(() => metadataReads, { timeout: 30_000 }).toBe(2);
    // The probe's answer renders in the next frame or two.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page.getByTestId('qr-sign-in')).toHaveCount(0);
  });
});

for (const server of servers) {
  test.describe(`QR sign-in on ${server.kind}`, () => {
    let tlsPolicy: string | undefined;
    let device: ExistingDevice | undefined;

    test.beforeEach(() => {
      // The Node device's requests go to the stack's self-signed TLS.
      tlsPolicy = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    });

    test.afterEach(() => {
      device?.stop();
      device = undefined;
      if (tlsPolicy === undefined)
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = tlsPolicy;
    });

    /** A fresh account whose Node device links `page`, which can then link others. */
    async function signedInDevice(
      page: Page,
      request: APIRequestContext,
      authPlatform: AuthPlatform,
      prefix: string,
    ): Promise<{ account: QrAccount; deviceId: string }> {
      const account = await server.account(request, prefix);
      device = await ExistingDevice.signIn(account, server.kind);
      const approver = await authPlatform.openIsolatedPage();
      try {
        const deviceId = await linkFromNode(
          page,
          approver.page,
          device,
          server.kind,
          account,
        );
        return { account, deviceId };
      } finally {
        await approver.close();
      }
    }

    test('signs in verified by showing a code to a signed-in device', async ({
      page,
      request,
      authPlatform,
    }) => {
      test.setTimeout(240_000);
      const { deviceId } = await signedInDevice(
        page,
        request,
        authPlatform,
        'qr-new',
      );
      await expect
        .poll(() => device!.crossSigned(deviceId), { timeout: 30_000 })
        .toBe(true);
    });

    test('links a new device from Settings, which then reads earlier messages', async ({
      page,
      request,
      authPlatform,
      secondaryApp,
    }) => {
      test.setTimeout(420_000);
      await installSyntheticCamera(page);
      const { account } = await signedInDevice(
        page,
        request,
        authPlatform,
        'qr-link',
      );
      const room = `QR history ${testResourceId('room')}`;
      const message = `sent before the new device ${testResourceId('msg')}`;
      await device!.sendEncrypted(room, message);

      const newDevice = await secondaryApp.launch();
      const code = await showCode(newDevice, account.hs);
      await scanToCheckCode(page, code, newDevice);
      await evidence(page, 'existing-device-check-code');
      await evidence(newDevice, 'new-device-check-code');
      await page.getByRole('button', { name: 'They match' }).click();

      await expect(page.getByTestId('link-device-approval-link')).not.toBeEmpty(
        { timeout: 30_000 },
      );
      const userCode = await userCodeOn(newDevice);
      await evidence(page, 'existing-device-approve');
      const [provider] = await Promise.all([
        page.context().waitForEvent('page'),
        page.getByRole('button', { name: 'Open approval page' }).click(),
      ]);
      await provider.waitForLoadState('domcontentloaded');
      await approve(provider, server.kind, account, userCode);

      await expect(
        page.getByRole('heading', { name: 'Device linked' }),
      ).toBeVisible({ timeout: 90_000 });
      await evidence(page, 'existing-device-linked');
      // Both devices hold the account's identity, so the new one opens Rooms verified.
      await settleSignIn(newDevice, 'forbid', 90_000);
      await openNamedRoom(newDevice, room);
      await expect(
        newDevice.getByRole('article').getByText(message),
      ).toBeVisible({
        timeout: 60_000,
      });
      await evidence(newDevice, 'new-device-reads-history');
    });

    test('stops on both devices when the check codes differ', async ({
      page,
      request,
      authPlatform,
      secondaryApp,
    }) => {
      test.setTimeout(300_000);
      await installSyntheticCamera(page);
      const { account } = await signedInDevice(
        page,
        request,
        authPlatform,
        'qr-mismatch',
      );
      const newDevice = await secondaryApp.launch();
      await scanToCheckCode(
        page,
        await showCode(newDevice, account.hs),
        newDevice,
      );
      await page.getByRole('button', { name: "They don't match" }).click();

      await expect(page.getByRole('alert')).toHaveText(
        QR_SIGN_IN_FAILURE_MESSAGES.insecure,
        { timeout: 30_000 },
      );
      await evidence(page, 'existing-device-mismatch');
      // MSC4108 has no "insecure" message, so the existing device declines and ends the
      // session. The SDK sends that decline with a stale ETag, which the server refuses, so
      // the new device usually sees only the session end (accepted in Task 3).
      const either = [
        QR_SIGN_IN_FAILURE_MESSAGES.declined,
        QR_SIGN_IN_FAILURE_MESSAGES.unknown,
      ].map((message) => message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      await expect(newDevice.getByRole('alert')).toHaveText(
        new RegExp(`^\\s*(${either.join('|')})\\s*$`),
        { timeout: 30_000 },
      );
      await evidence(newDevice, 'new-device-mismatch');
      expect(new URL(newDevice.url()).pathname).toBe('/login');
    });

    test('replaces an expired code with one that works', async ({
      page,
      request,
      authPlatform,
      secondaryApp,
    }) => {
      test.setTimeout(360_000);
      await installSyntheticCamera(page);
      const { account } = await signedInDevice(
        page,
        request,
        authPlatform,
        'qr-expired',
      );
      const newDevice = await secondaryApp.launch();
      const code = await showCode(newDevice, account.hs);
      const expired = await code.getAttribute('src');
      // Both servers keep a rendezvous session for 60 s.
      await expect(newDevice.getByRole('alert')).toHaveText(
        QR_SIGN_IN_FAILURE_MESSAGES.expired,
        { timeout: 90_000 },
      );
      await evidence(newDevice, 'new-device-expired');
      await newDevice.getByTestId('qr-sign-in-retry').click();
      await expect(code).toBeVisible({ timeout: 30_000 });
      expect(await code.getAttribute('src')).not.toBe(expired);
      await scanToCheckCode(page, code, newDevice);
    });
  });
}
