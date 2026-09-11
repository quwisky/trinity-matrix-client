import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import { setTimeout as wait } from 'node:timers/promises';

// Covers NotificationService's core rule end to end: a live message fires an OS
// notification unless the user is actually looking at that room — i.e. the window
// is focused AND the message's room is the one open in the timeline. A message to
// a room you AREN'T viewing must notify even while the app itself is focused
// (Playwright pages always report `document.hasFocus() === true`, so "not
// viewing that room" — not unfocusing the window — is what drives the suppressed
// case here).
//
// Registers a throwaway reader/sender pair per test via Synapse's shared-secret
// admin endpoint, same trick as unread-badges.spec.mts. Needs a Synapse
// homeserver (Docker) and self-skips otherwise, like the other authenticated web
// e2e specs (see timeline-virtualization.spec.mts).
const session = synapseSession();

interface ApiUser {
  token: string;
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  const json = await res.json();
  return {
    token: json.access_token as string,
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/**
 * Register a fresh reader + sender pair, have the reader create a plain
 * (non-DM) room and invite the sender, and have the sender join it — but send
 * NO message yet. Notifications only fire for *live* timeline events (backfill
 * from before the reader's initial sync never notifies), so the message must be
 * posted only after the reader's client is up and live — see `postMessage`.
 *
 * The sender's display name is set explicitly so the notification title
 * (`${sender} · ${room}`) is deterministic to assert on.
 */
async function seedNotifyRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: SynapseSession;
  readerUserId: string;
  sender: ApiUser;
  roomId: string;
  roomName: string;
  senderName: string;
}> {
  const readerUser = `notify-reader-${runId}`;
  const readerPass = `reader-pass-${runId}`;
  const senderUser = `notify-sender-${runId}`;
  const senderPass = `sender-pass-${runId}`;
  const roomName = `Notify E2E ${runId}`;
  const senderName = `Notify Sender ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, senderUser, senderPass);

  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const sender = await apiLogin(request, hs, senderUser, senderPass);

  // Give the sender a deterministic display name so the notification title
  // (`${sender} · ${room}`) doesn't depend on Synapse's default-displayname
  // behaviour.
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(sender.userId)}/displayname`,
    { headers: sender.headers, data: { displayname: senderName } },
  );

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: {
        name: roomName,
        preset: 'private_chat',
        invite: [sender.userId],
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: sender.headers },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    readerUserId: reader.userId,
    sender,
    roomId,
    roomName,
    senderName,
  };
}

/** Have the sender post one live message via the CS API; returns its body so
 * callers can assert on it. */
async function postMessage(
  request: APIRequestContext,
  hs: string,
  sender: ApiUser,
  roomId: string,
  txnId: string,
  body: string,
): Promise<string> {
  const response = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    { headers: sender.headers, data: { msgtype: 'm.text', body } },
  );
  const json = await response.json();
  return json.event_id as string;
}

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
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: reactor.headers },
    );
    if (response.ok()) return;
    if (response.status() !== 429) {
      throw new Error(
        `join ${reactor.userId}: ${response.status()} ${await response.text()}`,
      );
    }
    const json = (await response.json().catch(() => ({}))) as {
      retry_after_ms?: number;
    };
    await wait(
      Math.min(Math.max(Number(json.retry_after_ms) || 1_000, 1), 10_000),
    );
  }
  throw new Error(
    `join ${reactor.userId}: still rate-limited after 5 attempts`,
  );
}

