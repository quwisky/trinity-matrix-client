import { test, expect } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the global Notifications settings (Settings → Notifications): each toggle maps
// to a predefined push rule and writes via PushRulesService.setOn → setPushRuleEnabled.
// Toggling "When someone posts @room" (the intentional-mention rule .m.rule.is_room_mention)
// must flip that rule's enabled flag on the homeserver. Needs a Synapse homeserver (Docker);
// self-skips otherwise.
const session = synapseSession();

const RULE_ID = '.m.rule.is_room_mention';

test.describe('Notification settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('toggling a rule flips its push-rule state on the server', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}n`;
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
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-notifications').click();
    await page.waitForURL(/\/settings\/notifications$/, { timeout: 20_000 });

    const checkbox = page.getByTestId(`notif-${RULE_ID}`).locator('trn-switch');
    await expect(checkbox).toBeVisible({ timeout: 15_000 });
    await checkbox.click();

    // The toggle round-trips: the rule's enabled flag flips server-side.
    await expect.poll(ruleEnabled, { timeout: 20_000 }).toBe(!before);
  });
});
