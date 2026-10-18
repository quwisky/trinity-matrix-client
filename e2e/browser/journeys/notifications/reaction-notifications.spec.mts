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
import {
  registerUser,
  apiLogin,
  type ApiUser,
} from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import { sendWithRetry } from '../../support/cs-api.mts';
import { createRoom } from '../../support/space-journey.mts';
import {
  installNotificationRecorder,
  postMessage,
} from '../../support/notification-journey.mts';

const session = homeserverSession();

async function postReaction(
  request: APIRequestContext,
  hs: string,
  reactor: ApiUser,
  roomId: string,
  eventId: string,
  key: string,
  txnId: string,
): Promise<string> {
  const response = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
    {
      headers: reactor.headers,
      data: {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
      },
    },
  );
  expect(response.ok(), `reaction ${key}: ${response.status()}`).toBe(true);
  const json = await response.json();
  return json.event_id as string;
}

interface SyncEventCollector {
  waitFor(eventId: string): Promise<void>;
  dispose(): void;
}

/** Install the response listener before sending an event so a fast sync cannot race the waiter. */
function createSyncEventCollector(page: Page): SyncEventCollector {
  const seen = new Set<string>();
  const listener = (response: import('@playwright/test').Response): void => {
    if (
      response.request().method() !== 'GET' ||
      !/_matrix\/client\/(?:v3|r0)\/sync$/.test(
        new URL(response.url()).pathname,
      ) ||
      !response.ok()
    ) {
      return;
    }
    void response
      .json()
      .then(
        (json: {
          rooms?: {
            join?: Record<
              string,
              { timeline?: { events?: Array<{ event_id?: string }> } }
            >;
          };
        }) => {
          const eventIds = Object.values(json.rooms?.join ?? {}).flatMap(
            (room) =>
              room.timeline?.events?.flatMap((event) => event.event_id ?? []) ??
              [],
          );
          for (const eventId of eventIds) {
            seen.add(eventId);
          }
        },
      )
      .catch(() => undefined);
  };
  page.on('response', listener);
  return {
    async waitFor(eventId: string): Promise<void> {
      await expect
        .poll(() => seen.has(eventId), {
          message: `reader receives ${eventId} in live sync`,
          timeout: 20_000,
        })
        .toBe(true);
    },
    dispose(): void {
      page.off('response', listener);
    },
  };
}

async function reactionNotificationCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        (
          window as unknown as {
            __notifications: Array<{ title: string }>;
          }
        ).__notifications ?? []
      ).filter((record) => record.title.includes('reacted')).length,
  );
}

/** The product's trailing reaction batch window is two seconds; wait past it before asserting absence. */
async function waitForReactionBatchDeadline(page: Page): Promise<void> {
  const deadline = Date.now() + 2_500;
  await page.waitForFunction((target) => Date.now() >= target, deadline, {
    timeout: 5_000,
    polling: 100,
  });
}

async function joinReactionRoom(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  reactor: ApiUser,
): Promise<void> {
  await sendWithRetry(`join ${reactor.userId}`, () =>
    request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: reactor.headers },
    ),
  );
}

