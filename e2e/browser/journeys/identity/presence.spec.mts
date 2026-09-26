import { captureScreenshot } from '../../../support/screenshot.mts';
import { devices } from '@playwright/test';
import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// End-to-end for member online-status (presence) recovery: an injected read failure
// proves the unknown state and targeted retry without losing the Conversation. Known
// presence rendering runs on Android through android.identity-presence (#674).
// Needs a Synapse homeserver (Docker); self-skips otherwise like the other web specs.
const session = synapseSession();

interface ApiUser {
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
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/**
 * Register a reader plus a second member, have the reader create a plain (non-DM)
 * room and invite the member, and have the member join — so the room's member list
 * has two entries, each with an avatar to hang a presence dot on.
 */
async function seedRoomWithMember(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; roomName: string }> {
  const readerUser = `presence-reader-${runId}`;
  const readerPass = `presence-reader-pass-${runId}`;
  const memberUser = `presence-member-${runId}`;
  const memberPass = `presence-member-pass-${runId}`;
  const roomName = `Presence E2E ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, memberUser, memberPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const member = await apiLogin(request, hs, memberUser, memberPass);

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName, invite: [member.userId] },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: member.headers },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
  };
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
        test.skip(
          process.env['TRINITY_E2E_PLATFORM'] === 'android',
          'fault injection requires Angular development hooks; the installed APK is production',
        );
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
        await page
          .getByTestId('app-capability-summary')
          .getByRole('button', { name: 'System Status' })
          .click();
        const status = page.getByRole('dialog', { name: 'System Status' });
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
          body: await captureScreenshot(page, () => page.screenshot()),
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
          body: await captureScreenshot(page, () => page.screenshot()),
          contentType: 'image/png',
        });
      });
    },
  );
}
