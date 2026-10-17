import { readFileSync } from 'node:fs';
import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  homeserverSession,
  login,
  seedPreference,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsFromRooms } from '../../../support/journeys/navigation.mts';
import {
  OLDER_VERSION,
  RELEASE_NOTES_FIXTURE,
} from '../../../support/write-release-notes-fixture.mts';

const session = homeserverSession();
const KEY = 'trinity.whats-new.last-seen-version';
// The bundled build's own version is the fixture's first (newest) note.
const [newest] = JSON.parse(readFileSync(RELEASE_NOTES_FIXTURE, 'utf8')) as {
  version: string;
}[];

test.describe("What's new", () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  async function signIn(page: Parameters<typeof login>[0]) {
    const id = testResourceId('wn');
    const user = `wn-${id}`;
    const pass = `wn-pass-${id}`;
    await registerUser(page.request, user, pass);
    await login(page, { ...session, user, pass });
  }

  test("shows What's new once after an update", async ({ page }) => {
    const id = testResourceId('wn');
    const user = `wn-${id}`;
    const pass = `wn-pass-${id}`;
    await registerUser(page.request, user, pass);
    await seedPreference(page, KEY, OLDER_VERSION);
    const dialog = page.getByTestId('whats-new-dialog');
    await page.goto('/login');
    await expect(page.getByLabel('Homeserver', { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    await login(page, { ...session, user, pass });
    await expect(dialog).toContainText("What's new in Trinity");
    await expect(
      dialog.getByRole('heading', {
        name: new RegExp(`^v${newest.version} · `),
      }),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // A fresh page shares the signed-in storage but not the seeding init script, which
    // would otherwise reset the last-seen version on every reload.
    // Trinity runs in one tab at a time, so close the first before opening the second.
    const context = page.context();
    await page.close();
    const reloaded = await context.newPage();
    await reloaded.goto('/');
    await expect(reloaded.getByTestId('open-settings')).toBeVisible();
    await expect(reloaded.getByTestId('whats-new-dialog')).toBeHidden();
  });

  test("reopens What's new from Settings", async ({ page }) => {
    await signIn(page);
    await openSettingsFromRooms(page);
    await page.getByTestId('settings-whats-new').click();
    await expect(page.getByTestId('whats-new-dialog')).toBeVisible();
  });
});