async function storedReactionPreference(
  request: APIRequestContext,
  hs: string,
  userId: string,
  token: string,
): Promise<{ enabled: boolean } | undefined> {
  const response = await request.get(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/eu.qwky.trinity.reaction_notifications`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status() === 404) return undefined;
  expect(response.ok(), `reaction preference: ${response.status()}`).toBe(true);
  return (await response.json()) as { enabled: boolean };
}

interface ReactionFixture {
  reader: SynapseSession;
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

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: readerApi.headers,
      data: {
        name: roomName,
        preset: 'private_chat',
        invite: reactors.map((r) => r.userId),
      },
    })
    .then((response) => response.json())
    .then((json) => json.room_id as string);
  for (const reactor of reactors) {
    await joinReactionRoom(request, hs, roomId, reactor);
  }
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: readerApi.headers,
    data: { name: parkingRoomName, preset: 'private_chat' },
  });

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

/**
 * Recorder for both Web Notification delivery paths NotificationService can
 * take (see notification.service.ts `show()`):
 *
 *  - the renderer `new Notification(title, options)` constructor (desktop
 *    browsers, and this app in the e2e build — the service worker is only
 *    `enabled` on a *production* build, and e2e serves the `development`
 *    config, so no SW ever controls the page here); and
 *  - `navigator.serviceWorker.ready.then(reg => reg.showNotification(...))`
 *    (taken instead when a SW *does* control the page).
 *
 * Every call, from either path, is appended to `window.__notifications` as
 * `{ title, options }`. Registered via `page.addInitScript` so it's in place
 * before the app's first script runs, on every navigation in the page
 * (including the /login → /rooms redirect `login()` drives).
 */
async function installNotificationRecorder(page: Page): Promise<void> {
  function install(nativeExpected: boolean): void {
    const w = window as typeof window & {
      __notifications: Array<{
        title: string;
        options: unknown;
        instance?: { onclick: (() => void) | null };
      }>;
      __notificationRecorderInstalled?: boolean;
      Capacitor?: {
        nativePromise?(
          pluginName: string,
          methodName: string,
          options?: Record<string, unknown>,
        ): Promise<unknown>;
      };
    };
    if (w.__notificationRecorderInstalled) return;
    w.__notifications = [];

    const capacitor = w.Capacitor;
    if (!capacitor && nativeExpected) {
      setTimeout(() => install(nativeExpected), 0);
      return;
    }
    if (nativeExpected && capacitor?.nativePromise) {
      w.__notificationRecorderInstalled = true;
      const nativePromise = capacitor.nativePromise.bind(capacitor);
      capacitor.nativePromise = (
        pluginName: string,
        methodName: string,
        options: Record<string, unknown> = {},
      ): Promise<unknown> => {
        if (pluginName !== 'LocalNotifications' || methodName !== 'schedule') {
          return nativePromise(pluginName, methodName, options);
        }
        const notifications = Array.isArray(options['notifications'])
          ? (options['notifications'] as Array<Record<string, unknown>>)
          : [];
        for (const notification of notifications) {
          w.__notifications.push({
            title: String(notification['title'] ?? ''),
            options: {
              body: notification['body'],
              tag: notification['threadIdentifier'],
            },
          });
        }
        return Promise.resolve();
      };
      return;
    }

    w.__notificationRecorderInstalled = true;
    class RecordingNotification {
      static permission = 'granted';
      static requestPermission = async (): Promise<string> => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: unknown) {
        w.__notifications.push({ title, options, instance: this });
      }
      close(): void {
        /* no-op */
      }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: RecordingNotification,
    });

    // Neutralize the service-worker path so the constructor above is always the
    // one taken, AND record through it too in case a SW ever does control the
    // page (belt and braces — e2e's development build never registers one).
    if (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      navigator.serviceWorker
    ) {
      try {
        Object.defineProperty(navigator.serviceWorker, 'controller', {
          configurable: true,
          get: () => null,
        });
      } catch {
        /* some engines make `controller` non-configurable — ignore */
      }
      void navigator.serviceWorker.ready
        .then((registration) => {
          const original = registration.showNotification?.bind(registration);
          registration.showNotification = ((
            title: string,
            options?: unknown,
          ) => {
            w.__notifications.push({ title, options });
            return original
              ? original(title, options as NotificationOptions)
              : Promise.resolve();
          }) as typeof registration.showNotification;
        })
        .catch(() => {
          /* no SW registration in this build — nothing to wrap */
        });
    }
  }

  const nativeExpected = isAndroidE2E;
  await page.addInitScript(install, nativeExpected);
  // Capacitor journeys stay in one WebView document while login navigates through
  // Angular. Install into that live document as well as future document loads.
  await page.evaluate(install, nativeExpected);
}

test.describe('Message notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ permissions: ['notifications'] });

  test('notifies for a live message in a room you are not viewing', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'native notification delivery needs an FCM integration environment; renderer notification assertions are web-only',
    );
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}n`;

    const { reader, readerUserId, sender, roomId, roomName, senderName } =
      await seedNotifyRoom(request, hs, runId);

    await installNotificationRecorder(page);
    await login(page, reader); // lands on /rooms (Home) — the seeded room isn't open

    // Home shows direct messages only (RoomsPage.visibleRooms()); our seeded room
    // is a plain (non-DM) room, so simply staying put after login already means
    // it is not the room open in the timeline. But wait for the room's own state
    // (name included) to have actually landed client-side before sending the live
    // message — peeking at the Rooms rail (without opening the channel, so the
    // room still isn't "viewed") gives a real signal to wait on instead of a
    // fixed sleep; sending too early raced the initial sync and the notification
    // title fell back to the SDK's synthesized "Empty room" placeholder.
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: roomName }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Home' }).click();

    const body = `hello from notify e2e ${runId}`;
    await postMessage(request, hs, sender, roomId, `notify-${runId}`, body);

    // Wait on the app's own recorded state, not a fixed sleep.
    await page.waitForFunction(
      (expectedBody) => {
        const w = window as unknown as {
          __notifications?: Array<{ title: string; options: unknown }>;
        };
        return (w.__notifications ?? []).some(
          (n) =>
            (n.options as { body?: string } | undefined)?.body === expectedBody,
        );
      },
      body,
      { timeout: 20_000, polling: 300 },
    );

    const notifications = await page.evaluate(
      () =>
        (
          window as unknown as {
            __notifications: Array<{
              title: string;
              options: { body?: string; tag?: string };
            }>;
          }
        ).__notifications,
    );
    const match = notifications.find((n) => n.options?.body === body);
    expect(match).toBeTruthy();
    // Title reflects the sender + room: `${sender} · ${room}`.
    expect(match?.title).toBe(`${senderName} · ${roomName}`);
    // tag = `${userId} ${roomId}` — collapses repeats from the same room per
    // account, so the same room on two accounts stays two distinct toasts.
    expect(match?.options?.tag).toBe(`${readerUserId} ${roomId}`);
  });

  test('suppresses a live message in the room you are currently viewing', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}s`;

    const { reader, sender, roomId, roomName } = await seedNotifyRoom(
      request,
      hs,
      runId,
    );

    await installNotificationRecorder(page);
    await login(page, reader);

    // Open the seeded room so it becomes TimelineService.openRoomId — Playwright
    // pages are focused, so this is the "actually looking at it" state that
    // should suppress the notification (see notification.service.ts maybeNotify).
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    // Confirm the room's timeline actually mounted before sending — otherwise a
    // message sent too early could land as part of the initial sync/backfill
    // rather than the live event this suppression rule is about.
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

    const before = await page.evaluate(
      () =>
        (window as unknown as { __notifications: unknown[] }).__notifications
          .length,
    );

    const body = `hello focused e2e ${runId}`;
    await postMessage(request, hs, sender, roomId, `focused-${runId}`, body);

    // Tie the "no notification" assertion to real app state: wait for the live
    // message to actually render in the open timeline (proof the event was
    // processed), then assert the notification count didn't move. Scoped to
    // the open timeline (`.scroll`) rather than the whole page — the sidebar's
    // `.channel__preview` row (ChannelSidebarComponent's last-message preview)
    // mirrors the same body text, which would otherwise make this locator
    // strict-mode-ambiguous.
    await expect(
      page.locator('.scroll').getByText(body, { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });

    const after = await page.evaluate(
      () =>
        (window as unknown as { __notifications: unknown[] }).__notifications
          .length,
    );
    expect(after).toBe(before);
  });
});

test.describe('Reaction notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ permissions: ['notifications'] });

  test('enables and persists grouped reactions, suppresses ineligible reactions, and opens the target', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'native notification delivery needs an FCM integration environment; renderer notification assertions are web-only',
    );
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
