import { test, expect, type APIRequestContext } from '@playwright/test';
import { synapseSession } from './support/app.mts';
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
// e2e/synapse/dex.yaml. Needs Docker; self-skips otherwise like the other web specs.
const session = synapseSession();

test.describe('Recovery reset on an SSO account', () => {
  test.skip(
    !session.available || !session.sso,
    'needs the Synapse + Dex harness (Docker)',
  );

  test('refuses the reset and points at the identity provider', async ({
    page,
    browser,
    request,
  }) => {
    const hs = session.hs as string;

    // Give the account a cross-signing identity if it has none; without one the server
    // waives UIA entirely and the reset would sail through, testing nothing.
    const account = await ssoApiSession(browser, request, session);
    await ensureCrossSigning(request, hs, account);
    const masterKeyBefore = await masterKey(request, hs, account);
    expect(masterKeyBefore).toBeTruthy();

    await ssoLogin(page, session);
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

    // …and the account's identity is the one it started with. A reset that half-ran and
    // replaced the cross-signing keys anyway would still show the message above.
    //
    // Note what is deliberately NOT asserted: `resetEncryption` deletes the server-side
    // key backups and secret storage *before* the upload that fails, so this account is
    // left worse off than it started. That is the SDK's ordering, it is a real defect,
    // and pinning it here would make the fix look like a regression.
    expect(await masterKey(request, hs, account)).toBe(masterKeyBefore);
  });
});

/** The account's cross-signing master key as the homeserver holds it. */
async function masterKey(
  request: APIRequestContext,
  hs: string,
  { userId, accessToken }: { userId: string; accessToken: string },
): Promise<string | undefined> {
  const res = await request.post(`${hs}/_matrix/client/v3/keys/query`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { device_keys: { [userId]: [] } },
  });
  const keys = (await res.json()).master_keys?.[userId]?.keys;
  return keys ? Object.keys(keys)[0] : undefined;
}
