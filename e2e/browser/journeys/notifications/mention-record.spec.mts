import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { apiLogin, type ApiUser } from '../../../support/account.mts';
import {
  deviceKeysPublished,
  fillLabeledInput,
  login,
  waitForSent,
} from '../../../support/app.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import { sendComposerLines } from '../../../support/message-composer.mts';
import { MatrixTestResources } from '../../../support/test-resources.mts';
import { sendWithRetry } from '../../support/cs-api.mts';
import {
  createEncryptedRoom,
  freshAccount,
  openRoom,
  setUpEncryption,
} from '../../support/encryption-journey.mts';
import {
  KEYWORD,
  openInbox,
  seedInbox,
  watchConsoleErrors,
  type InboxSeed,
} from '../../support/inbox-journey.mts';
import {
  addAccountViaUi,
  configureMultiAccountSuite,
  registerRoomCleanup,
  session,
} from '../../support/multi-account-journey.mts';
import { installLiveNotificationRecorder } from '../../support/notification-journey.mts';
import { openWaitingTab } from '../../support/session-tabs.mts';
import { waitForPersistedSync } from '../../support/sync-cache.mts';

// The on-device record of mentions in the real app, read back from the real IndexedDB store. A
// first sync records nothing, so every journey signs in, waits for that sync to end, and only then
// posts the mentions it expects to find.
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SYNC_PATH = /^\/_matrix\/client\/[^/]+\/sync$/;
const SENTENCE =
  "This also deletes this account's mention history on this device.";
const NOTIFICATIONS = '**/_matrix/client/v3/notifications**';

interface StoredRow {
  readonly accountId: string;
  readonly eventId: string;
  readonly roomId: string;
  readonly ts: number;
}

/** Every row in the database, without creating it: an empty one would stop the app's upgrade. */
function storedRows(page: Page): Promise<StoredRow[]> {
  return page.evaluate(
    () =>
      new Promise<StoredRow[]>((resolve, reject) => {
        const open = indexedDB.open('trinity-mention-index');
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          // This read must not be what blocks the app's own delete.
          db.onversionchange = () => db.close();
          const all = db
            .transaction('mentions')
            .objectStore('mentions')
            .getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            db.close();
            resolve(all.result as StoredRow[]);
          };
        };
      }),
  );
}

async function storedIds(page: Page): Promise<string[]> {
  return (await storedRows(page)).map((row) => row.eventId);
}

const rows = (page: Page) => page.getByTestId('inbox-row');
const recordSwitch = (page: Page) =>
  page.getByRole('switch', {
    name: 'Keep a record of mentions on this device',
  });
const inboxSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'Show the inbox' });
const question = (page: Page) =>
  page.locator('trn-alert-dialog', {
    hasText: "Delete this device's mention history?",
  });

