import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';

// Recent emoji sync through MSC4356 `m.recent_emoji` account data: a pick is saved to the
// account, and after a reload with this device's own emoji-mart history cleared, the
// picker's recent row still starts with it.
const session = homeserverSession();

async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  user: HomeserverSession;
  userId: string;
  roomName: string;
  headers: { Authorization: string };
}> {
  const username = `recent-emoji-${runId}`;
  const password = `${username}-pass`;
  const roomName = `Recent emoji E2E ${runId}`;
  await registerUser(request, username, password);
  const { access_token, user_id } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      },
    })
    .then((response) => response.json());
  const headers = { Authorization: `Bearer ${access_token}` };
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers,
    data: { name: roomName },
  });
  return {
    user: { available: true, hs, user: username, pass: password },
    userId: user_id as string,
    roomName,
    headers,
  };
}

const recentRow = (page: Page) =>
  page.locator(
    'section.emoji-mart-category[aria-label="Frequently Used"] .emoji-mart-emoji',
  );

test.describe('Recent emoji', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test('a pick is saved to the account and comes first after a reload', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const { user, userId, roomName, headers } = await seedRoom(
      request,
      hs,
      `${testResourceId('run')}e`,
    );
    await login(page, user);
    await openRoom(page, roomName);

    const trigger = page.getByRole('button', {
      name: 'Emoji, GIFs and stickers',
    });
    await trigger.click();
    const search = page.locator('trn-emoji-picker .emoji-mart-search input');
    await search.fill('rocket');
    await page
      .locator('trn-emoji-picker .emoji-mart-emoji', { hasText: '🚀' })
      .first()
      .click();
    await expect(page.getByTestId('composer-input')).toHaveValue(/🚀/);

    await expect
      .poll(
        async () => {
          const response = await request.get(
            `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.recent_emoji`,
            { headers },
          );
          return response.ok() ? await response.json() : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({ recent_emoji: [{ emoji: '🚀', total: 1 }] });

    // Only the account can bring it back: this device's own emoji-mart history goes.
    await page.evaluate(() => {
      localStorage.removeItem('emoji-mart.frequently');
      localStorage.removeItem('emoji-mart.last');
    });
    await page.reload();
    await openRoom(page, roomName);
    await page
      .getByRole('button', { name: 'Emoji, GIFs and stickers' })
      .click();

    await expect(recentRow(page).first()).toHaveText('🚀', {
      timeout: 20_000,
    });
  });
});
