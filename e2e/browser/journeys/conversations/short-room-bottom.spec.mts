import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
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
): Promise<{ reader: HomeserverSession; roomName: string }> {
  const readerUser = `short-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const roomName = `Short E2E ${runId}`;
  const roomId = await createRoom(request, hs, reader, roomName);
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
  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

const gapBelowLastMessage = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const scroll = document.querySelector('.scroll') as HTMLElement;
    const rows = scroll.querySelectorAll('.msg');
    const last = rows[rows.length - 1].getBoundingClientRect();
    return scroll.getBoundingClientRect().bottom - last.bottom;
  });

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
    await expect.poll(() => gapBelowLastMessage(page)).toBeLessThan(60);
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
    await page.getByTestId('back-to-rooms').click();
    await openRoom(page, roomName);
    await expect
      .poll(() => scroll.evaluate((el) => Math.round(el.scrollTop)))
      .toBeGreaterThan(300);
  });
});
