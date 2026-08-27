import { test, expect, type APIRequestContext } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the global "Play a sound" switch (Settings → Notifications). The preference lives in
// ACCOUNT DATA, so the assertion is what the SERVER holds afterwards, read straight back —
// that is the claim worth testing: the choice follows the account rather than the window.
//
// It is deliberately NOT implemented by rewriting push rules. That was built first and
// measured against Synapse 1.119: `format: 'event_id_only'` (which Trinity uses to keep
// message content off the push gateway) makes Synapse blank the tweaks before dispatch, so a
// sound tweak never reaches the gateway — while REMOVING one demotes call and invite pushes
// from high to low priority, because those rules ship `highlight: false` and the sound tweak
// was the only thing keeping them urgent. It also could not be distinguished from Element's
// own "notify without a sound" state, so restoring would have overwritten it.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

/** The stored preference as the SERVER holds it, or undefined when never written. */
async function storedSound(
  request: APIRequestContext,
  hs: string,
  userId: string,
  token: string,
): Promise<{ enabled?: boolean } | undefined> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/eu.qwky.trinity.notification_sound`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return res.ok() ? ((await res.json()) as { enabled?: boolean }) : undefined;
}

test.describe('Notification sound', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('stores the choice on the account, and survives a reload', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}snd`;
    const user = `sound-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    const login1 = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const token = login1.access_token as string;
    const userId = login1.user_id as string;

    // Nothing stored to begin with: the app defaults to audible without writing anything.
    expect(await storedSound(request, hs, userId, token)).toBeUndefined();

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-notifications').click();
    await page.waitForURL(/\/settings\/notifications$/, { timeout: 20_000 });

    const sound = page.getByTestId('notif-sound');
    await expect(sound).toBeVisible({ timeout: 15_000 });
    const box = sound.locator('button, input').first();
    await expect(box).toHaveAttribute('aria-checked', 'true');

    await sound.click();

    // Written to the SERVER, not just to this window.
    await expect
      .poll(
        async () => (await storedSound(request, hs, userId, token))?.enabled,
        { timeout: 30_000 },
      )
      .toBe(false);

    // And it is what the app shows after a reload — the setting is state, not a toggle
    // that only lived in the page that set it.
    await page.reload();
    await page.waitForURL(/\/settings\/notifications$/, { timeout: 20_000 });
    await expect(
      page.getByTestId('notif-sound').locator('button, input').first(),
    ).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });

    // Back on again.
    await page.getByTestId('notif-sound').click();
    await expect
      .poll(
        async () => (await storedSound(request, hs, userId, token))?.enabled,
        { timeout: 30_000 },
      )
      .toBe(true);
  });
});
