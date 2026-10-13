import { test, expect, type Page } from '../../../fixtures.mts';
import {
  homeserverSession,
  login,
  onDeviceCheck,
  waitForRooms,
  webNavigate,
} from '../../../support/app.mts';
import { masterKey, passwordLogin } from '../../../support/account.mts';
import {
  answerUiaIfAsked,
  freshAccount,
  setUpEncryption,
} from '../../support/encryption-journey.mts';

// MSC4153 decision 2: a new device of an account that has an identity is verified (the
// recovery key or another device) or the identity is reset before the app opens; removing
// the account is the other way out. These run the development build, whose check also
// offers the debug-only skip. Needs a homeserver; self-skips without one.
const session = homeserverSession();
const STAGE_TIMEOUT = 60_000;

/** The verification page's stage on this device, or null while none is shown. */
function stageOf(page: Page): Promise<string | null> {
  return page
    .getByTestId('verify-page')
    .first()
    .getAttribute('data-stage', { timeout: 1_000 })
    .catch(() => null);
}

async function waitForStage(
  page: Page,
  stages: readonly string[],
): Promise<void> {
  await expect
    .poll(() => stageOf(page), { timeout: STAGE_TIMEOUT, intervals: [500] })
    .toMatch(new RegExp(`^(${stages.join('|')})$`));
}

interface TrustReading {
  /** The encryption group's text says messages are secured: the banner has nothing to offer. */
  readonly ready: boolean;
  readonly backup: 'on' | 'off' | 'unavailable';
}

/**
 * The device's settled trust state, read from Security settings, which projects the same
 * `TrustService.status` as the encryption banner (it renders only for the `needs-*`
 * statuses, so `ready` means no banner). A count of zero on the banner is not evidence:
 * it is also what an unresolved `unknown` status renders. Security settings shows an
 * explicit "unavailable" while the status is unresolved, so wait for that to clear, then
 * give the key-backup row a bounded time to report, since the backup key can arrive after
 * verification finishes.
 */
