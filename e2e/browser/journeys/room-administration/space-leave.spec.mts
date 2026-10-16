import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { createRoom, linkChild } from '../../support/space-journey.mts';

const session = homeserverSession();

/**
 * From now on, record whether the Recent rail entry becomes current, and every Recent URL
 * the app writes (a /rooms URL with neither `view` nor `space`).
 */
async function recordRecent(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record = { recentCurrent: false, recentUrls: [] as string[] };
    (window as unknown as { __recent: typeof record }).__recent = record;
    const recent = document.querySelector('[data-testid="rail-recent"]');
    if (recent) {
      new MutationObserver(() => {
        if (recent.getAttribute('aria-current') === 'true') {
          record.recentCurrent = true;
        }
      }).observe(recent, {
        attributes: true,
        attributeFilter: ['aria-current'],
      });
    }
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method].bind(history);
      history[method] = (data, unused, url) => {
        const next = new URL(String(url ?? location.href), location.href);
        if (
          next.pathname.startsWith('/rooms') &&
          !next.searchParams.has('view') &&
          !next.searchParams.has('space')
        ) {
          record.recentUrls.push(next.pathname + next.search);
        }
        original(data, unused, url);
      };
    }
  });
}

function recentRecord(
  page: Page,
): Promise<{ recentCurrent: boolean; recentUrls: string[] }> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __recent: { recentCurrent: boolean; recentUrls: string[] };
        }
      ).__recent,
  );
}

async function openSpaceMenu(page: Page, name: string): Promise<void> {
  const pill = page.getByRole('button', { name, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await pill.click();
  await page.getByTestId('space-header').click();
}

async function joinedRooms(
  request: APIRequestContext,
  hs: string,
  token: string,
): Promise<readonly string[]> {
  return request
    .get(`${hs}/_matrix/client/v3/joined_rooms`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .then((response) => response.json())
    .then((body) => body.joined_rooms as string[]);
}

test.describe('Leaving a Space', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('names the exact Account, cancels safely, and leaves child Room membership intact', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spleave`;
    const user = `space-leave-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Leave space ${runId}`;
    const roomName = `Keep room ${runId}`;
    await registerUser(request, user, pass);
    const owner = await passwordLogin(request, hs, user, pass);
    const token = owner.accessToken;
    const spaceId = await createRoom(request, hs, owner, spaceName, {
      space: true,
    });
    const roomId = await createRoom(request, hs, owner, roomName);
    await linkChild(request, hs, owner, spaceId, roomId);

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('space-leave').click();
    const confirmation = page.getByRole('dialog', { name: 'Leave space' });
    await expect(confirmation).toContainText(spaceName);
    await expect(confirmation).toContainText(user);
    await expect(confirmation).toContainText(
      'You remain a member of its rooms',
    );
    await confirmation.getByRole('button', { name: 'Cancel' }).click();

    expect(await joinedRooms(request, hs, token)).toEqual(
      expect.arrayContaining([spaceId, roomId]),
    );
    await expect(
      page.getByRole('button', { name: spaceName, exact: true }),
    ).toBeVisible();

    // Leaving goes to the direct messages, once (#1402). Hold the leave's answer until the
    // sync dropping the space has landed, the order in which Workspace must leave the space
    // to the leave flow, and record whether Recent ever became current or was written.
    await recordRecent(page);
    let answerLeave!: () => void;
    const leaveAnswered = new Promise<void>(
      (resolve) => (answerLeave = resolve),
    );
    await page.route(
      (url) =>
        url.pathname.endsWith('/leave') &&
        decodeURIComponent(url.pathname).includes(spaceId),
      async (route) => {
        const response = await route.fetch();
        await leaveAnswered;
        await route.fulfill({ response });
      },
    );
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('space-leave').click();
    await confirmation.getByRole('button', { name: 'Leave' }).click();

    await expect(
      page.getByRole('button', { name: spaceName, exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    // The space is gone from the rail and its leave unanswered: a repair would act now.
    await page.waitForTimeout(1_000);
    answerLeave();

    await expect
      .poll(() => new URL(page.url()).searchParams.get('view'), {
        timeout: 30_000,
      })
      .toBe('home');
    expect(new URL(page.url()).searchParams.get('space')).toBeNull();
    await expect(
      page.locator('trn-channel-sidebar .sidebar__title'),
    ).toHaveText('Direct messages');
    await expect(page.getByTestId('rail-recent')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(await recentRecord(page)).toEqual({
      recentCurrent: false,
      recentUrls: [],
    });

    await expect
      .poll(() => joinedRooms(request, hs, token), { timeout: 30_000 })
      .not.toContain(spaceId);
    await expect
      .poll(() => joinedRooms(request, hs, token), { timeout: 30_000 })
      .toContain(roomId);
  });
});
