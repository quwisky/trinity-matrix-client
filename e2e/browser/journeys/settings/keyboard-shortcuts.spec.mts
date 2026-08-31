import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Covers the "Keyboard shortcuts" settings section (issue #13): the list is reachable from
// Settings, a rebound chord takes effect (the new chord switches rooms, the old one no
// longer does), the custom binding persists across a reload, and "Reset all to defaults"
// brings the original binding back. Exercises the registry end to end via the hop shortcut.
//
// Needs a Synapse homeserver (Docker); self-skips otherwise. CI is Linux → Control.
const session = synapseSession();

test.describe('Keyboard shortcuts settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('rebinds the hop shortcut, persists it, and resets to default', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ks`;
    const user = `shortcuts-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const a = `Alpha ${runId}`;
    const b = `Bravo ${runId}`;
    for (const name of [a, b]) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name, preset: 'private_chat' },
      });
    }

    await login(page, { available: true, hs, user, pass } as SynapseSession);

    const active = page.locator('trn-channel-sidebar .channel.active');
    const open = async (name: string): Promise<void> => {
      await page.locator('.channel', { hasText: name }).first().click();
      await expect(active).toHaveText(new RegExp(name), { timeout: 15_000 });
    };

    // Open Settings → Keyboard shortcuts and rebind "Hop to the previous room" to Alt+J.
    await openSettingsSection(page, 'shortcuts');
    const hopRow = page.getByTestId('shortcut-room.hop.back');
    await expect(hopRow).toContainText('Hop to the previous room');
    await page.getByTestId('shortcut-edit-room.hop.back').click();
    await expect(page.getByTestId('capture-hint')).toBeVisible();
    await page.keyboard.press('Alt+J');
    // The row now shows the new binding.
    await expect(hopRow.getByTestId('shortcut-binding')).toContainText('Alt');

    // Back to the rooms; visit A then B, so the previous room is A.
    await page.goto('/rooms');
    await open(a);
    await open(b);

    // The old chord (Ctrl+') no longer hops; the new one (Alt+J) does.
    await page.keyboard.press("Control+'");
    await expect(active).toHaveText(new RegExp(b)); // unchanged
    await page.keyboard.press('Alt+J');
    await expect(active).toHaveText(new RegExp(a), { timeout: 10_000 });

    // The custom binding survives a reload (persisted in Preferences).
    await page.reload();
    await open(b);
    await open(a);
    await page.keyboard.press('Alt+J');
    await expect(active).toHaveText(new RegExp(b), { timeout: 10_000 });

    // Reset all restores the default chord.
    await openSettingsSection(page, 'shortcuts');
    await page.getByTestId('shortcuts-reset-all').click();
    await page.getByTestId('alert-confirm').click();
    await expect(hopRow.getByTestId('shortcut-binding')).toContainText(
      'Ctrl/Cmd',
    );

    await page.goto('/rooms');
    await open(a);
    await open(b);
    await page.keyboard.press("Control+'"); // the default hop works again
    await expect(active).toHaveText(new RegExp(a), { timeout: 10_000 });
  });
});
