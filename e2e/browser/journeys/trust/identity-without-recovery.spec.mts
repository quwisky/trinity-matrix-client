import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  defaultKeyId,
  masterKey,
  passwordLogin,
  registerUser,
} from '../../../support/account.mts';
import { publishIdentityWithoutRecovery } from '../../../support/cross-signing.mts';
import { closeSettings } from '../../../support/journeys/navigation.mts';

// MSC4153 brief, gap G3: an account whose cross-signing identity was published by another
// client, with no secret storage, used to read as "needs setup" — and setup there replaced
// the identity, cutting the user's other devices out of every strict sender's recipients.
// The account here gets that state for real, from a throwaway crypto machine, so the
// homeserver's master key is the proof that nothing was replaced.
// Needs a homeserver (Docker); self-skips.
const session = homeserverSession();

test.describe('An identity set up elsewhere without recovery', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('offers verification and never replaces the identity from setup', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}iw`;
    const user = `identity-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    await publishIdentityWithoutRecovery(request, hs, user, pass);
    const account = await passwordLogin(request, hs, user, pass);
    const identityBefore = await masterKey(request, hs, account);
    expect(identityBefore).toBeTruthy();
    expect(await defaultKeyId(request, hs, account)).toBeUndefined();

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as HomeserverSession);

    // The persistent prompt names the real situation and does not offer "Set up".
    const banner = page.locator('trn-encryption-banner trn-banner');
    await expect(banner).toContainText(
      'verify it with one of your other devices',
      { timeout: 30_000 },
    );
    await expect(banner.getByRole('button', { name: 'Set up' })).toHaveCount(0);
    await expect(
      banner.getByRole('button', { name: 'Verify with another device' }),
    ).toBeVisible();

    await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('security-needs-verification')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('security-setup')).toHaveCount(0);

    // The old path stays reachable by URL; it must refuse rather than reset.
    await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Set up encryption' }).click();
    await expect(
      page.locator('trn-encryption-setup [role="alert"]'),
    ).toContainText('already has encryption set up on another device', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('recovery-key')).toHaveCount(0);
    expect(await masterKey(request, hs, account)).toBe(identityBefore);
    expect(await defaultKeyId(request, hs, account)).toBeUndefined();
  });

  test('resets the identity only through the confirmed reset in Security', async ({
    page,
    request,
  }) => {
    // The explicit way out for someone who cannot use the device that holds the identity.
    // The account has no secret storage, so the reset starts from no previous recovery
    // key, and the page it runs on must not ask for one.
    test.slow();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ir`;
    const user = `identity-reset-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    await publishIdentityWithoutRecovery(request, hs, user, pass);
    const account = await passwordLogin(request, hs, user, pass);
    const identityBefore = await masterKey(request, hs, account);
    expect(identityBefore).toBeTruthy();
    expect(await defaultKeyId(request, hs, account)).toBeUndefined();

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as HomeserverSession);
    const banner = page.locator('trn-encryption-banner trn-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    // The banner offers nothing destructive here. This only guards against a regression:
    // it never offered a reset in this state, and its actions are unit-tested.
    await expect(banner.getByRole('button', { name: /reset/i })).toHaveCount(0);

    // With no other device to answer, the verify dialog the banner opens is the way on:
    // it leads to Security settings, which holds the confirmed reset (#1223). Settings
    // opens over the rooms shell, so the same app instance shows the banner going away
    // once the reset has finished.
    await banner
      .getByRole('button', { name: 'Verify with another device' })
      .click();
    const verify = page.getByRole('dialog', { name: 'Verify device' });
    await verify.getByTestId('verify-start').click();
    await expect(verify).toContainText('Waiting for your other device', {
      timeout: 30_000,
    });
    await expect(verify.getByRole('button', { name: /reset/i })).toHaveCount(0);
    await verify
      .getByRole('button', { name: 'Open Security settings' })
      .click();
    await expect(verify).toBeHidden();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    // Focus follows into Settings rather than falling back to the banner or the body.
    await expect(settings.locator(':focus')).toHaveCount(1);
    await page.getByTestId('security-reset-identity').click();

    // The door promised the reset, so the typed confirmation opens straight away.
    const gate = page.locator('trn-alert-dialog');
    await expect(gate).toContainText('Type RESET to confirm', {
      timeout: 30_000,
    });
    // Backing out leaves a page that tells the truth: there is no recovery key to enter.
    await gate.getByTestId('alert-cancel').click();
    await expect(gate).toBeHidden();
    await expect(page.getByTestId('reset-identity-intro')).toBeVisible();
    await expect(page.getByTestId('recovery-key-input')).toHaveCount(0);
    expect(await masterKey(request, hs, account)).toBe(identityBefore);

    await page.getByTestId('reset-identity').click();
    await expect(gate).toContainText('Type RESET to confirm', {
      timeout: 15_000,
    });
    await gate.locator('input').fill('RESET');
    await gate.getByTestId('alert-confirm').click();

    // Replacing a published identity always needs the password.
    await expect(gate).toContainText('Confirm your password', {
      timeout: 60_000,
    });
    await gate.locator('input[type="password"]').fill(pass);
    await gate.getByRole('button', { name: 'Confirm' }).click();

    const newKey = page.getByTestId('recovery-key');
    await expect(newKey).toBeVisible({ timeout: 60_000 });
    await page
      .getByRole('checkbox', { name: /I’ve saved my recovery key/ })
      .click();
    await page.getByTestId('reset-done').click();

    // A new identity, now backed by recovery, and the device trusts it.
    await expect
      .poll(() => defaultKeyId(request, hs, account), { timeout: 30_000 })
      .toBeTruthy();
    const identityAfter = await masterKey(request, hs, account);
    expect(identityAfter).toBeTruthy();
    expect(identityAfter).not.toBe(identityBefore);

    await expect(page.getByTestId('security-encryption')).toContainText(
      'Your messages are secured',
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('security-needs-verification')).toHaveCount(
      0,
    );
    await closeSettings(page);
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
  });
});
