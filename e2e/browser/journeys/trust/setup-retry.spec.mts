import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  waitForRooms,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  masterKey,
  passwordLogin,
  registerUser,
} from '../../../support/account.mts';

// Issue #1225: a first encryption setup that is abandoned at the password prompt has
// already created the cross-signing keys on the device. Retrying used to find them,
// upload nothing, and put the unpublished keys into a new secret storage: the device
// read as set up while the homeserver had no identity, so the recovery key could not
// restore anything elsewhere. The homeserver's master key is the proof here.
// Needs a homeserver; self-skips.
const session = homeserverSession();

const DEVICE_SIGNING_UPLOAD = '**/_matrix/client/v3/keys/device_signing/upload';

function passwordPrompt(page: Page) {
  return page.locator('trn-alert-dialog', { hasText: 'Confirm your password' });
}

async function signInFreshAccount(
  page: Page,
  request: Parameters<typeof registerUser>[0],
  suffix: string,
) {
  const hs = session.hs as string;
  const user = `setup-retry-${testResourceId('run')}${suffix}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const account = await passwordLogin(request, hs, user, pass);
  await login(page, { available: true, hs, user, pass } as HomeserverSession);
  return { hs, user, pass, account };
}

async function startSetup(page: Page): Promise<void> {
  await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up encryption' }).click();
}

/**
 * Finish a started setup, answering the password prompt if the server asks. Returns the
 * recovery key it showed.
 */
async function completeSetup(page: Page, password: string): Promise<string> {
  const key = page.getByTestId('recovery-key');
  const prompt = passwordPrompt(page);
  const first = await Promise.race([
    key.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'key'),
    prompt.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'uia'),
  ]);
  if (first === 'uia') {
    await prompt.locator('input[type="password"]').fill(password);
    await prompt.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(key).toBeVisible({ timeout: 60_000 });
  const recoveryKey = (await key.innerText()).trim();
  await page
    .getByRole('checkbox', { name: /I’ve saved my recovery key/ })
    .click();
  await page.getByRole('button', { name: 'Continue to Trinity' }).click();
  await waitForRooms(page);
  return recoveryKey;
}

/** Sign in as a second device and unlock it with the recovery key. */
async function unlockSecondDevice(
  page: Page,
  account: { hs: string; user: string; pass: string },
  recoveryKey: string,
): Promise<void> {
  await login(page, { available: true, ...account } as HomeserverSession);
  await page.goto('/encryption/unlock', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('recovery-key-input').fill(recoveryKey);
  await page.getByTestId('unlock-submit').click();
  await waitForRooms(page, 60_000);
  await expect(page.getByTestId('unlock-error')).toHaveCount(0);
  await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('security-encryption')).toContainText(
    'Your messages are secured',
    { timeout: 30_000 },
  );
}

/**
 * Answer the first device-signing upload with a password challenge, as a homeserver
 * that requires UIA for it does. Synapse skips UIA for the first upload (MSC3967), so
 * without this its users never see the prompt the issue is about. A request carrying
 * `auth` is refused as a wrong password when `wrongPassword` is set, and otherwise
 * reaches the server. Returns how many uploads the route answered.
 */
async function challengeDeviceSigningUpload(
  page: Page,
  wrongPassword: boolean,
): Promise<() => number> {
  let answered = 0;
  const challenge = {
    session: 'trinity-e2e-uia',
    flows: [{ stages: ['m.login.password'] }],
    params: {},
  };
  await page.route(DEVICE_SIGNING_UPLOAD, async (route) => {
    const body = route.request().postDataJSON() as { auth?: unknown } | null;
    answered += 1;
    if (!body?.auth) {
      await route.fulfill({ status: 401, json: challenge });
      return;
    }
    if (wrongPassword) {
      await route.fulfill({
        status: 401,
        json: {
          ...challenge,
          errcode: 'M_FORBIDDEN',
          error: 'Invalid username or password',
        },
      });
      return;
    }
    await route.fallback();
  });
  return () => answered;
}

test.describe('A first setup retried after an abandoned password prompt', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('publishes the identity after a cancelled prompt', async ({
    page,
    request,
    secondaryApp,
  }) => {
    test.slow();
    const { hs, user, pass, account } = await signInFreshAccount(
      page,
      request,
      'c',
    );

    await challengeDeviceSigningUpload(page, false);
    await startSetup(page);
    const prompt = passwordPrompt(page);
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
    expect(await masterKey(request, hs, account)).toBeUndefined();

    await page.unroute(DEVICE_SIGNING_UPLOAD);
    await startSetup(page);
    const recoveryKey = await completeSetup(page, pass);

    await expect
      .poll(() => masterKey(request, hs, account), { timeout: 30_000 })
      .toBeTruthy();
    // The point of the identity being on the server: the key restores elsewhere.
    await unlockSecondDevice(
      await secondaryApp.launch(),
      { hs, user, pass },
      recoveryKey,
    );
  });

  test('publishes the identity after a wrong password', async ({
    page,
    request,
  }) => {
    test.slow();
    const { hs, pass, account } = await signInFreshAccount(page, request, 'w');

    const uploads = await challengeDeviceSigningUpload(page, true);
    await startSetup(page);
    const prompt = passwordPrompt(page);
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.locator('input[type="password"]').fill(`${pass}-wrong`);
    await prompt.getByRole('button', { name: 'Confirm' }).click();
    // A wrong password asks again inside the same setup; giving up there fails it.
    await expect.poll(uploads, { timeout: 30_000 }).toBe(2);
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
    expect(await masterKey(request, hs, account)).toBeUndefined();

    await page.unroute(DEVICE_SIGNING_UPLOAD);
    await startSetup(page);
    await completeSetup(page, pass);

    await expect
      .poll(() => masterKey(request, hs, account), { timeout: 30_000 })
      .toBeTruthy();
  });

  test('publishes the identity after the upload failed', async ({
    page,
    request,
  }) => {
    test.slow();
    // Synapse and Tuwunel skip UIA on the first upload (MSC3967), so on them the same
    // state comes from an upload that never reaches the server.
    const { hs, pass, account } = await signInFreshAccount(page, request, 'n');

    await page.route(DEVICE_SIGNING_UPLOAD, (route) => route.abort('failed'));
    await startSetup(page);
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    expect(await masterKey(request, hs, account)).toBeUndefined();

    await page.unroute(DEVICE_SIGNING_UPLOAD);
    await startSetup(page);
    await completeSetup(page, pass);

    await expect
      .poll(() => masterKey(request, hs, account), { timeout: 30_000 })
      .toBeTruthy();
  });
});
