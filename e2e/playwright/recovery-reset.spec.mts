import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

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

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

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

/** Answer the device-signing UIA prompt if the server asks for it. */
async function answerUiaIfAsked(
  page: Page,
  password: string,
  settled: () => Promise<unknown>,
): Promise<void> {
  const uia = page.locator('trn-alert-dialog');
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
    const auth = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const headers = { Authorization: `Bearer ${auth.access_token}` };
    /** The account's 4S default key pointer — absent means no usable recovery key. */
    const defaultKeyId = async (): Promise<string | undefined> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/user/${encodeURIComponent(auth.user_id)}/account_data/m.secret_storage.default_key`,
        { headers },
      );
      return res.ok() ? ((await res.json()).key as string) : undefined;
    };

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession);

    const originalKey = await setUpEncryption(page, pass);
    expect(originalKey.length).toBeGreaterThan(0);
    const keyIdBefore = await defaultKeyId();
    expect(keyIdBefore).toBeTruthy();

    await page.goto('/encryption/unlock', { waitUntil: 'domcontentloaded' });

    const resetButton = page.getByTestId('reset-recovery');
    await expect(resetButton).toBeVisible({ timeout: 30_000 });
    await resetButton.click();

    // The gate: a wrong word must abort. Nothing should be reset by this.
    const gate = page.locator('trn-alert-dialog');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await expect(gate).toContainText('backup on the server is deleted');
    await gate.locator('input').fill('yes please');
    await gate.getByTestId('alert-confirm').click();
    await expect(page.getByTestId('recovery-key')).toHaveCount(0);

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
      .getByRole('checkbox', { name: /I've saved my new recovery key/ })
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
    await expect.poll(defaultKeyId, { timeout: 30_000 }).toBeTruthy();
    expect(await defaultKeyId()).not.toBe(keyIdBefore);

    await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('security-encryption')).toContainText(
      'Your messages are secured',
      { timeout: 30_000 },
    );
    // The ready branch is the only one with no call to action.
    await expect(page.getByTestId('security-unlock')).toHaveCount(0);
    await expect(page.getByTestId('security-setup')).toHaveCount(0);
  });
});
