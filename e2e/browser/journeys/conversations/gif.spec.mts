import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  fillLabeledInput,
  login,
  readPreference,
  seedPreference,
  homeserverSession,
  waitForRooms,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  registerUser,
  apiLogin,
  type ApiUser,
} from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import { createRoom } from '../../support/space-journey.mts';

// GIF picker journeys. The send path round-trips through the REAL disposable
// Synapse (upload → m.image → sync), like every app-journey spec; only the
// external GIF provider (KLIPY) + its CDN are stubbed with page.route, so the
// suite stays offline of any third-party API and needs no real API key. Requires
// the Synapse homeserver, so it self-skips when Docker is absent.
const session = homeserverSession();

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

/** Register a fresh user and give them a plain (non-DM) room to send into. */
async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  // seedRoom always registers a user, so narrow away HomeserverSession's optionals.
  reader: HomeserverSession & { user: string; pass: string };
  roomName: string;
  roomId: string;
  api: ApiUser;
}> {
  const user = `gif-${runId}`;
  const pass = `gif-pass-${runId}`;
  const roomName = `GIF E2E ${runId}`;
  await registerUser(request, user, pass);
  const api = await apiLogin(request, hs, user, pass);
  const roomId = await createRoom(request, hs, api, roomName);
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

  test('offers no GIFs tab until a provider is configured', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}h`;
    const { reader, roomName } = await seedRoom(request, hs, runId);

    await login(page, reader);
    await openSeededRoom(page, roomName);

    // Composer is present, but the GIF affordance is not (no key configured): the
    // expression panel opens on the emoji picker with no GIFs tab.
    await expect(page.locator('textarea.composer__input')).toBeVisible();
    await page.getByTestId('composer-expressions').click();
    await expect(page.getByTestId('emoji-picker')).toBeVisible();
    await expect(page.getByTestId('expression-tab-gif')).toHaveCount(0);
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

    // Open the GIFs tab of the expression panel → trending loads (stubbed) → a result
    // renders.
    await page.getByTestId('composer-expressions').click();
    await page.getByTestId('expression-tab-gif').click();
    await expect(page.getByTestId('gif-search')).toBeFocused();
    // Shift+Tab from the search returns to the selected tab, the row's only tab stop.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('expression-tab-gif')).toBeFocused();
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

  test('opens as a bottom sheet on a 390×844 phone and sends a GIF from it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}p`;
    const { reader, roomName } = await seedRoom(request, hs, runId);

    await page.setViewportSize({ width: 390, height: 844 });
    await seedPreference(
      page,
      GIF_CONFIG_KEY,
      JSON.stringify({ provider: 'klipy', apiKey: 'e2e-key' }),
    );
    await stubKlipy(page);
    await login(page, reader);
    await openSeededRoom(page, roomName);

    // Chromium cannot raise an on-screen keyboard here, so stand in for the visual viewport
    // the way iOS reports one: the layout viewport keeps its 844px and the visible part
    // shrinks above the keyboard. The sheet reads it when it opens.
    await page.evaluate(() => {
      class KeyboardViewport extends EventTarget {
        height = window.innerHeight;
        width = window.innerWidth;
        offsetTop = 0;
        offsetLeft = 0;
        pageTop = 0;
        pageLeft = 0;
        scale = 1;
      }
      const viewport = new KeyboardViewport();
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: viewport,
      });
      Object.assign(window, {
        e2eKeyboard: (covered: number) => {
          viewport.height = window.innerHeight - covered;
          viewport.dispatchEvent(new Event('resize'));
        },
      });
    });
    const keyboard = (covered: number) =>
      page.evaluate(
        (height) =>
          (
            window as unknown as { e2eKeyboard: (h: number) => void }
          ).e2eKeyboard(height),
        covered,
      );
    const settle = () =>
      page.waitForFunction(() =>
        document
          .getAnimations()
          .every((animation) => animation.playState !== 'running'),
      );

    const trigger = page.getByTestId('composer-expressions');
    await trigger.click();
    const sheet = page.locator('trn-sheet-frame');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('sheet-handle')).toBeVisible();
    // It opens on Emoji, and focus goes on into the emoji search once the grid loads.
    const emojiSearch = sheet.locator('.emoji-mart-search input');
    await expect(emojiSearch).toBeFocused({ timeout: 20_000 });

    // A 334px keyboard: the sheet lifts above it and the search stays visible.
    await keyboard(334);
    await settle();
    const lifted = await sheet.boundingBox();
    expect((lifted?.y ?? 0) + (lifted?.height ?? 0)).toBeLessThanOrEqual(
      844 - 334 + 1,
    );
    expect(lifted?.y).toBeGreaterThanOrEqual(0);
    const search = await emojiSearch.boundingBox();
    expect(search?.y).toBeGreaterThanOrEqual(lifted?.y ?? 0);
    expect((search?.y ?? 0) + (search?.height ?? 0)).toBeLessThanOrEqual(
      844 - 334,
    );
    await keyboard(0);
    await expect(sheet.getByTestId('expression-picker')).toHaveAttribute(
      'data-presentation',
      'sheet',
    );
    // Full width and back at the bottom, once settled.
    await settle();
    const box = await sheet.boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBe(390);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(844 - 2);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);

    // The same tabs; the GIF tab moves focus into its search.
    await sheet.getByTestId('expression-tab-gif').click();
    await expect(sheet.getByTestId('gif-search')).toBeFocused();
    const firstResult = sheet.getByTestId('gif-result').first();
    await expect(firstResult).toBeVisible({ timeout: 15_000 });
    await firstResult.click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-testid="media-bubble"][data-media-state="ready"]',
        ),
      undefined,
      { timeout: 60_000, polling: 250 },
    );

    // It reopens on the tab used last, and closing it hands focus back to the trigger.
    await trigger.click();
    await expect(
      page.locator('trn-sheet-frame').getByTestId('expression-tab-gif'),
    ).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('trn-sheet-frame')).toBeHidden();
    await expect(trigger).toBeFocused();
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

    // The GIFs tab is still there under B: the key is global, not account-scoped.
    await page.getByTestId('composer-expressions').click();
    await expect(page.getByTestId('expression-tab-gif')).toBeVisible();
    await page.getByTestId('expression-tab-gif').click();
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
