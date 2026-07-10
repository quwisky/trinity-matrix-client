import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers changing your own account password from Settings → Account: the form
// (data-testid current-password/new-password/confirm-password → change-password)
// drives AuthService.changePassword, which satisfies the homeserver's UIA password
// stage with the supplied current password. A wrong current password surfaces an
// inline error; a correct one changes the password server-side (proven by logging
// in again with the new one). Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

/** Register a user via Synapse's shared-secret admin endpoint (idempotent). */
async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

/** The HTTP status a password login returns — 200 when the password is accepted. */
async function loginStatus(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<number> {
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  return res.status();
}

/** From /rooms, open Settings and drill into the Account section. */
async function openAccountSection(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-nav-account').click();
  await page.waitForURL(/\/settings\/account$/, { timeout: 20_000 });
  await expect(page.getByTestId('current-password')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Change password', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('rejects a wrong current password, then changes it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}p`;
    const user = `pw-user-${runId}`;
    const oldPass = `${user}-old-pass`;
    const newPass = `${user}-new-pass`;

    await registerUser(request, user, oldPass);
    await login(page, {
      available: true,
      hs,
      user,
      pass: oldPass,
    } as SynapseSession);
    await openAccountSection(page);

    // A wrong current password fails the UIA stage and surfaces an inline error —
    // the new password is left filled (the form is not cleared on failure).
    await page.getByTestId('current-password').fill('definitely-wrong-pass');
    await page.getByTestId('new-password').fill(newPass);
    await page.getByTestId('confirm-password').fill(newPass);
    await page.getByTestId('change-password').click();
    await expect(page.getByTestId('account-error')).toContainText(
      'current password is incorrect',
      { timeout: 20_000 },
    );

    // Correct the current password and submit again — success toast, form cleared.
    await page.getByTestId('current-password').fill(oldPass);
    await page.getByTestId('change-password').click();
    await expect(page.getByText('Password changed.')).toBeVisible({
      timeout: 20_000,
    });

    // The change persisted server-side: the new password logs in, the old no longer.
    await expect
      .poll(() => loginStatus(request, hs, user, newPass), { timeout: 20_000 })
      .toBe(200);
    expect(await loginStatus(request, hs, user, oldPass)).toBe(403);
  });
});
