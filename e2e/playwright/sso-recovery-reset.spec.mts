import { test, expect, type APIRequestContext } from '../fixtures.mts';
import { synapseSession, type SsoAccount } from '../support/app.mts';
import {
  keyBackupVersion,
  masterKey,
  type AccountSession,
} from '../support/account.mts';
import { ensureCrossSigning, ssoApiSession, ssoLogin } from './support/sso.mts';

// End-to-end for the half of the recovery-key reset (issue #43) that Trinity CANNOT
// perform: an account whose homeserver will not accept a password for the reset.
//
// The reset re-uploads the account's cross-signing keys, which Synapse gates behind
// user-interactive auth. An account created through an identity provider has no Matrix
// password, so the only stage the server offers is `m.login.sso` — a browser flow
// matrix-js-sdk cannot drive from inside the app. Trinity has to notice that and say so,
// rather than looping on a password prompt or surfacing a raw protocol error.
//
// This used to be unit-tested only, against a fabricated 401. It is now driven against a
// real password-less account, courtesy of the harness's Dex provider — see
// e2e/support/synapse/dex.yaml. Needs Docker; self-skips otherwise like the other web specs.
//
// It runs on `session.ssoReset`, NOT the general `session.sso`: everything it seeds is
// permanent (a cross-signing master key can be replaced but never removed, and a
// key-backup version outlives the run), and everything it asserts is that those did not
// change. Both only mean something on an account no other worker is signing into, and
// `fullyParallel` puts sso-login.spec.mts in a second worker against the same homeserver.
const session = synapseSession();

test.describe('Recovery reset on an SSO account', () => {
  test.skip(!session.available, 'needs the Synapse + Dex harness (Docker)');
  // Not part of the skip: the invocation owner fails before tests when the harness is missing
  // cannot report a green run, and start() cannot resolve without the sso block (it
  // waits on Dex's discovery document first). Gating the skip on it too would hand back
  // the silence that rule exists to prevent — so if it is ever absent, say so loudly.
  test.beforeAll(() => {
    if (session.available && !session.ssoReset) {
      throw new Error(
        'the harness came up without the reset SSO account; e2e/support/synapse/start.mjs should never allow this',
      );
    }
  });

  test('refuses the reset and points at the identity provider', async ({
    page,
    authPlatform,
    request,
  }) => {
    const hs = session.hs as string;
    const identity = session.ssoReset as SsoAccount;

    // Give the account a cross-signing identity if it has none; without one the server
    // waives UIA entirely and the reset would sail through, testing nothing.
    const account = await ssoApiSession(
      authPlatform,
      request,
      session,
      identity,
    );
    await ensureCrossSigning(request, hs, account);
    const masterKeyBefore = await masterKey(request, hs, account);
    expect(masterKeyBefore).toBeTruthy();

    // …and something to lose. `resetEncryption` deletes every key-backup version before
    // it reaches the upload that needs auth, so a reset that merely *reports* the failure
    // still costs the user their backup on the way past. That is what this pins.
    const backupBefore = await ensureKeyBackup(request, hs, account);
    expect(backupBefore).toBeTruthy();

    await ssoLogin(page, session, authPlatform, identity);
    await page.goto('/encryption/unlock', { waitUntil: 'domcontentloaded' });

    const resetButton = page.getByTestId('reset-recovery');
    await expect(resetButton).toBeVisible({ timeout: 30_000 });
    await resetButton.click();

    const gate = page.locator('trn-alert-dialog');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await gate.locator('input').fill('RESET');
    await gate.getByTestId('alert-confirm').click();

    // The assertion that matters. Three failures are distinguishable here, which is why
    // the copy is asserted rather than merely "some error":
    //  - prompting for a password the account does not have → no error ever appears;
    //  - surfacing the raw UiaUnsupportedError → "additional verification that Trinity
    //    can't complete here", a different string;
    //  - deep-linking to the provider → the other message, wrong for legacy SSO, where
    //    there is no account-management URL to deep-link to.
    await expect(page.getByTestId('unlock-error')).toContainText(
      'Your identity provider has to reset encryption for this account',
      { timeout: 60_000 },
    );

    // No new key was minted, and the user was never asked for a password.
    await expect(page.getByTestId('recovery-key')).toHaveCount(0);
    await expect(page.getByText('Confirm your password')).toHaveCount(0);

    // The two assertions that make this more than a copy check: the reset was refused
    // *before* it ran, not partway through. The message above appears either way — it is
    // only these that tell a clean refusal from an expensive one.
    expect(await masterKey(request, hs, account)).toBe(masterKeyBefore);
    expect(await keyBackupVersion(request, hs, account)).toBe(backupBefore);
  });
});

/**
 * Make sure the account has a key backup, creating an empty one if not.
 *
 * The public key is arbitrary — nothing here ever writes or reads a room key. What
 * matters is only that a version exists on the server for the reset to destroy, so its
 * survival means something. Idempotent, for the same retry reason as the cross-signing
 * seed.
 */
async function ensureKeyBackup(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
): Promise<string | undefined> {
  const existing = await keyBackupVersion(request, hs, account);
  if (existing) {
    return existing;
  }
  const res = await request.post(`${hs}/_matrix/client/v3/room_keys/version`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    data: {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: {
        public_key: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY',
      },
    },
  });
  if (!res.ok()) {
    throw new Error(`seeding key backup → ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).version as string;
}
