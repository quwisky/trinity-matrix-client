import { test, expect, type Page } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import {
  defaultKeyId,
  keyBackupVersion,
  masterKey,
  passwordLogin,
  registerUser,
} from './support/account.mts';

// End-to-end for the recovery-key reset (issue #43): the escape hatch for someone who has
// lost their recovery key and has no other verified device.
//
// The reset throws the account's cross-signing identity and secret storage away, deletes
// every server-side key backup, and mints a new recovery key. That is irreversible — which
// is exactly why it is worth driving against a real homeserver rather than a mock, and why
// the account here is a throwaway registered per run.
//
// Needs a Synapse homeserver (Docker); self-skips otherwise like the other web specs.
const session = synapseSession();

/** Answer the device-signing UIA prompt if the server asks for it. */
async function answerUiaIfAsked(
  page: Page,
  password: string,
  settled: () => Promise<unknown>,
): Promise<void> {
  // Scoped by its own copy, not just the element: the confirmation gate is the same
  // component and may still be detaching when this is called, which would either match
  // the wrong dialog (and time out filling a text input as a password) or trip strict
  // mode with two of them on screen.
  const uia = page.locator('trn-alert-dialog', {
    hasText: 'Confirm your password',
  });
  const outcome = await Promise.race([
    uia
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'uia')
      .catch(() => null),
    settled()
      .then(() => 'done')
      .catch(() => null),
  ]);
  if (outcome === 'uia') {
    await uia.locator('input[type="password"]').fill(password);
    await uia.getByRole('button', { name: 'Confirm' }).click();
  }
}

/**
 * Bootstrap cross-signing + recovery on this device, so there is something to reset.
 * Returns the recovery key it minted, so the test can prove the reset replaces it.
 */
