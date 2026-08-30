import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers starting cross-user verification from a member's info panel: "Verify"
// (data-testid="member-info-verify") ensures a DM with them and requests emoji-SAS
// verification (TrustVerificationService.startUserVerification → requestVerificationDM), after
// which the app's verification host presents the SAS page (data-testid="verify-page").
// The other side never responds here (no second client), so this asserts the flow
// *starts* — the SAS round-trip is covered by the crypto unit + e2e:verify suites.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
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

/** Give a UI client its own cross-signing identity before cross-user SAS starts. */
async function setUpEncryption(page: Page, password: string): Promise<void> {
  await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up encryption' }).click();

  const uia = page.locator('trn-alert-dialog');
  const key = page.getByTestId('recovery-key');
  const shown = await Promise.race([
    uia
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'uia')
      .catch(() => null),
    key
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'key')
      .catch(() => null),
  ]);
  if (shown === 'uia') {
    await uia.locator('input[type="password"]').fill(password);
    await uia.getByRole('button', { name: 'Confirm' }).click();
  }

  await key.waitFor({ state: 'visible', timeout: 60_000 });
  await page
    .getByRole('checkbox', { name: /I've saved my recovery key/ })
    .click();
  await page.getByRole('button', { name: 'Continue to Trinity' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
}

test.describe('Verify another user', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('starts cross-user verification from the member panel', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
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
    await setUpEncryption(page, mePass);

    // The counterpart must be a real crypto-capable client with its own
    // cross-signing identity. Android uses the separately packaged secondary
    // app, while web uses an isolated browser context through the same fixture.
    const otherPage = await secondaryApp.launch();
    await login(otherPage, {
      available: true,
      hs,
      user: other,
      pass: otherPass,
    } as SynapseSession);
    await setUpEncryption(otherPage, otherPass);
    await secondaryApp.activatePrimary();

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
