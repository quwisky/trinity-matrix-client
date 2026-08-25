import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers composer slash commands (TimelineService.send → slashCommandContent):
// /shrug appends the kaomoji, and /plain sends its argument literally (no markdown).
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Slash commands', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('/shrug appends the kaomoji and /plain keeps markdown literal', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sc`;
    const user = `slash-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Slash ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);
    const composer = page.getByTestId('composer-input');

    // /shrug appends the kaomoji.
    await composer.fill('/shrug oh well');
    await composer.press('Enter');
    await expect(
      page.locator('.msg__text', { hasText: 'oh well ¯\\_(ツ)_/¯' }),
    ).toBeVisible({ timeout: 20_000 });

    // /plain sends its argument literally — the `**` are not rendered as bold.
    await composer.fill('/plain **not bold**');
    await composer.press('Enter');
    await expect(
      page.locator('.msg__text', { hasText: '**not bold**' }),
    ).toBeVisible({ timeout: 20_000 });

    // The autocomplete: a bare `/` offers every command, typing narrows it, and Enter
    // completes the name instead of sending — the message only goes once the argument is
    // there. Driven by the keyboard because that is the path the menu exists to serve.
    const menu = page.getByTestId('slash-autocomplete');
    await composer.fill('/');
    await expect(menu).toBeVisible();
    const all = await menu.getByRole('option').count();
    expect(all).toBeGreaterThan(1);

    await composer.fill('/m');
    await expect(menu.getByRole('option')).toHaveCount(1);
    await expect(menu.getByRole('option').first()).toContainText('/me');

    await composer.press('Enter');
    await expect(menu).toBeHidden();
    await expect(composer).toHaveValue('/me ');

    await composer.pressSequentially('waves');
    await composer.press('Enter');
    // An emote renders as ordinary message text, so what this proves is that the completed
    // command sent at all — and sent as `/me waves`, not as the literal string.
    await expect(
      page.locator('.msg__text', { hasText: 'waves' }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.msg__text', { hasText: '/me' })).toHaveCount(0);
  });
});
