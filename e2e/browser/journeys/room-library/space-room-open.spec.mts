import { testResourceId, test, expect } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { createRoom, linkChild } from '../../support/space-journey.mts';

// Covers issue #1369: with a space selected in the rail, opening one of its rooms from the
// sidebar — by click or by the Alt+↑/↓ list walk — keeps the space selected and its list in
// the sidebar. It used to switch the rail back to Recent activity.
//
// The reader has a space with two child rooms and one room outside it. Recent activity
// lists all three, so the outside room staying hidden proves the sidebar still shows the
// space. Two children make Alt+↓ land on the other child whatever the list order.
//
// Needs a disposable homeserver and self-skips otherwise.
const session = homeserverSession();

test.describe('Opening a room inside a space', () => {
  test.skip(!session.available, 'needs a disposable homeserver');

  test('keeps the space selected, by click and by the Alt+↓ list walk', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sp`;
    const user = `space-open-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const reader = await passwordLogin(request, hs, user, pass);

    const spaceName = `Team ${runId}`;
    const alpha = `Alpha ${runId}`;
    const bravo = `Bravo ${runId}`;
    const outside = `Outside ${runId}`;
    const spaceId = await createRoom(request, hs, reader, spaceName, {
      space: true,
    });
    for (const name of [alpha, bravo]) {
      const childId = await createRoom(request, hs, reader, name);
      await linkChild(request, hs, reader, spaceId, childId);
    }
    await createRoom(request, hs, reader, outside);

    await login(page, { available: true, hs, user, pass });

    // Recent activity is current on launch and lists the room outside the space too.
    const recent = page.getByTestId('rail-recent');
    const outsideRow = page.locator('.channel', { hasText: outside });
    await expect(recent).toHaveAttribute('aria-current', 'true', {
      timeout: 20_000,
    });
    await expect(outsideRow).toBeVisible({ timeout: 30_000 });

    const spacePill = page.getByRole('button', {
      name: spaceName,
      exact: true,
    });
    await spacePill.click();
    await expect(spacePill).toHaveAttribute('aria-current', 'true');

    const alphaRow = page.locator('.channel', { hasText: alpha });
    const bravoRow = page.locator('.channel', { hasText: bravo });
    await expect(alphaRow).toBeVisible({ timeout: 30_000 });
    await expect(bravoRow).toBeVisible();
    await expect(outsideRow).toHaveCount(0);

    const active = page.locator(
      'trn-channel-sidebar .channel.channel--selected',
    );
    const expectSpaceStillSelected = async (): Promise<void> => {
      await expect(spacePill).toHaveAttribute('aria-current', 'true');
      await expect(recent).not.toHaveAttribute('aria-current', 'true');
      await expect(alphaRow).toBeVisible();
      await expect(bravoRow).toBeVisible();
      await expect(outsideRow).toHaveCount(0);
    };

    // A click on one of the space's rooms opens it inside the space.
    await alphaRow.click();
    await expect(active).toHaveText(new RegExp(alpha), { timeout: 15_000 });
    await expectSpaceStillSelected();

    // So does the Alt+↓ walk, which steps to the space's other room.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(active).toHaveText(new RegExp(bravo), { timeout: 15_000 });
    await expectSpaceStillSelected();
  });
});
