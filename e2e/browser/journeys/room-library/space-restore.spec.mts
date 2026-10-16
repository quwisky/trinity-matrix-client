import { testResourceId, test, expect } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import {
  createRoom,
  linkChild,
  serverNameOf,
  urlSegment,
} from '../../support/space-journey.mts';
import { holdSync, waitForPersistedSync } from '../../support/sync-cache.mts';

// Covers issue #1401: a reload restores the URL before the account's sync has replayed, so a
// space the cache does not hold yet used to read as gone. The restore fell back to Recent
// activity and dropped the open room with it. A space the account has not synced is now
// kept, shown as loading, and checked again once the account has synced with its homeserver.
//
// Needs a disposable homeserver and self-skips otherwise.
const session = homeserverSession();

test.describe('Restoring a space', () => {
  test.skip(!session.available, 'needs a disposable homeserver');

  test('a reload keeps a space joined since the sync cache, with its room open', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sr`;
    const user = `space-restore-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const reader = await passwordLogin(request, hs, user, pass);
    const outside = `Outside ${runId}`;
    await createRoom(request, hs, reader, outside);

    await login(page, { available: true, hs, user, pass });
    const outsideRow = page.locator('trn-channel-sidebar .channel', {
      hasText: outside,
    });
    await expect(outsideRow).toBeVisible({ timeout: 30_000 });
    // The cache a reload replays is saved now, before the space exists, and not again for
    // five minutes.
    await waitForPersistedSync(page, user);

    const spaceName = `Team ${runId}`;
    const alpha = `Alpha ${runId}`;
    const bravo = `Bravo ${runId}`;
    const spaceId = await createRoom(request, hs, reader, spaceName, {
      space: true,
    });
    for (const name of [alpha, bravo]) {
      await linkChild(
        request,
        hs,
        reader,
        spaceId,
        await createRoom(request, hs, reader, name),
      );
    }

    const spacePill = page
      .locator('trn-server-rail')
      .getByRole('button', { name: spaceName, exact: true });
    const recent = page.getByTestId('rail-recent');
    const row = (name: string) =>
      page.locator('trn-channel-sidebar .channel', { hasText: name });
    const selected = page.locator(
      'trn-channel-sidebar .channel.channel--selected',
    );
    const title = page.locator('trn-channel-sidebar .sidebar__title');
    const composer = page.getByTestId('composer-input');

    await spacePill.click({ timeout: 30_000 });
    await row(alpha).click({ timeout: 30_000 });
    await expect(selected).toHaveText(new RegExp(alpha), { timeout: 15_000 });
    await expect(spacePill).toHaveAttribute('aria-current', 'true');
    await expect(composer).toBeVisible({ timeout: 30_000 });
    const roomUrl = page.url();
    expect(new URL(roomUrl).searchParams.get('space')).toBe(
      urlSegment(spaceId),
    );

    // With /sync held the app runs on the cache, which predates the space.
    const sync = await holdSync(page);
    await page.reload();

    await expect(title).toHaveText('Loading space…', { timeout: 30_000 });
    await expect(page.getByTestId('room-list-empty')).toHaveText(
      'Loading rooms…',
    );
    await expect(recent).not.toHaveAttribute('aria-current', 'true');
    expect(page.url()).toBe(roomUrl);

    sync.release();

    await expect(spacePill).toHaveAttribute('aria-current', 'true', {
      timeout: 30_000,
    });
    await expect(selected).toHaveText(new RegExp(alpha), { timeout: 15_000 });
    await expect(row(bravo)).toBeVisible();
    await expect(row(outside)).toHaveCount(0);
    await expect(title).toContainText(spaceName);
    await expect(composer).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(roomUrl);
  });

  test('a space the account does not hold falls back to Recent and keeps the room', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sra`;
    const user = `space-absent-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const reader = await passwordLogin(request, hs, user, pass);
    const outside = `Outside ${runId}`;
    const outsideId = await createRoom(request, hs, reader, outside);

    await login(page, { available: true, hs, user, pass });
    await expect(
      page.locator('trn-channel-sidebar .channel', { hasText: outside }),
    ).toBeVisible({ timeout: 30_000 });
    const account = new URL(page.url()).searchParams.get('account') as string;
    const absent = `!absent-${runId}:${serverNameOf(reader)}`;

    await page.goto(
      `/rooms/${urlSegment(outsideId)}?account=${encodeURIComponent(
        account,
      )}&space=${urlSegment(absent)}`,
    );

    await expect(page.getByTestId('rail-recent')).toHaveAttribute(
      'aria-current',
      'true',
      { timeout: 30_000 },
    );
    await expect
      .poll(() => new URL(page.url()).searchParams.get('space'))
      .toBeNull();
    expect(new URL(page.url()).pathname).toBe(
      `/rooms/${urlSegment(outsideId)}`,
    );
    await expect(
      page.locator('trn-channel-sidebar .sidebar__title'),
    ).toHaveText('Recent activity');
    await expect(
      page.locator('trn-channel-sidebar .channel.channel--selected'),
    ).toHaveText(new RegExp(outside), { timeout: 15_000 });
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 30_000,
    });
  });
});
