import { captureScreenshot } from '../../../support/screenshot.mts';
import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Covers the global Notifications settings (Settings → Notifications): each toggle maps
// to a predefined push rule and writes via PushRulesService.setOn → setPushRuleEnabled.
// Toggling "When someone posts @room" (the intentional-mention rule .m.rule.is_room_mention)
// must flip that rule's enabled flag on the homeserver. Needs a Synapse homeserver (Docker);
// self-skips otherwise.
const session = synapseSession();

const RULE_ID = '.m.rule.is_room_mention';

interface NotificationFaultWindow extends Window {
  ng: {
    getComponent(element: Element): {
      runtime: {
        state(): unknown;
        adapter: {
          session: {
            notificationLifetime: {
              roomNotifications: {
                rebindClients(): void;
                retryProjection(): void;
              };
            };
          };
        };
      };
    };
  };
  restoreNotificationRules?: () => void;
}

test.describe('Notification settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('toggling a rule flips its push-rule state on the server', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}n`;
    const user = `notif-user-${runId}`;
    const pass = `${user}-pass`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const auth = { Authorization: `Bearer ${token}` };

    const ruleEnabled = async (): Promise<boolean | undefined> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(RULE_ID)}`,
        { headers: auth },
      );
      return res.ok() ? (await res.json()).enabled : undefined;
    };
    const before = await ruleEnabled();

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSettingsSection(page, 'notifications');

    const checkbox = page.getByTestId(`notif-${RULE_ID}`).locator('trn-switch');
    await expect(checkbox).toBeVisible({ timeout: 15_000 });
    await checkbox.click();

    // The toggle round-trips: the rule's enabled flag flips server-side.
    await expect.poll(ruleEnabled, { timeout: 20_000 }).toBe(!before);
  });

  test('recovers Room-rule projection health without claiming delivery failed', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      process.env['TRINITY_E2E_PLATFORM'] === 'android',
      'fault injection requires Angular development hooks; the installed APK is production',
    );
    const hs = session.hs as string;
    const user = `notif-health-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const startupBlocked = page.getByTestId('app-startup-blocked');
    const runtimePhase = () =>
      page.evaluate(() => {
        const target = window as unknown as NotificationFaultWindow;
        const root = document.querySelector('trn-root');
        if (!root) throw new Error('Application root unavailable');
        const state = target.ng.getComponent(root).runtime.state();
        return (state as { readonly phase?: string }).phase;
      });
    await expect.poll(runtimePhase).toBe('ready');

    await page.evaluate(() => {
      const target = window as unknown as NotificationFaultWindow;
      const root = document.querySelector('trn-root');
      if (!root) throw new Error('Application root unavailable');
      const rules =
        target.ng.getComponent(root).runtime.adapter.session
          .notificationLifetime.roomNotifications;
      const rebind = rules.rebindClients;
      target.restoreNotificationRules = () => {
        rules.rebindClients = rebind;
      };
      rules.rebindClients = () => {
        throw new Error('synthetic private notification response');
      };
      rules.retryProjection();
    });

    await page
      .getByTestId('app-capability-summary')
      .getByRole('button', { name: 'System Status' })
      .click();
    const status = page.getByRole('dialog', { name: 'System Status' });
    const health = status
      .locator('article')
      .filter({ hasText: 'Room notification settings are unavailable' });
    await expect(health).toContainText(
      'Notification delivery continues independently',
    );
    await expect(health).not.toContainText('synthetic');
    await expect.poll(runtimePhase).toBe('ready');
    await testInfo.attach('notification-rules-unavailable', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });

    await page.evaluate(() => {
      const target = window as unknown as NotificationFaultWindow;
      target.restoreNotificationRules?.();
      delete target.restoreNotificationRules;
    });
    await health.getByRole('button', { name: 'Retry Room settings' }).click();
    await expect(startupBlocked).toHaveCount(0);
    await expect(health).toHaveCount(0);
    await status.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/\/rooms/);
    await testInfo.attach('notification-rules-recovered', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });
  });
});
