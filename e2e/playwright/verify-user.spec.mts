import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers starting cross-user verification from a member's info panel: "Verify"
// (data-testid="member-info-verify") ensures a DM with them and requests emoji-SAS
// verification (VerificationService.startUserVerification → requestVerificationDM), after
// which the app's verification host presents the SAS page (data-testid="verify-page").
// The other side never responds here (no second client), so this asserts the flow
// *starts* — the SAS round-trip is covered by the crypto unit + e2e:verify suites.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

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

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Verify another user', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  // Cross-user (SAS) verification requires BOTH parties to have a cross-signing
  // identity, but this harness logs the counterpart in via the raw API (no crypto),
  // and a freshly-logged-in initiator hasn't bootstrapped cross-signing either — so
  // requestVerificationDM can't establish a request and the verify page never opens.
  // Exercising the real handshake needs a second crypto-capable device the headless
  // harness can't provide; the member-panel wiring + startUserVerification are covered
  // by unit tests instead. Kept as documentation of the intended journey.
  test.fixme('starts cross-user verification from the member panel', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}vu`;
    const me = `verify-me-${runId}`;
    const mePass = `${me}-pass`;
    const other = `verify-other-${runId}`;
    const otherPass = `${other}-pass`;
    const roomName = `Verify ${runId}`;
    const otherName = `Other ${runId}`;

    await registerUser(request, me, mePass);
    await registerUser(request, other, otherPass);
    const admin = await apiLogin(request, hs, me, mePass);
    const otherUser = await apiLogin(request, hs, other, otherPass);

    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(otherUser.userId)}/displayname`,
      { headers: otherUser.headers, data: { displayname: otherName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: admin.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [otherUser.userId],
        },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: otherUser.headers },
    );

    await login(page, {
      available: true,
      hs,
      user: me,
      pass: mePass,
    } as SynapseSession);
    await openRoom(page, roomName);

    // Open the other member's info panel and start verifying them.
    const memberRow = page.locator('[data-testid="member-row"]', {
      hasText: otherName,
    });
    await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
    await memberRow.first().click();
    const panel = page.getByTestId('member-info');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.getByTestId('member-info-verify').click();

    // The request is sent and the SAS verification page is presented (the other
    // side never responds, so it stays in its requested/waiting stage).
    await expect(page.getByTestId('verify-page')).toBeVisible({
      timeout: 30_000,
    });
  });
});