/** Stands in for a server that has forgotten its list, so only the record can show a row. */
async function serverListsNothing(page: Page): Promise<void> {
  await page.route(NOTIFICATIONS, (route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
}

/** Signs in and waits until the first sync has ended, so later mentions are live. */
async function signIn(
  page: Page,
  account: { readonly user: string; readonly pass: string },
): Promise<void> {
  await login(page, { available: true, hs: session.hs, ...account });
  await waitForPersistedSync(page, account.user);
}

/** Posts a mention and waits for the store to hold it. */
async function recordMention(
  page: Page,
  seed: InboxSeed,
  body = `${KEYWORD} recorded`,
): Promise<string> {
  const id = await seed.post(body);
  await expect.poll(() => storedIds(page)).toContain(id);
  return id;
}

/** Posts a message and waits for the app to have received it, which no switch can change. */
async function postAndAwaitSync(
  page: Page,
  seed: InboxSeed,
  body: string,
): Promise<void> {
  const carried = page.waitForResponse(
    async (response) =>
      SYNC_PATH.test(new URL(response.url()).pathname) &&
      response.ok() &&
      (await response.text()).includes(body),
  );
  await seed.post(body);
  await carried;
}

/** A room name only the reader and `sender` share, encrypted from its creation. */
async function encryptedRoomWith(
  request: APIRequestContext,
  resources: MatrixTestResources,
  reader: ApiUser,
  sender: ApiUser,
): Promise<{ readonly roomId: string; readonly roomName: string }> {
  const hs = session.hs as string;
  const roomName = resources.roomName('inbox-encrypted');
  const roomId = await createEncryptedRoom(request, hs, reader, roomName);
  const room = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  const invited = await request.post(`${room}/invite`, {
    headers: reader.headers,
    data: { user_id: sender.userId },
  });
  expect(invited.ok()).toBe(true);
  const joined = await request.post(`${room}/join`, {
    headers: sender.headers,
  });
  expect(joined.ok()).toBe(true);
  registerRoomCleanup(resources, request, hs, roomId, [reader, sender]);
  return { roomId, roomName };
}

/** Copied from room-notifications: the Matrix v1.7+ form of a mentions-only room. */
async function setRemoteMentions(
  request: APIRequestContext,
  reader: ApiUser,
  roomId: string,
): Promise<void> {
  const added = await request.put(
    `${session.hs}/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(roomId)}`,
    { headers: reader.headers, data: { actions: [] } },
  );
  expect(added.ok()).toBe(true);
}

/** Sends from the sender's own app, so the reader has to decrypt it; returns the event id. */
async function sendEncrypted(page: Page, body: string): Promise<string> {
  await sendComposerLines(page, [body]);
  const sent = page.locator('.msg', { hasText: body });
  await waitForSent(sent);
  return (await sent.getAttribute('data-mid')) as string;
}

test.describe('Mention record', () => {
  configureMultiAccountSuite();
  const hs = (): string => session.hs as string;
  let consoleErrors: () => readonly string[] = () => [];

  test.beforeEach(({ page }) => {
    consoleErrors = watchConsoleErrors(page);
  });
  test.afterEach(() => {
    expect(consoleErrors(), 'console errors and CSP violations').toEqual([]);
  });

  test('an encrypted mention appears in Mentions, and opening it jumps to the message', async ({
    page,
    request,
    matrixResources,
    secondaryApp,
  }) => {
    test.slow();
    const seed = await seedInbox(request, hs(), matrixResources);
    const sender = await freshAccount(request, hs(), 'inbox-sender');
    const senderApi = await apiLogin(request, hs(), sender.user, sender.pass);
    const { roomId, roomName } = await encryptedRoomWith(
      request,
      matrixResources,
      seed.reader,
      senderApi,
    );

    const published = deviceKeysPublished(page);
    await signIn(page, seed);
    await published;
    await setUpEncryption(page, seed.pass);

    const senderPage = await secondaryApp.launch();
    await login(senderPage, sender.asSession);
    await openRoom(senderPage, roomName);
    const mention = `${KEYWORD} look at this secret`;
    const eventId = await sendEncrypted(senderPage, mention);

    const onServer = await request.get(
      `${hs()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
      { headers: seed.reader.headers },
    );
    expect(((await onServer.json()) as { type: string }).type).toBe(
      'm.room.encrypted',
    );
    await expect
      .poll(() => storedIds(page), { timeout: 60_000 })
      .toContain(eventId);

    // Enough later messages that the mention is out of the room's first screen.
    for (let i = 0; i < 40; i++) {
      await sendWithRetry(`filler ${i}`, () =>
        request.put(
          `${hs()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/filler-${i}`,
          {
            headers: senderApi.headers,
            data: { msgtype: 'm.text', body: `plain ${i}` },
          },
        ),
      );
    }

    await openInbox(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(mention);
    await expect(rows(page).first()).toContainText(roomName);

    await rows(page).first().click();
    await expect(
      page.locator('.scroll .msg', { hasText: mention }),
    ).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      roomName,
    );
  });

  test('an encrypted mention in a mentions-only room appears', async ({
    page,
    request,
    matrixResources,
    secondaryApp,
  }) => {
    test.slow();
    const seed = await seedInbox(request, hs(), matrixResources);
    const sender = await freshAccount(request, hs(), 'inbox-sender');
    const senderApi = await apiLogin(request, hs(), sender.user, sender.pass);
    const { roomId, roomName } = await encryptedRoomWith(
      request,
      matrixResources,
      seed.reader,
      senderApi,
    );
    await setRemoteMentions(request, seed.reader, roomId);

    const published = deviceKeysPublished(page);
    await signIn(page, seed);
    await published;
    await setUpEncryption(page, seed.pass);

    const senderPage = await secondaryApp.launch();
    await login(senderPage, sender.asSession);
    await openRoom(senderPage, roomName);
    const mention = `${KEYWORD} only the record has this`;
    const eventId = await sendEncrypted(senderPage, mention);

    await expect
      .poll(() => storedIds(page), { timeout: 60_000 })
      .toContain(eventId);

    // The server can't read the keyword and the room rule says not to notify, on any server.
    const listed = await request.get(
      `${hs()}/_matrix/client/v3/notifications?limit=50`,
      { headers: seed.reader.headers },
    );
    expect(listed.ok()).toBe(true);
    const { notifications } = (await listed.json()) as {
      notifications: { event: { event_id: string } }[];
    };
    expect(notifications.map((n) => n.event.event_id)).not.toContain(eventId);

    await openInbox(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(mention);

    // Still there from the store alone, with this session's memory gone.
    await page.reload();
    await expect(rows(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(rows(page).first()).toContainText(mention);
  });

  test('a mention sent while the app was closed is recorded on the next start', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await signIn(page, seed);
    const url = page.url();

    await page.goto('about:blank');
    const body = `${KEYWORD} while closed`;
    const closed = await seed.post(body);

    const firstBatch = page.waitForResponse(
      (response) =>
        SYNC_PATH.test(new URL(response.url()).pathname) && response.ok(),
    );
    await page.goto(url);
    // Strict on purpose: the mention must be in the very batch recording has to be up for.
    expect(await (await firstBatch).text()).toContain(closed);
    await expect.poll(() => storedIds(page)).toEqual([closed]);

    await openInbox(page);
    await expect(rows(page).first()).toContainText(body);
  });

  test('turning off the record asks first, Cancel keeps it, confirming removes older rows, a reload keeps them gone', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await serverListsNothing(page);
    const note = page.getByText(
      'Older mentions and mentions in encrypted rooms may be missing.',
    );
    await signIn(page, seed);
    await recordMention(page, seed, `${KEYWORD} one`);
    await recordMention(page, seed, `${KEYWORD} two`);

    await openInbox(page);
    await expect(rows(page)).toHaveCount(2);
    await expect(note).toHaveCount(0);

    await openSettingsSection(page, 'notifications');
    await expect(recordSwitch(page)).toBeChecked();
    await recordSwitch(page).click();
    await expect(question(page)).toContainText(
      'its record of 2 mentions on this device',
    );
    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(recordSwitch(page)).toBeChecked();
    await expect(recordSwitch(page)).toBeFocused();
    expect(await storedRows(page)).toHaveLength(2);

    await recordSwitch(page).click();
    await question(page)
      .getByRole('button', { name: 'Delete and turn off' })
      .click();
    await expect(recordSwitch(page)).not.toBeChecked();
    await expect.poll(() => storedRows(page)).toEqual([]);

    await closeSettings(page);
    await page.getByTestId('inbox-refresh').click();
    await expect(page.getByTestId('inbox-empty')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(note).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('inbox-empty')).toBeVisible({
      timeout: 30_000,
    });
    await expect(note).toBeVisible();
    expect(await storedRows(page)).toEqual([]);

    // Turning it back on asks nothing and starts from empty, leaving out what came while off.
    await openSettingsSection(page, 'notifications');
    await expect(recordSwitch(page)).not.toBeChecked();
    await postAndAwaitSync(page, seed, `${KEYWORD} while off`);
    await recordSwitch(page).click();
    await expect(recordSwitch(page)).toBeChecked();
    await expect(question(page)).toHaveCount(0);
    const again = await seed.post(`${KEYWORD} again`);
    await expect.poll(() => storedIds(page)).toEqual([again]);

    // A restart catches up from its saved position, which must not bring the deleted rows back.
    await page.reload();
    await expect(page.getByTestId('rail-inbox')).toBeVisible({
      timeout: 30_000,
    });
    const restarted = await seed.post(`${KEYWORD} restarted`);
    await expect.poll(() => storedIds(page)).toContain(restarted);
    expect((await storedIds(page)).sort()).toEqual([again, restarted].sort());
  });

  test('turning off the inbox removes the button, and turning it back on starts empty', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    let fetched = 0;
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname.endsWith('/v3/notifications')) {
        fetched += 1;
      }
    });
    await signIn(page, seed);
    await recordMention(page, seed);

    await openSettingsSection(page, 'notifications');
    await inboxSwitch(page).click();
    await expect(question(page)).toContainText(
      'its record of 1 mention on this device',
    );
    await question(page)
      .getByRole('button', { name: 'Delete and turn off' })
      .click();
    await expect(inboxSwitch(page)).not.toBeChecked();
    await expect(recordSwitch(page)).not.toBeChecked();
    await expect(recordSwitch(page)).toBeDisabled();
    await expect.poll(() => storedRows(page)).toEqual([]);
    await expect(page.getByTestId('rail-inbox')).toHaveCount(0);

    await postAndAwaitSync(page, seed, `${KEYWORD} while off`);
    expect(await storedRows(page)).toEqual([]);

    // Off survives a reload, and naming the view doesn't bring the inbox back.
    const url = new URL(page.url());
    url.searchParams.set('view', 'inbox');
    await page.goto(url.toString());
    await expect(page.getByTestId('rail-recent')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('rail-inbox')).toHaveCount(0);
    await expect(page.locator('trn-notification-inbox')).toHaveCount(0);
    expect(fetched).toBe(0);

    await serverListsNothing(page);
    await openSettingsSection(page, 'notifications');
    await inboxSwitch(page).click();
    await expect(inboxSwitch(page)).toBeChecked();
    await expect(recordSwitch(page)).toBeChecked();
    await expect(recordSwitch(page)).toBeEnabled();
    await expect(question(page)).toHaveCount(0);
    await closeSettings(page);

    await openInbox(page);
    await expect(page.getByTestId('inbox-empty')).toBeVisible();

    // Written after the one posted while off, so that one would show here if it had been kept.
    const again = await seed.post(`${KEYWORD} again`);
    await expect.poll(() => storedIds(page)).toEqual([again]);
  });

  test('the open inbox returns to Recent when turned off', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await signIn(page, seed);
    await openInbox(page);
    await expect(page.getByTestId('rail-inbox')).toHaveAttribute(
      'aria-current',
      'true',
    );

    await openSettingsSection(page, 'notifications');
    await inboxSwitch(page).click();
    // Nothing recorded, so nothing to ask about.
    await expect(inboxSwitch(page)).not.toBeChecked();
    await expect(question(page)).toHaveCount(0);
    await closeSettings(page);

    await expect(page.locator('trn-notification-inbox')).toHaveCount(0);
    await expect(page.getByTestId('rail-inbox')).toHaveCount(0);
    await expect(page.getByTestId('rail-recent')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect.poll(() => page.url()).not.toContain('view=inbox');
  });

  test('removal says so only with history, and clears it', async ({
    page,
    request,
    matrixResources,
  }) => {
    const namespace = matrixResources.namespace;
    const second = new MatrixTestResources({
      ...namespace,
      role: (name) => namespace.role(`b-${name}`),
    });
    const kept = await seedInbox(request, hs(), matrixResources);
    const removed = await seedInbox(request, hs(), second);
    await signIn(page, kept);
    const keptRow = await recordMention(page, kept);
    await addAccountViaUi(page, hs(), removed.user, removed.pass);
    await waitForPersistedSync(page, removed.user);

    const removal = page.getByRole('dialog', { name: 'Remove account' });
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await expect(removal).toContainText(removed.reader.userId);
    // The other account's history is not this one's.
    await expect(removal).not.toContainText(SENTENCE);
    await removal.getByRole('button', { name: 'Cancel' }).click();
    await expect(removal).toHaveCount(0);

    await recordMention(page, removed);
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await expect(removal).toContainText(SENTENCE);
    await removal.getByTestId('alert-confirm').click();
    await page
      .getByRole('dialog', { name: 'Room keys are not backed up' })
      .getByRole('button', { name: 'Remove anyway' })
      .click();

    await expect(page.locator('.userbar__handle')).toContainText(
      `@${kept.user}:`,
    );
    await expect.poll(() => storedIds(page)).toEqual([keptRow]);
  });

  test('the real store: limits, shape and clearing', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await signIn(page, seed);
    const body = `${KEYWORD} never written down`;
    await recordMention(page, seed, `${KEYWORD} creates the database`);

    const now = Date.now();
    await page.evaluate(
      ({ accountId, roomId, now, year }) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('trinity-mention-index');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('mentions', 'readwrite');
            const mentions = tx.objectStore('mentions');
            for (let i = 0; i < 2_000; i++) {
              mentions.put({
                accountId,
                roomId,
                eventId: `$seeded-${i}`,
                ts: now - 60_000 - i,
              });
            }
            mentions.put({
              accountId,
              roomId,
              eventId: '$past-a-year',
              ts: now - year - 60_000,
            });
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
          };
        }),
      {
        accountId: seed.reader.userId,
        roomId: seed.roomId,
        now,
        year: YEAR_MS,
      },
    );

    const newest = await seed.post(body);

    await expect.poll(() => storedIds(page)).toContain(newest);
    const stored = await storedRows(page);
    expect(stored).toHaveLength(2_000);
    const ids = stored.map((row) => row.eventId);
    expect(ids).not.toContain('$past-a-year');
    expect(ids).toContain('$seeded-0');
    // 2,000 seeded plus 2 real rows, so the two oldest seeded ones went.
    expect(ids).not.toContain('$seeded-1999');
    for (const row of stored) {
      expect(Object.keys(row).sort()).toEqual([
        'accountId',
        'eventId',
        'roomId',
        'ts',
      ]);
    }
    expect(JSON.stringify(stored)).not.toContain(KEYWORD);

    await openSettingsSection(page, 'notifications');
    await recordSwitch(page).click();
    await expect(question(page)).toContainText('its record of 2,000 mentions');
    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await closeSettings(page);

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await expect(
      page.getByRole('dialog', { name: 'Remove account' }),
    ).toContainText(SENTENCE);
    await page.getByTestId('alert-confirm').click();
    await page
      .getByRole('dialog', { name: 'Room keys are not backed up' })
      .getByRole('button', { name: 'Remove anyway' })
      .click();
    await page.waitForURL(/\/login/);
    await expect.poll(() => storedRows(page)).toEqual([]);
  });

  test.describe('with notifications allowed', () => {
    test.use({ permissions: ['notifications'] });

    test('a store that refuses writes leaves notifications working', async ({
      page,
      request,
      matrixResources,
    }) => {
      const seed = await seedInbox(request, hs(), matrixResources);
      await installLiveNotificationRecorder(page);
      await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          ...args: Parameters<typeof put>
        ) {
          if (this.name === 'mentions') {
            throw new DOMException('Full', 'QuotaExceededError');
          }
          return put.apply(this, args);
        };
      });
      await signIn(page, seed);
      const notified = (): Promise<string[]> =>
        page.evaluate(() =>
          (
            window as unknown as {
              __notifications: { options: { body?: string } }[];
            }
          ).__notifications.map(({ options }) => options.body ?? ''),
        );

      const stopped = page.waitForEvent('console', (message) =>
        message.text().includes('mention index: recording stopped'),
      );
      const first = `${KEYWORD} first`;
      await seed.post(first);
      await stopped;
      await expect.poll(notified).toContainEqual(first);

      const second = `${KEYWORD} second`;
      await seed.post(second);
      await expect.poll(notified).toContainEqual(second);
      expect(await storedRows(page)).toEqual([]);

      // The inbox falls back to the server's list.
      await openInbox(page);
      await expect(rows(page)).toHaveCount(2);
    });
  });

  test('a second tab does not record', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await signIn(page, seed);
    const first = await recordMention(page, seed, `${KEYWORD} before the tab`);

    await page.context().addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      const w = window as unknown as { mentionPuts: number };
      w.mentionPuts = 0;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<typeof put>
      ) {
        if (this.name === 'mentions') w.mentionPuts += 1;
        return put.apply(this, args);
      };
    });
    const { page: tab } = await openWaitingTab(page);

    const second = await recordMention(page, seed, `${KEYWORD} with the tab`);

    expect((await storedIds(page)).sort()).toEqual([first, second].sort());
    expect(
      await tab.evaluate(
        () => (window as unknown as { mentionPuts: number }).mentionPuts,
      ),
    ).toBe(0);
    await tab.close();
  });

  test('a store that refuses to delete says so, and Try again recovers', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await signIn(page, seed);
    await recordMention(page, seed);
    await openSettingsSection(page, 'notifications');
    // A connection left open blocks the delete.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open('trinity-mention-index');
          open.onsuccess = () => {
            (window as unknown as { held: IDBDatabase }).held = open.result;
            resolve();
          };
        }),
    );

    await recordSwitch(page).click();
    await question(page)
      .getByRole('button', { name: 'Delete and turn off' })
      .click();
    const failed = page.getByTestId('notif-mention-delete-failed');
    await expect(failed).toHaveText("Couldn't delete the record. Try again.", {
      timeout: 30_000,
    });
    await expect(recordSwitch(page)).not.toBeChecked();

    await page.evaluate(() =>
      (window as unknown as { held: IDBDatabase }).held.close(),
    );
    await page.getByTestId('notif-mention-delete-retry').click();
    await expect(failed).toHaveCount(0, { timeout: 30_000 });
    await expect(inboxSwitch(page)).toBeFocused();
    await expect.poll(() => storedRows(page)).toEqual([]);
  });

  test('signing in to a stored account asks first, Cancel keeps the history, Sign in anyway deletes it', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await signIn(page, seed);
    const recorded = await recordMention(page, seed);

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('add-account').click();
    await expect(page.getByTestId('cancel-add')).toBeVisible();
    await fillLabeledInput(page, 'Homeserver', hs());
    await page.getByText('Continue', { exact: true }).click();
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await submit.waitFor({ timeout: 30_000 });
    await fillLabeledInput(page, 'Username', seed.user);
    await fillLabeledInput(page, 'Password', seed.pass);
    await submit.click();
    const asked = page.locator('trn-alert-dialog', { hasText: SENTENCE });

    await expect(asked).toBeVisible({ timeout: 30_000 });
    await asked.getByRole('button', { name: 'Cancel' }).click();
    await expect(asked).toHaveCount(0);
    expect(await storedIds(page)).toEqual([recorded]);

    await submit.click();
    await expect(asked).toBeVisible({ timeout: 30_000 });
    await asked.getByRole('button', { name: 'Sign in anyway' }).click();

    // Written after the new client's catch-up, which starts from the old device's saved position,
    // so a deleted mention that catch-up brought back would be here by now.
    const after = await seed.post(`${KEYWORD} on the new device`);
    await expect
      .poll(() => storedIds(page), { timeout: 30_000 })
      .toEqual([after]);
  });
});
