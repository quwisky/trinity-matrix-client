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
