import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import { devices } from '@playwright/test';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser, apiLogin } from '../../../support/account.mts';
import { createRoom } from '../../support/space-journey.mts';

// On a phone a room with too few messages to fill the screen sits at the bottom, by the
// composer; once it overflows, the timeline behaves as before.
const session = homeserverSession();
test.use({ ...devices['Pixel 5'] });

const LONG_BODY = `lorem ipsum dolor sit amet `.repeat(18);

async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
  count: number,
  body: string,
): Promise<{
  reader: HomeserverSession;
  roomName: string;
  send: (text: string) => Promise<void>;
}> {
  const readerUser = `short-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const roomName = `Short E2E ${runId}`;
  const buddyUser = `short-buddy-${runId}`;
  await registerUser(request, buddyUser, `${buddyUser}-pass`);
  const buddy = await apiLogin(request, hs, buddyUser, `${buddyUser}-pass`);
  const roomId = await createRoom(request, hs, reader, roomName, {
    invite: [buddy.userId],
  });
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: buddy.headers },
  );
  let lastEventId = '';
  for (let i = 0; i < count; i++) {
    const sent = await request
      .put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${i}`,
        {
          headers: reader.headers,
          data: { msgtype: 'm.text', body: `Message ${i}: ${body}` },
        },
      )
      .then((r) => r.json());
    lastEventId = sent.event_id as string;
  }
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
    {
      headers: reader.headers,
      data: { 'm.fully_read': lastEventId, 'm.read': lastEventId },
    },
  );
  let n = 0;
  const send = async (text: string): Promise<void> => {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-late-${n++}`,
      { headers: buddy.headers, data: { msgtype: 'm.text', body: text } },
    );
  };
  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    send,
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

/** Space between the newest row and the composer, as a fraction of the timeline's height. */
const gapAboveComposer = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('.scroll .msg');
    const last = rows[rows.length - 1].getBoundingClientRect();
    const composer = document
      .querySelector('trn-message-composer')!
      .getBoundingClientRect();
    const scroll = document.querySelector('.scroll') as HTMLElement;
    return (composer.top - last.bottom) / scroll.clientHeight;
  });

const distanceFromBottom = (scroll: Locator): Promise<number> =>
  scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test.describe('Short rooms on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a two-message room sits at the bottom, above the composer', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}s`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
      2,
      'hi',
    );
    await login(page, reader);
    await openRoom(page, roomName);
    await expect(
      page.locator('.scroll').getByText('Message 1: hi'),
    ).toBeVisible();

    const scroll = page.locator('.scroll');
    const range = await scroll.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    expect(range).toBe(0);
    await expect.poll(() => gapAboveComposer(page)).toBeLessThan(0.2);
  });

  test('a full room still opens at the bottom and jumps to latest', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}f`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
      20,
      LONG_BODY,
    );
    await login(page, reader);
    await openRoom(page, roomName);

    const scroll = page.locator('.scroll');
    await expect
      .poll(() =>
        scroll.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(50);
    await scroll.evaluate((el) => el.scrollTo({ top: 0 }));
    await page.getByTestId('jump-to-latest').click();
    await expect(page.getByTestId('jump-to-latest')).toBeHidden();

    // Leave the room and come back: the read position is restored.
    await scroll.evaluate((el) => el.scrollTo({ top: 600 }));
    const before = await scroll.evaluate((el) => el.scrollTop);
    await page.getByTestId('back-to-rooms').click();
    await openRoom(page, roomName);
    await expect
      .poll(async () =>
        Math.abs((await scroll.evaluate((el) => el.scrollTop)) - before),
      )
      .toBeLessThanOrEqual(1);
  });

  test('a load-older indicator does not move a short room', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}l`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
      2,
      'hi',
    );
    await login(page, reader);
    await openRoom(page, roomName);
    await expect(
      page.locator('.scroll').getByText('Message 1: hi'),
    ).toBeVisible();
    await expect.poll(() => gapAboveComposer(page)).toBeLessThan(0.2);

    // Stand in for the indicator: a div ahead of the top spacer, as the template renders it.
    await page.locator('.scroll').evaluate((el) => {
      const banner = document.createElement('div');
      banner.className = 'load-older';
      banner.textContent = 'Loading older messages…';
      el.insertBefore(banner, el.querySelector('.vpad'));
    });
    expect(await gapAboveComposer(page)).toBeLessThan(0.2);
  });

  test('a short room growing past full keeps the bottom pin', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}g`;
    const { reader, roomName, send } = await seedRoom(
      request,
      session.hs as string,
      runId,
      2,
      'hi',
    );
    await login(page, reader);
    await openRoom(page, roomName);
    await expect.poll(() => gapAboveComposer(page)).toBeLessThan(0.2);

    const scroll = page.locator('.scroll');
    for (let i = 0; i < 8; i++) await send(`Growing ${i}: ${LONG_BODY}`);
    await expect(scroll.getByText('Growing 7:')).toBeVisible();
    expect(
      await scroll.evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeGreaterThan(0);
    await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(50);
  });

  test('a message arriving while scrolled up leaves the position alone', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}u`;
    const { reader, roomName, send } = await seedRoom(
      request,
      session.hs as string,
      runId,
      20,
      LONG_BODY,
    );
    await login(page, reader);
    await openRoom(page, roomName);
    const scroll = page.locator('.scroll');
    await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(50);

    await scroll.evaluate((el) => el.scrollTo({ top: 600 }));
    await expect(page.getByTestId('jump-to-latest')).toBeVisible();
    const before = await scroll.evaluate((el) => el.scrollTop);
    const height = await scroll.evaluate((el) => el.scrollHeight);
    await send('Arrived while reading');
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollHeight), { timeout: 15_000 })
      .toBeGreaterThan(height);
    expect(
      Math.abs((await scroll.evaluate((el) => el.scrollTop)) - before),
    ).toBeLessThanOrEqual(1);
  });
});
