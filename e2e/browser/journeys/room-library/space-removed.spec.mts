import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import {
  passwordLogin,
  registerUser,
  type AccountSession,
} from '../../../support/account.mts';
import {
  createRoom,
  linkChild,
  membership,
  urlSegment,
} from '../../support/space-journey.mts';

// Covers issue #1402: when the selected space disappeared (removed from it, deleted, or left
// on another device), the sidebar kept it selected as an empty list titled "Direct
// messages". Now the rail returns to Recent activity, replacing the history entry, and the
// open room stays open.
//
// Needs a disposable homeserver and self-skips otherwise.
const session = homeserverSession();

interface SpaceFixture {
  readonly hs: string;
  readonly owner: AccountSession;
  readonly user: string;
  readonly pass: string;
  readonly readerId: string;
  readonly spaceId: string;
  readonly spaceName: string;
  readonly alphaId: string;
  readonly alpha: string;
}

/** An owner's space with one room, both joined by a reader who signs in to the app. */
async function seedSpace(
  request: APIRequestContext,
  role: string,
): Promise<SpaceFixture> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${role}`;
  const ownerUser = `space-owner-${runId}`;
  const user = `space-reader-${runId}`;
  const pass = `${user}-pass`;
  await registerUser(request, ownerUser, `${ownerUser}-pass`);
  await registerUser(request, user, pass);
  const owner = await passwordLogin(
    request,
    hs,
    ownerUser,
    `${ownerUser}-pass`,
  );
  const reader = await passwordLogin(request, hs, user, pass);

  const spaceName = `Team ${runId}`;
  const alpha = `Alpha ${runId}`;
  const spaceId = await createRoom(request, hs, owner, spaceName, {
    space: true,
    invite: [reader.userId],
  });
  const alphaId = await createRoom(request, hs, owner, alpha, {
    invite: [reader.userId],
  });
  await linkChild(request, hs, owner, spaceId, alphaId);
  await membership(request, hs, reader, spaceId, 'join');
  await membership(request, hs, reader, alphaId, 'join');
  return {
    hs,
    owner,
    user,
    pass,
    readerId: reader.userId,
    spaceId,
    spaceName,
    alphaId,
    alpha,
  };
}

/** Sign in as the reader and open the space's room from the space's list. */
async function openRoomInSpace(page: Page, f: SpaceFixture): Promise<void> {
  await login(page, { available: true, hs: f.hs, user: f.user, pass: f.pass });
  const pill = spacePill(page, f);
  await pill.click({ timeout: 30_000 });
  await expect(pill).toHaveAttribute('aria-current', 'true');
  await page
    .locator('trn-channel-sidebar .channel', { hasText: f.alpha })
    .click({ timeout: 30_000 });
  await expect(selectedRow(page)).toHaveText(new RegExp(f.alpha), {
    timeout: 15_000,
  });
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 30_000,
  });
  expect(new URL(page.url()).searchParams.get('space')).toBe(
    urlSegment(f.spaceId),
  );
}

const spacePill = (page: Page, f: SpaceFixture) =>
  page
    .locator('trn-server-rail')
    .getByRole('button', { name: f.spaceName, exact: true });
const selectedRow = (page: Page) =>
  page.locator('trn-channel-sidebar .channel.channel--selected');

/** Recent activity is selected, the space gone, and the space's room still open. */
async function expectRecentWithRoomOpen(
  page: Page,
  f: SpaceFixture,
  historyLength: number,
): Promise<void> {
  await expect(page.getByTestId('rail-recent')).toHaveAttribute(
    'aria-current',
    'true',
    { timeout: 30_000 },
  );
  await expect(spacePill(page, f)).toHaveCount(0);
  await expect(page.locator('trn-channel-sidebar .sidebar__title')).toHaveText(
    'Recent activity',
  );
  await expect
    .poll(() => new URL(page.url()).searchParams.get('space'))
    .toBeNull();
  expect(new URL(page.url()).pathname).toBe(`/rooms/${urlSegment(f.alphaId)}`);
  await expect(selectedRow(page)).toHaveText(new RegExp(f.alpha));
  await expect(page.getByTestId('composer-input')).toBeVisible();
  // The repair replaced the space's entry rather than pushing one Back would undo.
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
}

test.describe('A selected space that disappears', () => {
  test.skip(!session.available, 'needs a disposable homeserver');

  test('removed from the space: the rail returns to Recent with the room open', async ({
    page,
    request,
  }) => {
    const f = await seedSpace(request, 'srk');
    await openRoomInSpace(page, f);
    const historyLength = await page.evaluate(() => history.length);

    await membership(request, f.hs, f.owner, f.spaceId, 'kick', {
      user_id: f.readerId,
    });

    await expectRecentWithRoomOpen(page, f, historyLength);
  });

  test('left on another device: the rail returns to Recent with the room open', async ({
    page,
    request,
  }) => {
    const f = await seedSpace(request, 'srl');
    await openRoomInSpace(page, f);
    const historyLength = await page.evaluate(() => history.length);

    // A second session of the same account: another device.
    const otherDevice = await passwordLogin(request, f.hs, f.user, f.pass);
    await membership(request, f.hs, otherDevice, f.spaceId, 'leave');

    await expectRecentWithRoomOpen(page, f, historyLength);
  });
});
