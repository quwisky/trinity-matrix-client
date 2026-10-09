import { expect } from '@wdio/globals';
import { login, tap } from '../support/app.mts';
import { registerUser, uniqueId } from '../support/matrix.mts';
import { resetApp } from '../support/session.mts';

async function openSettingsSection(section: string): Promise<void> {
  await tap('[data-testid="open-settings"]');
  await tap(`[data-testid="settings-nav-${section}"]`);
  await expect($('[data-testid="settings-detail"]')).toBeDisplayed({
    wait: 20_000,
  });
}

describe('mobile native capabilities', () => {
  beforeEach(resetApp);

  // Push delivery applies on iOS and Android (push-gateway-block); both offer the form.
  it('offers the push gateway form because the installed app has a push channel', async () => {
    const user = uniqueId('android-push');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsSection('notifications');

    await expect(
      $(
        '//*[self::h1 or self::h2 or self::h3][normalize-space()="Push gateway (this device)"]',
      ),
    ).toBeDisplayed({ wait: 15_000 });
    await expect($('[data-testid="push-gateway-url"]')).toBeDisplayed();
    await expect($('[data-testid="push-gateway-unsupported"]')).not.toExist();
  });

  it('withholds the raw settings document editor on the installed app', async () => {
    const user = uniqueId('android-advanced');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsSection('advanced');

    await expect(
      $('[data-testid="advanced-editing-unavailable"]'),
    ).toBeDisplayed({ wait: 15_000 });
    await expect($('[data-testid="advanced-config-editor"]')).not.toExist();
  });
});
