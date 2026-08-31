import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../fixtures.mts';
import {
  fillLabeledInput,
  login,
  readPreference,
  seedPreference,
  synapseSession,
  waitForRooms,
  type SynapseSession,
} from '../support/app.mts';
import { registerUser } from '../support/account.mts';
import { openSettingsSection } from '../support/journeys/navigation.mts';

// GIF picker journeys. The send path round-trips through the REAL disposable
// Synapse (upload → m.image → sync), like every app-journey spec; only the
// external GIF provider (KLIPY) + its CDN are stubbed with page.route, so the
// suite stays offline of any third-party API and needs no real API key. Requires
// the Synapse homeserver, so it self-skips when Docker is absent.
const session = synapseSession();

// The admin API + shared-secret used to register throwaway users (hardcoded in
// every spec — there is no shared module for them).

// A real, decodable 1×1 transparent GIF, served for both the picker preview and
// the full download so the send round-trips genuine image bytes.
const GIF_1x1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);
const PREVIEW_URL = 'https://media.klipy.com/e2e-preview/trinity.gif';
const FULL_URL = 'https://media.klipy.com/e2e-full/trinity.gif';

const GIF_CONFIG_KEY = 'trinity.gif.config';

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
    token: json.access_token as string,
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/** Register a fresh user and give them a plain (non-DM) room to send into. */
async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  // seedRoom always registers a user, so narrow away SynapseSession's optionals.
  reader: SynapseSession & { user: string; pass: string };
  roomName: string;
  roomId: string;
  api: ApiUser;
}> {
  const user = `gif-${runId}`;
  const pass = `gif-pass-${runId}`;
  const roomName = `GIF E2E ${runId}`;
  await registerUser(request, user, pass);
  const api = await apiLogin(request, hs, user, pass);
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: api.headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  return { reader: { available: true, hs, user, pass }, roomName, roomId, api };
}

/** Drive the user-panel "Add account" flow through to a signed-in second account.
 * Mirrors multi-account.spec.mts — each spec hardcodes its own copy. */
async function addAccountViaUi(
  page: Page,
  hs: string,
  user: string,
  pass: string,
): Promise<void> {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('cancel-add')).toBeVisible();
  await fillLabeledInput(page, 'Homeserver', hs);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', user);
  await fillLabeledInput(page, 'Password', pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForRooms(page);
}

interface TimelineEvent {
  type?: string;
  sender?: string;
  content?: { msgtype?: string };
}

/** The sender of the newest `m.image` in a room, or null if none has landed yet. */
async function latestImageSender(
  request: APIRequestContext,
  hs: string,
  api: ApiUser,
  roomId: string,
): Promise<string | null> {
  const json = await request
    .get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
      { headers: api.headers },
    )
    .then((r) => r.json());
  // `dir=b` walks backwards from the live edge, so the first match is the newest.
  const image = ((json.chunk ?? []) as TimelineEvent[]).find(
    (e) => e.type === 'm.room.message' && e.content?.msgtype === 'm.image',
  );
  return image?.sender ?? null;
}

/** Stub the KLIPY search API + its CDN so the picker is hermetic of any provider. */
async function stubKlipy(page: Page): Promise<void> {
  // Both /featured (trending) and /search return the same single result.
  await page.route('https://api.klipy.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            id: 'e2e-1',
            content_description: 'e2e gif',
            media_formats: {
              gif: { url: FULL_URL, dims: [1, 1] },
              tinygif: { url: PREVIEW_URL, dims: [1, 1] },
            },
          },
        ],
      }),
    }),
  );
  // Preview + full-download hits both resolve to real GIF bytes.
  await page.route('https://media.klipy.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: GIF_1x1 }),
  );
}

/** Reveal the seeded (non-DM) room under the Rooms rail and open its timeline. */
async function openSeededRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