async function settledTrust(page: Page): Promise<TrustReading> {
  await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('security-settings')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('security-encryption-unavailable')).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  const ready = await page
    .getByText('Your messages are secured with end-to-end encryption')
    .isVisible();
  const backup = page.getByTestId('security-backup');
  const reachedOn = await expect(backup)
    .toContainText('Your message keys are backed up', { timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  if (reachedOn) return { ready, backup: 'on' };
  const text = (await backup.innerText()).toLowerCase();
  return {
    ready,
    backup: text.includes('unavailable') ? 'unavailable' : 'off',
  };
}

test.describe('The new-device check', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('a new device opens only after the recovery key verifies it', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const { asSession, pass } = await freshAccount(
      request,
      session.hs as string,
      'dc-key',
    );
    await login(page, asSession);
    const recoveryKey = await setUpEncryption(page, pass);

    const deviceB = await secondaryApp.launch();
    await login(deviceB, asSession, webNavigate, 'expect');
    await expect(
      deviceB.getByRole('heading', { name: 'Verify it’s you' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      deviceB.getByTestId('device-confirmation-recovery-key'),
    ).toHaveText('Use recovery key');
    await expect(
      deviceB.getByTestId('device-confirmation-other-device'),
    ).toBeVisible();

    // Rooms stay closed while the check is open.
    await deviceB.goto('/rooms', { waitUntil: 'domcontentloaded' });
    await deviceB.waitForURL(onDeviceCheck, { timeout: 30_000 });
    await expect(
      deviceB.getByRole('heading', { name: 'Verify it’s you' }),
    ).toBeVisible({ timeout: 30_000 });
    // Still the check once the redirect has settled.
    await expect
      .poll(() => onDeviceCheck(new URL(deviceB.url())), { timeout: 5_000 })
      .toBe(true);

    await deviceB.getByTestId('device-confirmation-recovery-key').click();
    await deviceB.getByTestId('recovery-key-input').fill(recoveryKey);
    await deviceB.getByTestId('unlock-submit').click();
    await waitForRooms(deviceB, 60_000);
    // Entering the key restores the backup key too: wait for the settled state, not an
    // empty banner count.
    expect(await settledTrust(deviceB)).toEqual({ ready: true, backup: 'on' });
  });

  test('a new device opens after another signed-in device verifies it', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const { asSession, pass } = await freshAccount(
      request,
      session.hs as string,
      'dc-other',
    );
    await login(page, asSession);
    await setUpEncryption(page, pass);

    const deviceB = await secondaryApp.launch();
    await login(deviceB, asSession, webNavigate, 'expect');
    await deviceB.getByTestId('device-confirmation-other-device').click();
    await deviceB.waitForURL((url) => url.pathname === '/encryption/verify');
    await deviceB.getByTestId('verify-start').click();

    // Device A is asked whether the new session was you.
    await secondaryApp.activatePrimary();
    await waitForStage(page, ['requested']);
    await page.getByTestId('verify-accept').click();

    // Either side may start the emoji check once both are ready; start it once.
    await waitForStage(page, ['ready', 'waiting', 'sas-shown']);
    await waitForStage(deviceB, ['ready', 'waiting', 'sas-shown']);
    if (
      (await stageOf(page)) !== 'sas-shown' &&
      (await stageOf(deviceB)) !== 'sas-shown'
    ) {
      const starter = await Promise.race(
        [page, deviceB].map((device) =>
          device
            .getByTestId('verify-start-sas')
            .waitFor({ state: 'visible', timeout: STAGE_TIMEOUT })
            .then(
              () => device,
              () => null,
            ),
        ),
      );
      if (!starter) throw new Error('Neither device offered the emoji check.');
      await starter.getByTestId('verify-start-sas').click();
    }
    await waitForStage(page, ['sas-shown']);
    await waitForStage(deviceB, ['sas-shown']);
    await page.getByTestId('sas-match').click();
    await deviceB.getByTestId('sas-match').click();

    await waitForStage(deviceB, ['done']);
    await deviceB
      .getByTestId('verify-page')
      .getByRole('button', { name: 'Done' })
      .click();
    await waitForRooms(deviceB, 60_000);

    // Spec risk 2: either outcome is acceptable, so record the settled reading rather
    // than assert it.
    const trust = await settledTrust(deviceB);
    test.info().annotations.push({
      type: 'msc4153-risk-2',
      description:
        trust.ready && trust.backup === 'on'
          ? 'verifying delivered the backup key: no banner, key backup on'
          : `verifying did not deliver everything: encryption ${trust.ready ? 'ready' : 'still needs recovery (banner offers it)'}, key backup ${trust.backup}`,
    });
  });

  test('resetting the identity is the way out without a key or another device', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const { user, pass, asSession } = await freshAccount(
      request,
      hs,
      'dc-reset',
    );
    await login(page, asSession);
    await setUpEncryption(page, pass);
    const account = await passwordLogin(request, hs, user, pass);
    const identityBefore = await masterKey(request, hs, account);

    const deviceB = await secondaryApp.launch();
    await login(deviceB, asSession, webNavigate, 'expect');
    await deviceB.getByTestId('device-confirmation-reset').click();

    const gate = deviceB.locator('trn-alert-dialog');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await gate.locator('input').fill('RESET');
    await gate.getByTestId('alert-confirm').click();
    const newKey = deviceB.getByTestId('recovery-key');
    await answerUiaIfAsked(deviceB, pass, () =>
      newKey.waitFor({ state: 'visible', timeout: 30_000 }),
    );
    await expect(newKey).toBeVisible({ timeout: 60_000 });
    await deviceB
      .getByRole('checkbox', { name: /I’ve saved my recovery key/ })
      .click();
    await deviceB.getByTestId('reset-done').click();

    await waitForRooms(deviceB, 60_000);
    await expect
      .poll(() => masterKey(request, hs, account), { timeout: 30_000 })
      .not.toBe(identityBefore);
  });

  test('removing the account asks the account menu’s questions, and Export keys reaches Security', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const { asSession, pass } = await freshAccount(
      request,
      session.hs as string,
      'dc-remove',
    );
    await login(page, asSession);
    await setUpEncryption(page, pass);

    const deviceB = await secondaryApp.launch();
    await login(deviceB, asSession, webNavigate, 'expect');
    const consequences = deviceB.locator('trn-alert-dialog', {
      hasText: 'Remove this account from Trinity on this device?',
    });
    // This unverified device has no active key backup, so the room-key step offers the export.
    const keyStep = deviceB.locator('trn-alert-dialog', {
      hasText: 'Room keys are not backed up',
    });

    await deviceB.getByTestId('device-confirmation-remove').click();
    await consequences.getByTestId('alert-confirm').click();
    await keyStep.getByTestId('alert-alternative').click();
    // The export lives in Security settings, which the check lets through.
    await deviceB.waitForURL((url) => url.pathname === '/settings/security', {
      timeout: 30_000,
    });
    await expect(deviceB.getByTestId('security-settings')).toBeVisible({
      timeout: 30_000,
    });

    // Anywhere else returns to the check; this time remove the account.
    await deviceB.goto('/rooms', { waitUntil: 'domcontentloaded' });
    await deviceB.waitForURL(onDeviceCheck, { timeout: 30_000 });
    await deviceB.getByTestId('device-confirmation-remove').click();
    await consequences.getByTestId('alert-confirm').click();
    await keyStep.getByTestId('alert-confirm').click();
    await deviceB.waitForURL((url) => url.pathname === '/login', {
      timeout: 60_000,
    });
    // The removal persists: a reload still lands on the sign-in page.
    await deviceB.reload({ waitUntil: 'domcontentloaded' });
    await deviceB.waitForURL((url) => url.pathname === '/login', {
      timeout: 30_000,
    });
  });

  test('reopening the app does not skip the check', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const { asSession, pass } = await freshAccount(
      request,
      session.hs as string,
      'dc-reload',
    );
    await login(page, asSession);
    await setUpEncryption(page, pass);

    const deviceB = await secondaryApp.launch();
    await login(deviceB, asSession, webNavigate, 'expect');
    await deviceB.reload({ waitUntil: 'domcontentloaded' });
    await deviceB.waitForURL(onDeviceCheck, { timeout: 30_000 });
    await expect(
      deviceB.getByTestId('device-confirmation-recovery-key'),
    ).toBeVisible({ timeout: 30_000 });

    await deviceB.goto('/rooms', { waitUntil: 'domcontentloaded' });
    await deviceB.waitForURL(onDeviceCheck, { timeout: 30_000 });
    await expect(
      deviceB.getByTestId('device-confirmation-recovery-key'),
    ).toBeVisible({ timeout: 30_000 });
  });
});