async function storedReactionPreference(
  request: APIRequestContext,
  hs: string,
  userId: string,
  token: string,
): Promise<{ enabled: boolean } | undefined> {
  const response = await request.get(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/dev.trinityproject.trinity.reaction_notifications`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status() === 404) return undefined;
  expect(response.ok(), `reaction preference: ${response.status()}`).toBe(true);
  return (await response.json()) as { enabled: boolean };
}

interface ReactionFixture {
  reader: HomeserverSession;
  readerApi: ApiUser;
  reactors: ApiUser[];
  roomId: string;
  roomName: string;
  parkingRoomName: string;
  reactorNames: string[];
}

async function seedReactionRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<ReactionFixture> {
  const readerUser = `reaction-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  const reactorUsers = [
    `reaction-alice-${runId}`,
    `reaction-bob-${runId}`,
    `reaction-carol-${runId}`,
  ];
  const reactorNames = [
    `Reaction Alice ${runId}`,
    `Reaction Bob ${runId}`,
    `Reaction Carol ${runId}`,
  ];
  const roomName = `Reaction Notify ${runId}`;
  const parkingRoomName = `Reaction Parking ${runId}`;

  await registerUser(request, readerUser, readerPass);
  for (const user of reactorUsers) {
    await registerUser(request, user, `${user}-pass`);
  }

  const readerApi = await apiLogin(request, hs, readerUser, readerPass);
  const reactors = await Promise.all(
    reactorUsers.map((user) => apiLogin(request, hs, user, `${user}-pass`)),
  );
  for (const [reactor, name] of reactors.map(
    (value, index) => [value, reactorNames[index]] as const,
  )) {
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(reactor.userId)}/displayname`,
      { headers: reactor.headers, data: { displayname: name } },
    );
  }

  const roomId = await createRoom(request, hs, readerApi, roomName, {
    invite: reactors.map((r) => r.userId),
  });
  for (const reactor of reactors) {
    await joinReactionRoom(request, hs, roomId, reactor);
  }
  await createRoom(request, hs, readerApi, parkingRoomName);

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    readerApi,
    reactors,
    roomId,
    roomName,
    parkingRoomName,
    reactorNames,
  };
}

test.describe('Reaction notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ permissions: ['notifications'] });

  test('enables and persists grouped reactions, suppresses ineligible reactions, and opens the target', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}r`;
    const fixture = await seedReactionRoom(request, hs, runId);
    expect(
      await storedReactionPreference(
        request,
        hs,
        fixture.readerApi.userId,
        fixture.readerApi.token,
      ),
    ).toBeUndefined();

    await installNotificationRecorder(page);
    await login(page, fixture.reader);
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: fixture.roomName }).first(),
    ).toBeVisible({ timeout: 20_000 });

    const ownBody = `reader-owned reaction target ${runId}`;
    const ownEventId = await postMessage(
      request,
      hs,
      fixture.readerApi,
      fixture.roomId,
      `reaction-own-target-${runId}`,
      ownBody,
    );
    await page
      .locator('.channel', { hasText: fixture.roomName })
      .first()
      .click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('.scroll').getByText(ownBody, { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: fixture.parkingRoomName }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page
      .locator('.channel', { hasText: fixture.parkingRoomName })
      .first()
      .click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('.scroll').getByText(ownBody, { exact: true }),
    ).toHaveCount(0);

    // The preference is off by default: a real live reaction is received and
    // processed before opting in, yet no reaction notification is presented.
    const defaultOffCollector = createSyncEventCollector(page);
    const defaultOffReactionId = await postReaction(
      request,
      hs,
      fixture.reactors[0],
      fixture.roomId,
      ownEventId,
      '🚀',
      `reaction-default-off-${runId}`,
    );
    await defaultOffCollector.waitFor(defaultOffReactionId);
    await waitForReactionBatchDeadline(page);
    await expect
      .poll(() => reactionNotificationCount(page), { timeout: 5_000 })
      .toBe(0);
    defaultOffCollector.dispose();

    await openSettingsSection(page, 'notifications');
    const reactionSwitch = page
      .getByTestId('notif-reactions')
      .locator('button, input')
      .first();
    await expect(reactionSwitch).toHaveAttribute('aria-checked', 'false');
    await reactionSwitch.click();
    await expect
      .poll(
        () =>
          storedReactionPreference(
            request,
            hs,
            fixture.readerApi.userId,
            fixture.readerApi.token,
          ),
        { timeout: 20_000 },
      )
      .toEqual({ enabled: true });
    await closeSettings(page);

    // Reopen the settings surface to prove the account-data projection survives the
    // settings lifecycle, rather than only changing the current component instance.
    await openSettingsSection(page, 'notifications');
    await expect(
      page.getByTestId('notif-reactions').locator('button, input').first(),
    ).toHaveAttribute('aria-checked', 'true');
    await closeSettings(page);

    const groupedCollector = createSyncEventCollector(page);
    const groupedReactionIds: string[] = [];
    groupedReactionIds.push(
      await postReaction(
        request,
        hs,
        fixture.reactors[0],
        fixture.roomId,
        ownEventId,
        '👍',
        `reaction-a-${runId}`,
      ),
    );
    groupedReactionIds.push(
      await postReaction(
        request,
        hs,
        fixture.reactors[1],
        fixture.roomId,
        ownEventId,
        '🎉',
        `reaction-b-${runId}`,
      ),
    );
    groupedReactionIds.push(
      await postReaction(
        request,
        hs,
        fixture.reactors[2],
        fixture.roomId,
        ownEventId,
        '👍',
        `reaction-c-${runId}`,
      ),
    );
    await Promise.all(
      groupedReactionIds.map((eventId) => groupedCollector.waitFor(eventId)),
    );
    groupedCollector.dispose();
    await expect
      .poll(() => reactionNotificationCount(page), { timeout: 20_000 })
      .toBe(1);
    const notification = await page.evaluate((body) => {
      const records = (
        window as unknown as {
          __notifications: Array<{
            title: string;
            options: { body?: string; data?: { eventId?: string } };
            instance?: { onclick: (() => void) | null };
          }>;
        }
      ).__notifications;
      return records.find(
        (record) =>
          record.options.body?.includes(body) &&
          record.title.includes('reacted'),
      );
    }, ownBody);
    if (!notification) {
      throw new Error(
        'Expected a grouped reaction notification for the original message',
      );
    }
    expect(notification.title).toContain(fixture.reactorNames[0]);
    expect(notification.title).toContain('and 2 others reacted');
    expect(notification.title).toContain('👍');
    expect(notification.title).toContain('🎉');
    expect(notification.title).toContain(fixture.roomName);
    expect(notification.options.body).toContain(ownBody);
    expect(notification.options.data?.eventId).toBe(ownEventId);

    // The reader's own reaction and a reaction to another person's message must not
    // create another alert. The live target is kept out of view so visibility cannot
    // accidentally explain the suppression.
    const suppressionCollector = createSyncEventCollector(page);
    const ownReactionId = await postReaction(
      request,
      hs,
      fixture.readerApi,
      fixture.roomId,
      ownEventId,
      '🚀',
      `reaction-own-${runId}`,
    );
    await suppressionCollector.waitFor(ownReactionId);
    const otherBody = `sender-owned reaction target ${runId}`;
    const otherEventId = await postMessage(
      request,
      hs,
      fixture.reactors[0],
      fixture.roomId,
      `reaction-other-target-${runId}`,
      otherBody,
    );
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: otherBody }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('rail-rooms').click();
    await page
      .locator('.channel', { hasText: fixture.parkingRoomName })
      .first()
      .click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });
    const otherReactionId = await postReaction(
      request,
      hs,
      fixture.reactors[1],
      fixture.roomId,
      otherEventId,
      '❤️',
      `reaction-other-${runId}`,
    );
    await suppressionCollector.waitFor(otherReactionId);

    // The ordinary other-authored message above may legitimately notify. Filter by
    // the original target preview and wait until both reaction events were observed
    // by the reader, then prove no additional reaction alert was created.
    suppressionCollector.dispose();
    await waitForReactionBatchDeadline(page);
    await expect
      .poll(() => reactionNotificationCount(page), {
        timeout: 20_000,
        intervals: [250],
      })
      .toBe(1);

    // The browser adapter retains the destination on the real Notification object;
    // invoking its click handler proves activation carries the original event id.
    await page.evaluate((body) => {
      const records = (
        window as unknown as {
          __notifications: Array<{
            title: string;
            options: { body?: string };
            instance?: { onclick: (() => void) | null };
          }>;
        }
      ).__notifications;
      records
        .find(
          (record) =>
            record.options.body?.includes(body) &&
            record.title.includes('reacted'),
        )
        ?.instance?.onclick?.();
    }, ownBody);
    await expect(
      page.locator('.scroll').getByText(ownBody, { exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
  });
});