test.describe('GIF picker', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('configures a GIF provider + API key in Settings and can clear it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}s`;
    const { reader } = await seedRoom(request, hs, runId);

    await login(page, reader);
    // GIF config lives on the GIFs section sub-page of the settings submenu.
    await openSettingsSection(page, 'gifs');

    const read = (): Promise<string | null> =>
      readPreference(page, GIF_CONFIG_KEY);
    expect(await read()).toBeNull(); // unconfigured → composer hides the GIF button

    await page.getByTestId('gif-provider-giphy').click();
    await page.getByTestId('gif-api-key').fill('e2e-secret-key');
    await page.getByTestId('gif-save').click();

    // Persisted to Preferences, and the Clear affordance appears.
    await expect.poll(read).not.toBeNull();
    expect(JSON.parse((await read()) as string)).toMatchObject({
      provider: 'giphy',
      apiKey: 'e2e-secret-key',
    });
    await expect(page.getByTestId('gif-clear')).toBeVisible();

    // Clear drops the API key (disabling the picker) but must REMEMBER the provider:
    // both live in one stored blob, so removing the whole thing would silently reset
    // the choice to the KLIPY default.
    await page.getByTestId('gif-clear').click();
    await expect
      .poll(async () => JSON.parse((await read()) ?? '{}'))
      .toMatchObject({ provider: 'giphy', apiKey: '' });
    await expect(page.getByTestId('gif-clear')).toHaveCount(0); // picker disabled

    // The remembered choice survives a reload: navigate to the deliberate routed
    // deep-link fallback, then reload that GIFs sub-page.
    // restores and the key field is still GIPHY's, not KLIPY's (GifSettingsService
    // .init reads the provider back at startup).
    await page.goto('/settings/gifs');
    await page.reload();
    await page.waitForURL(/\/settings\/gifs$/, { timeout: 20_000 });
    await expect(page.locator('label[for="gif-api-key"]')).toHaveText(
      'GIPHY API key',
      { timeout: 15_000 },
    );
  });

  test('omits GIF from the tray until a provider is configured', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}h`;
    const { reader, roomName } = await seedRoom(request, hs, runId);

    await login(page, reader);
    await openSeededRoom(page, roomName);

    // Composer is present, but the GIF affordance is not (no key configured): the `+`
    // tray opens without a GIF item.
    await expect(page.locator('textarea.composer__input')).toBeVisible();
    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-attach')).toBeVisible();
    await expect(page.getByTestId('insert-gif')).toHaveCount(0);
  });

  test('searches GIFs and sends the chosen one as an image message', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}g`;
    const { reader, roomName } = await seedRoom(request, hs, runId);

    // Enable the picker before the app boots, and stub the provider API + CDN.
    await seedPreference(
      page,
      GIF_CONFIG_KEY,
      JSON.stringify({ provider: 'klipy', apiKey: 'e2e-key' }),
    );
    await stubKlipy(page);

    await login(page, reader);
    await openSeededRoom(page, roomName);

    // Open the picker from the `+` tray → trending loads (stubbed) → a result renders.
    await page.getByTestId('composer-insert').click();
    await page.getByTestId('insert-gif').click();
    await expect(page.getByTestId('gif-search')).toBeVisible();
    const firstResult = page.getByTestId('gif-result').first();
    await expect(firstResult).toBeVisible({ timeout: 15_000 });

    // Pick it → download (stubbed) → upload to the real HS → m.image echoes back
    // and resolves to a ready media bubble in the timeline.
    await firstResult.click();
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-testid="media-bubble"][data-media-state="ready"]',
        ),
      undefined,
      { timeout: 60_000, polling: 250 },
    );
  });

  test('sends a GIF as the active account after an account switch', async ({
    page,
    request,
  }) => {
    // The GIF picker was built before concurrent multi-account landed. Two things
    // have to hold once both exist: the GIF config is global (one API key serves
    // every signed-in account, so the button survives a switch), and the send path
    // resolves the *active* account's client — a GIF picked while account B is
    // foregrounded must be uploaded and posted by B, never by A.
    test.setTimeout(120_000); // two full UI logins plus a media round-trip

    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ma`;
    const b = await seedRoom(request, hs, runId);

    await seedPreference(
      page,
      GIF_CONFIG_KEY,
      JSON.stringify({ provider: 'klipy', apiKey: 'e2e-key' }),
    );
    await stubKlipy(page);

    // Sign in as account A (the seeded session user), then add B — B becomes active.
    await login(page, session);
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${session.user}:`,
    );
    await addAccountViaUi(page, hs, b.reader.user, b.reader.pass);
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${b.reader.user}:`,
    );

    // B's own room. A is not a member, so reaching its timeline at all already means
    // we're driving B's client.
    await openSeededRoom(page, b.roomName);

    // The GIF item is still there under B: the key is global, not account-scoped.
    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-gif')).toBeVisible();
    await page.getByTestId('insert-gif').click();
    const firstResult = page.getByTestId('gif-result').first();
    await expect(firstResult).toBeVisible({ timeout: 15_000 });
    await firstResult.click();

    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-testid="media-bubble"][data-media-state="ready"]',
        ),
      undefined,
      { timeout: 60_000, polling: 250 },
    );

    // Ask the homeserver who actually sent it. If the send path had captured account
    // A's client, this would be A's mxid (or the event would never exist, since A
    // cannot post to B's room).
    await expect
      .poll(() => latestImageSender(request, hs, b.api, b.roomId), {
        timeout: 30_000,
        intervals: [500],
      })
      .toBe(b.api.userId);
  });
});