async function setUpEncryption(page: Page, password: string): Promise<string> {
  await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up encryption' }).click();
  const key = page.getByTestId('recovery-key');
  await answerUiaIfAsked(page, password, () =>
    key.waitFor({ state: 'visible', timeout: 30_000 }),
  );
  await key.waitFor({ state: 'visible', timeout: 60_000 });
  const original = (await key.innerText()).trim();
  await page
    .getByRole('checkbox', { name: /I've saved my recovery key/ })
    .click();
  await page.getByRole('button', { name: 'Continue to Trinity' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
  return original;
}

test.describe('Recovery reset', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('mints a new recovery key for someone who lost theirs', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}r`;
    const user = `reset-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    const account = await passwordLogin(request, hs, user, pass);
    /** The account's 4S default key pointer — absent means no usable recovery key. */
    const currentKeyId = () => defaultKeyId(request, hs, account);

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession);

    const originalKey = await setUpEncryption(page, pass);
    expect(originalKey.length).toBeGreaterThan(0);
    const keyIdBefore = await currentKeyId();
    expect(keyIdBefore).toBeTruthy();

    await page.goto('/encryption/unlock', { waitUntil: 'domcontentloaded' });

    const resetButton = page.getByTestId('reset-recovery');
    await expect(resetButton).toBeVisible({ timeout: 30_000 });
    await resetButton.click();

    // The gate: a wrong word must abort. Nothing should be reset by this.
    const gate = page.locator('trn-alert-dialog');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await expect(gate).toContainText('backup on the server is deleted');

    // The consequences must arrive as separate lines. HTML collapses newlines unless the
    // paragraph says otherwise, and `innerText` reflects what actually rendered — so this
    // fails if the three points run together into one sentence, which on the last screen
    // before an irreversible deletion is the same as not being read at all.
    const spelledOut = await gate.locator('p').first().innerText();
    expect(
      spelledOut.split('\n').filter((line) => line.trim().length > 0),
    ).toHaveLength(4);
    // …and it has to say which word, since the placeholder vanishes on the first keystroke.
    expect(spelledOut).toContain('Type RESET to confirm');

    await gate.locator('input').fill('yes please');
    await gate.getByTestId('alert-confirm').click();
    // Not `expect(recovery-key).toHaveCount(0)` — that locator is already absent, so it
    // holds however the click was handled. The account's own 4S pointer is the proof: a
    // reset that ran would replace it within seconds.
    await expect(gate).toBeHidden();
    await expect(resetButton).toBeEnabled();
    expect(await currentKeyId()).toBe(keyIdBefore);
    // Silence would be indistinguishable from a broken button.
    await expect(page.getByTestId('unlock-error')).toContainText('RESET');

    // Now confirm properly.
    await resetButton.click();
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await gate.locator('input').fill('RESET');
    await gate.getByTestId('alert-confirm').click();

    const newKey = page.getByTestId('recovery-key');
    await answerUiaIfAsked(page, pass, () =>
      newKey.waitFor({ state: 'visible', timeout: 30_000 }),
    );
    await expect(newKey).toBeVisible({ timeout: 60_000 });
    // The assertion that matters: a DIFFERENT key, not merely a key on screen. A reset
    // that quietly re-showed the old one would look identical to a working one.
    const shown = (await newKey.innerText()).trim();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toBe(originalKey);

    // Done stays disabled until the user says they have saved it — the key is shown once.
    const done = page.getByTestId('reset-done');
    await expect(done).toBeDisabled();
    await page
      .getByRole('checkbox', { name: /I've saved my recovery key/ })
      .click();
    await expect(done).toBeEnabled();
    await done.click();

    // The assertion that proves the reset FINISHED rather than merely started.
    //
    // `resetEncryption` deletes secret storage and does not put the new backup key
    // anywhere reachable; only the follow-up bootstrap creates a fresh 4S. This is not
    // observable from THIS device's status — it keeps the cross-signing keys locally, so
    // the posture reads `ready` either way — and it is not observable from the key on
    // screen, which is minted before the bootstrap. The server's default-key pointer is
    // the only place the difference shows, and a NEW id proves 4S was rebuilt rather than
    // merely left over.
    await expect.poll(currentKeyId, { timeout: 30_000 }).toBeTruthy();
    expect(await currentKeyId()).not.toBe(keyIdBefore);

    await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('security-encryption')).toContainText(
      'Your messages are secured',
      { timeout: 30_000 },
    );
    // The ready branch is the only one with no call to action.
    await expect(page.getByTestId('security-unlock')).toHaveCount(0);
    await expect(page.getByTestId('security-setup')).toHaveCount(0);
  });

  test('a cancelled password costs the account nothing', async ({
    page,
    request,
  }) => {
    // The reset used to delete every key-backup version and all of secret storage BEFORE
    // it asked for the password — so pressing Cancel here left the account with no
    // backup, no new key, and nothing to show for it. Measured, then fixed by doing the
    // authenticated step first. This is the spec that stops it coming back.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}c`;
    const user = `reset-cancel-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    const account = await passwordLogin(request, hs, user, pass);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await setUpEncryption(page, pass);

    const keyIdBefore = await defaultKeyId(request, hs, account);
    const versionBefore = await keyBackupVersion(request, hs, account);
    expect(keyIdBefore).toBeTruthy();
    expect(versionBefore).toBeTruthy();

    await page.goto('/encryption/unlock', { waitUntil: 'domcontentloaded' });
    const resetButton = page.getByTestId('reset-recovery');
    await expect(resetButton).toBeVisible({ timeout: 30_000 });
    await resetButton.click();

    const gate = page.locator('trn-alert-dialog');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await gate.locator('input').fill('RESET');
    await gate.getByTestId('alert-confirm').click();

    // …and now refuse at the password, which is the whole point.
    await expect(gate).toContainText('Confirm your password', {
      timeout: 60_000,
    });
    await gate.getByTestId('alert-cancel').click();

    await expect(page.getByTestId('recovery-key')).toHaveCount(0);
    await expect(resetButton).toBeEnabled({ timeout: 30_000 });

    // The two assertions that matter. Both were destroyed before this fix.
    expect(await keyBackupVersion(request, hs, account)).toBe(versionBefore);
    expect(await defaultKeyId(request, hs, account)).toBe(keyIdBefore);

    // And the device is left exactly as it was found. This assertion used to require the
    // opposite — that the device now needed unlocking — because the reset rotated the
    // local cross-signing identity on its way to asking for the password, so refusing
    // stranded this device even when the account survived. Authenticating first removes
    // that step from the refusal path entirely: there is nothing to re-seat, because
    // nothing was ever rotated. "Costs the account nothing" now includes the device.
    await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('security-encryption')).toContainText(
      'Your messages are secured',
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('security-unlock')).toHaveCount(0);
    await expect(page.getByTestId('security-setup')).toHaveCount(0);
  });

  test('leaves the original recovery key working after a cancelled reset', async ({
    page,
    request,
  }) => {
    // The most expensive way to get this wrong, and the one no server-side assertion can
    // see. Leaving the account's stored state untouched is only half of an abort: what
    // the user actually has is the key, and the thing that must still be true is that it
    // opens the lock. Nothing says otherwise until they try it, possibly weeks later when
    // they finally find the key they thought they had lost — so the round trip through
    // the real unlock path is the assertion, not the server-side values alone.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}f`;
    const user = `reset-found-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    const account = await passwordLogin(request, hs, user, pass);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const originalKey = await setUpEncryption(page, pass);
    expect(originalKey.length).toBeGreaterThan(0);

    const keyIdBefore = await defaultKeyId(request, hs, account);
    const versionBefore = await keyBackupVersion(request, hs, account);
    const masterBefore = await masterKey(request, hs, account);
    expect(keyIdBefore).toBeTruthy();
    expect(versionBefore).toBeTruthy();
    expect(masterBefore).toBeTruthy();

    await page.goto('/encryption/unlock', { waitUntil: 'domcontentloaded' });
    const resetButton = page.getByTestId('reset-recovery');
    await expect(resetButton).toBeVisible({ timeout: 30_000 });
    await resetButton.click();

    const gate = page.locator('trn-alert-dialog');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await gate.locator('input').fill('RESET');
    await gate.getByTestId('alert-confirm').click();

    await expect(gate).toContainText('Confirm your password', {
      timeout: 60_000,
    });
    await gate.getByTestId('alert-cancel').click();
    await expect(resetButton).toBeEnabled({ timeout: 30_000 });

    // …and then they find the key they thought was gone.
    await page.getByTestId('recovery-key-input').fill(originalKey);
    await page.getByTestId('unlock-submit').click();

    // Leaving the unlock screen for the app is what success looks like: the page only
    // navigates once `recoverWithKey` has resolved, and an error would keep it here with
    // `unlock-error` filled in instead.
    await page.waitForURL('**/rooms', { timeout: 60_000 });
    await expect(page.getByTestId('unlock-error')).toHaveCount(0);

    // The device is trusted again, by the app's own account of itself.
    await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('security-encryption')).toContainText(
      'Your messages are secured',
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('security-unlock')).toHaveCount(0);
    await expect(page.getByTestId('security-setup')).toHaveCount(0);

    // …and it got there by re-using the account's existing identity, not by quietly
    // minting a replacement. All three would move if the abort had let the reset through.
    expect(await masterKey(request, hs, account)).toBe(masterBefore);
    expect(await keyBackupVersion(request, hs, account)).toBe(versionBefore);
    expect(await defaultKeyId(request, hs, account)).toBe(keyIdBefore);
  });

  test('Settings offers the escape hatch to someone who cannot unlock', async ({
    page,
    secondaryApp,
    request,
  }) => {
    // The door the changelog promises. It only exists in the `needs-recovery` state — an
    // account that HAS secret storage on a device that cannot open it — so this needs a
    // second, unverified device rather than the one that just set encryption up.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}d`;
    const user = `reset-door-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    const credentials = {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession;

    await login(page, credentials);
    await setUpEncryption(page, pass);

    // A second device: same account, no recovery key, so it lands on needs-recovery.
    const fresh = await secondaryApp.launch();
    await login(fresh, credentials);
    await fresh.goto('/settings/security', { waitUntil: 'domcontentloaded' });

    const lost = fresh.getByTestId('security-reset-recovery');
    await expect(lost).toBeVisible({ timeout: 30_000 });
    // It sits beside "Enter recovery key" rather than replacing it: someone who still
    // has their key must not be nudged towards the destructive path.
    await expect(fresh.getByTestId('security-unlock')).toBeVisible();

    await lost.click();

    // One implementation of the irreversible flow, two doors — and this door has to
    // arrive with the reset actually offered. Landing on "Enter your recovery key" and
    // asking the user to find the same words a second time is not a second door.
    const gate = fresh.locator('trn-alert-dialog');
    await expect(gate).toBeVisible({ timeout: 30_000 });
    await expect(gate).toContainText('Type RESET to confirm');

    // …and backing out of it leaves them on the screen that owns the flow.
    await gate.getByTestId('alert-cancel').click();
    await expect(fresh.getByTestId('reset-recovery')).toBeVisible();
  });
});
