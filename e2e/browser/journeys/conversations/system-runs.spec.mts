import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers #986 L7: the state burst of a new room collapses into one summary that expands in
// place. Needs a homeserver (Docker); self-skips.
const session = homeserverSession();

test.describe('System runs', () => {
  test.skip(!session.available, 'needs a homeserver (Docker)');

  test('a new room shows its setup lines as one expandable summary', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}s`;
    const user = `runs-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Runs ${runId}`;
    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();

    const toggle = page.getByTestId('system-run-toggle');
    await expect(toggle).toHaveCount(1, { timeout: 30_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('membership change');
    await expect(page.getByTestId('system-run-line')).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      await page.getByTestId('system-run-line').count(),
    ).toBeGreaterThanOrEqual(4);
    await expect(page.getByTestId('system-run-line').first()).toContainText(
      'created the room',
    );

    await toggle.click();
    await expect(page.getByTestId('system-run-line')).toHaveCount(0);
  });
});
