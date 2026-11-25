import { devices } from '@playwright/test';
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
import { registerUser, apiLogin } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
  openSystemStatusFromRooms,
} from '../../../support/journeys/navigation.mts';
import { openNamedRoom } from '../../../support/message-composer.mts';
import { createRoom } from '../../support/space-journey.mts';

// End-to-end for member online-status (presence): the room member list renders a
// presence indicators from the SDK's User.presence through IdentityPresenceService.
// Unknown presence has no online/offline dot. The current user's known presence
// proves rendering, while injected read failure proves unknown state and targeted retry.
// Needs a Synapse homeserver (Docker); self-skips otherwise like the other web specs.
const session = homeserverSession();

/**
 * Register a reader plus a second member, have the reader create a plain (non-DM)
 * room and invite the member, and have the member join — so the room's member list
 * has two entries, each with an avatar to hang a presence dot on.
 */
async function seedRoomWithMember(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: HomeserverSession;
  member: Awaited<ReturnType<typeof apiLogin>>;
  roomId: string;
  roomName: string;
}> {
  const readerUser = `presence-reader-${runId}`;
  const readerPass = `presence-reader-pass-${runId}`;
  const memberUser = `presence-member-${runId}`;
  const memberPass = `presence-member-pass-${runId}`;
  const roomName = `Presence E2E ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, memberUser, memberPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const member = await apiLogin(request, hs, memberUser, memberPass);

  const roomId = await createRoom(request, hs, reader, roomName, {
    invite: [member.userId],
  });
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: member.headers },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    member,
    roomId,
    roomName,
  };
}

/** Open the seeded room and make sure the member panel is showing. */
async function openRoomWithMembers(
  page: Page,
  roomName: string,
): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

  const members = page.locator('.members');
  await expect(members).toBeHidden();
  await page.getByTestId('toggle-members').click();
  await expect(members).toBeVisible({ timeout: 15_000 });
}

/**
 * Register a reader + a DM partner, open a direct room between them (partner joins),
 * and record it in the reader's `m.direct` so the app treats it as a direct message.
 */
async function seedDirectMessage(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: HomeserverSession }> {
  const readerUser = `presence-dm-reader-${runId}`;
  const readerPass = `presence-dm-reader-pass-${runId}`;
  const partnerUser = `presence-dm-partner-${runId}`;
  const partnerPass = `presence-dm-partner-pass-${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, partnerUser, partnerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const partner = await apiLogin(request, hs, partnerUser, partnerPass);

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: {
        preset: 'private_chat',
        invite: [partner.userId],
        is_direct: true,
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: partner.headers },
  );
  // Record it as a DM in the reader's account data so the Home view lists it.
  await request.put(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(reader.userId)}/account_data/m.direct`,
    { headers: reader.headers, data: { [partner.userId]: [roomId] } },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
  };
}

test.describe('Member online status', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows known presence on member avatars in the member list', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}p`;
    const { reader, roomName } = await seedRoomWithMember(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoomWithMembers(page, roomName);

    // Both members render; only known presence carries an indicator.
    const rows = page.locator('.members .member');
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator('.members .presence-dot').first()).toBeVisible();

    // The dot is a real, labelled status indicator (role=img with an aria-label).
    const firstDot = page.locator('.members .presence-dot').first();
    await expect(firstDot).toHaveAttribute('role', 'img');
    await expect(firstDot).toHaveAttribute('aria-label', /Online|Away|Offline/);

    // The signed-in user is always online — the homeserver doesn't echo our own
    // presence, so this guards the "member list says I'm offline" regression.
    await expect(
      page.locator('.members .presence-dot[data-presence="online"]').first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('shows the other person’s presence on a direct-message row', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}d`;
    const { reader } = await seedDirectMessage(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);

    // The default Home view lists direct messages; only DM rows carry a presence dot,
    // so a dot in the room list proves the counterpart's status reaches the sidebar.
    await expect(page.locator('.channel .presence-dot').first()).toBeVisible({
      timeout: 30_000,
    });
  });
});

for (const mobile of [false, true]) {
  test.describe(
    mobile
      ? 'Presence on timeline avatars on mobile'
      : 'Presence on timeline avatars on desktop',
    () => {
      test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
      if (mobile) {
        const profile = devices['Pixel 5'];
        test.use({
          viewport: { width: 390, height: 844 },
          userAgent: profile.userAgent,
          deviceScaleFactor: profile.deviceScaleFactor,
          isMobile: profile.isMobile,
          hasTouch: profile.hasTouch,
        });
      } else {
        test.use({ viewport: { width: 1280, height: 800 } });
      }

      test('shows the sender’s presence on their message avatar until switched off', async ({
        page,
        request,
      }, testInfo) => {
        const hs = session.hs as string;
        const { reader, member, roomId, roomName } = await seedRoomWithMember(
          request,
          hs,
          testResourceId('avatar-presence'),
        );
        const body = `Avatar presence ${testResourceId('message')}`;
        // The member never syncs, so the server lets their presence lapse; set it again
        // before each check that needs it known.
        const setMemberAway = async (): Promise<void> => {
          const response = await request.put(
            `${hs}/_matrix/client/v3/presence/${encodeURIComponent(member.userId)}/status`,
            { headers: member.headers, data: { presence: 'unavailable' } },
          );
          expect(response.ok()).toBe(true);
        };
        const sent = await request.put(
          `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${testResourceId('txn')}`,
          { headers: member.headers, data: { msgtype: 'm.text', body } },
        );
        expect(sent.ok()).toBe(true);
        // After the send: sending marks the member active, which would read as online.
        await setMemberAway();

        await page.emulateMedia({ colorScheme: 'dark' });
        await login(page, reader);
        await openNamedRoom(page, roomName);

        const message = page
          .locator('trn-message-row')
          .filter({ hasText: body });
        const dot = message.locator('.msg__avatar .presence-dot');
        await expect(dot).toHaveAttribute('data-presence', 'unavailable', {
          timeout: 30_000,
        });
        await testInfo.attach('timeline-avatar-presence-on', {
          body: await page.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        });

        const setting = page.getByTestId('timeline-avatar-presence');
        const switchSetting = async (on: boolean): Promise<void> => {
          // A phone opens Settings from the room list, not from inside a room.
          await page.goto('/rooms');
          await openSettingsSection(page, 'appearance');
          await setting.scrollIntoViewIfNeeded();
          await expect(setting).toContainText(
            'Show presence on message avatars',
          );
          await setting.locator('trn-switch').click();
          await expect(setting.getByRole('switch')).toBeChecked({
            checked: on,
          });
        };

        await switchSetting(false);
        await testInfo.attach('timeline-avatar-presence-setting', {
          body: await page.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        });

        await page.goto('/rooms');
        await openNamedRoom(page, roomName);
        await expect(message).toBeVisible({ timeout: 30_000 });
        await expect(message.locator('.msg__avatar')).toBeVisible();
        await expect(dot).toHaveCount(0);
        await testInfo.attach('timeline-avatar-presence-off', {
          body: await page.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        });

        // Switching back on brings the dot back, so the empty check above was the setting
        // at work and not presence that had lapsed.
        await switchSetting(true);
        await setMemberAway();
        await page.goto('/rooms');
        await openNamedRoom(page, roomName);
        await expect(dot).toHaveAttribute('data-presence', 'unavailable', {
          timeout: 30_000,
        });
      });

      test('keeps the status you chose, on your own messages, in the user panel and on the server', async ({
        page,
        request,
      }, testInfo) => {
        const { reader, roomName } = await seedRoomWithMember(
          request,
          session.hs as string,
          testResourceId('own-presence'),
        );
        const body = `Own presence ${testResourceId('message')}`;

        await page.emulateMedia({ colorScheme: 'dark' });
        await login(page, reader);
        await openNamedRoom(page, roomName);
        await page.getByTestId('composer-input').fill(body);
        await page.getByTestId('composer-send').click();
        const dot = page
          .locator('trn-message-row')
          .filter({ hasText: body })
          .locator('.msg__avatar .presence-dot');
        await expect(dot).toHaveAttribute('data-presence', 'online', {
          timeout: 30_000,
        });

        await page.goto('/rooms');
        await openSettingsSection(page, 'presence');
        await page.getByTestId('presence-unavailable').click();
        await page.getByTestId('presence-save').click();
        await expect(page.getByTestId('presence-saved')).toBeVisible({
          timeout: 15_000,
        });
        // A sync the client starts after the save: one that omits set_presence marks you online.
        const syncAfterSave = await page.waitForRequest(
          (r) => r.url().includes('/_matrix/client/v3/sync'),
          { timeout: 45_000 },
        );

        // Closed in place: a page load is a new session, whose first sync resets the status.
        await closeSettings(page);
        await openNamedRoom(page, roomName);
        await expect(dot).toHaveAttribute('data-presence', 'unavailable', {
          timeout: 30_000,
        });
        if (!mobile) {
          await expect(
            page.getByTestId('user-menu-trigger').locator('.presence-dot'),
          ).toHaveAttribute('data-presence', 'unavailable');
        }
        await syncAfterSave.response();
        const observer = await apiLogin(
          request,
          session.hs as string,
          reader.user,
          reader.pass,
        );
        const status = await request.get(
          `${session.hs}/_matrix/client/v3/presence/${encodeURIComponent(observer.userId)}/status`,
          { headers: observer.headers },
        );
        expect((await status.json()).presence).toBe('unavailable');
        await testInfo.attach('own-presence-away', {
          body: await page.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        });
      });
    },
  );
}

// Inject at the producer read seam using Angular's development-only debug API.
// The actual Projection Runtime, Identity lifetime, health policy and UI retry run unchanged.
interface PresenceFaultWindow extends Window {
  ng: {
    getComponent(element: Element): {
      runtime: {
        adapter: {
          session: {
            identity: {
              matrix: { activeAccountId(): string };
              presence: {
                presenceFor(userId: string): () => unknown;
                currentPresence: (...args: unknown[]) => unknown;
                projection: { schedule(): void };
              };
            };
          };
        };
      };
    };
  };
  restorePresenceRead?: () => void;
  currentPresenceValue?: () => unknown;
}

for (const mobile of [false, true]) {
  test.describe(
    mobile ? 'Presence recovery on mobile' : 'Presence recovery on desktop',
    () => {
      test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
      if (mobile) {
        const profile = devices['Pixel 5'];
        test.use({
          viewport: profile.viewport,
          userAgent: profile.userAgent,
          deviceScaleFactor: profile.deviceScaleFactor,
          isMobile: profile.isMobile,
          hasTouch: profile.hasTouch,
        });
      }

      test('recovers a failed live presence projection without losing the Conversation', async ({
        page,
        request,
      }, testInfo) => {
        const { reader, roomName } = await seedRoomWithMember(
          request,
          session.hs as string,
          testResourceId('presence-recovery'),
        );
        await login(page, reader);
        await page.getByTestId('rail-rooms').click();
        await page.locator('.channel', { hasText: roomName }).first().click();
        await expect(page.getByTestId('composer-input')).toBeVisible({
          timeout: 30_000,
        });
        const conversationUrl = page.url();
        await page.evaluate(() => {
          const target = window as unknown as PresenceFaultWindow;
          const root = document.querySelector('trn-root');
          if (!root) throw new Error('Application root unavailable');
          const identity =
            target.ng.getComponent(root).runtime.adapter.session.identity;
          target.currentPresenceValue = identity.presence.presenceFor(
            identity.matrix.activeAccountId(),
          );
        });
        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as PresenceFaultWindow
              ).currentPresenceValue?.(),
            ),
          )
          .toBe('online');

        await page.evaluate(() => {
          const target = window as unknown as PresenceFaultWindow;
          const root = document.querySelector('trn-root');
          if (!root) throw new Error('Application root unavailable');
          const presence =
            target.ng.getComponent(root).runtime.adapter.session.identity
              .presence;
          const read = presence.currentPresence;
          target.restorePresenceRead = () => {
            presence.currentPresence = read;
          };
          presence.currentPresence = () => {
            throw new Error('synthetic private adapter response');
          };
          presence.projection.schedule();
        });
        await openSystemStatusFromRooms(page);
        const status = page.getByRole('dialog', { name: 'System status' });
        const problem = status
          .locator('article')
          .filter({ hasText: 'Presence is unavailable' });
        await expect(problem).toContainText('Online status may be out of date');
        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as PresenceFaultWindow
              ).currentPresenceValue?.(),
            ),
          )
          .toBeNull();
        await expect(page.getByTestId('composer-input')).toBeVisible();
        await expect(page).toHaveURL(conversationUrl);
        await testInfo.attach('presence-unavailable', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });

        await page.evaluate(() => {
          const target = window as unknown as PresenceFaultWindow;
          target.restorePresenceRead?.();
          delete target.restorePresenceRead;
        });
        await problem.getByRole('button', { name: 'Retry presence' }).click();
        await expect(problem).toHaveCount(0);
        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as PresenceFaultWindow
              ).currentPresenceValue?.(),
            ),
          )
          .toBe('online');
        await expect(page.getByTestId('composer-input')).toBeVisible();
        await expect(page).toHaveURL(conversationUrl);
        await status.getByRole('button', { name: 'Close' }).click();
        await testInfo.attach('presence-recovered', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      });
    },
  );
}
