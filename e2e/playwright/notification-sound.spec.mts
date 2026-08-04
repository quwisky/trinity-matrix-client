import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the global "Play a sound" switch (Settings → Notifications). It is implemented as
// the `sound` tweak on the predefined push rules, NOT as a local flag — so the assertion is
// what the SERVER holds afterwards, read straight back from /pushrules. That is the whole
// claim: the choice travels with the account, so silencing here silences the phone too and
// shows up in Element, which reads the same rules.
//
// Asserted against the real ruleset rather than a fixture because the set of rules that even
// HAVE a sound is a property of the homeserver: measured on Synapse 1.119 there are seven,
// and `.m.rule.call` is the only one whose tone is `ring` rather than `default`. A fixture
// would have encoded my assumption instead of the server's behaviour.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

interface Rule {
  rule_id: string;
  actions: unknown[];
}

/** Every rule the account has that still carries a `sound` tweak, with its tone. */
async function soundedRules(
  request: APIRequestContext,
  hs: string,
  token: string,
): Promise<Record<string, string>> {
  const rules = await request
    .get(`${hs}/_matrix/client/v3/pushrules/`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .then((r) => r.json());
  const found: Record<string, string> = {};
  for (const kind of ['override', 'content', 'room', 'sender', 'underride']) {
    for (const rule of (rules.global?.[kind] ?? []) as Rule[]) {
      for (const action of rule.actions) {
        if (
          !!action &&
          typeof action === 'object' &&
          (action as { set_tweak?: string }).set_tweak === 'sound'
        ) {
          found[rule.rule_id] = String(
            (action as { value?: unknown }).value ?? 'default',
          );
        }
      }
    }
  }
  return found;
}

test.describe('Notification sound', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('silences every sounded push rule, and restores each one’s own tone', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}snd`;
    const user = `sound-${runId}`;
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

    // What the server ships with, before Trinity touches anything.
    const before = await soundedRules(request, hs, token);
    expect(Object.keys(before).length).toBeGreaterThan(0);
    // The one that is not `default` — restoring a single tone for all of them would
    // quietly replace the ring with the message chime.
    expect(before['.m.rule.call']).toBe('ring');

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-notifications').click();
    await page.waitForURL(/\/settings\/notifications$/, { timeout: 20_000 });

    const sound = page.getByTestId('notif-sound');
    await expect(sound).toBeVisible({ timeout: 15_000 });
    await sound.click();

    // Silenced on the SERVER, not just in this window.
    await expect
      .poll(
        async () => Object.keys(await soundedRules(request, hs, token)).length,
        { timeout: 30_000 },
      )
      .toBe(0);

    // Back on: each rule gets ITS tone back, not one tone for all of them.
    await sound.click();
    await expect
      .poll(
        async () => (await soundedRules(request, hs, token))['.m.rule.call'],
        { timeout: 30_000 },
      )
      .toBe('ring');
    expect(await soundedRules(request, hs, token)).toEqual(before);
  });
});
