import { browser, expect } from '@wdio/globals';
import {
  login,
  tap,
  waitForDurableActiveAccount,
  waitForRooms,
} from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import { goBack, resetApp, restartApp } from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

/** iOS has no system Back for an open panel: MainViewController turns the edge swipe off. */
const PANEL_BACK_ANDROID_ONLY =
  'iOS has no system Back for an open sheet or panel; MainViewController disables the edge swipe while Angular holds one';
const IME_BACK_ANDROID_ONLY =
  'Android consumes Back at the IME before the app; iOS has no system Back for an open panel';

const viewportHeight = (): Promise<number> =>
  browser.execute(() => window.visualViewport?.height ?? window.innerHeight);

const pathname = async (): Promise<string> =>
  new URL(await browser.getUrl()).pathname;

async function waitForPath(
  matches: (path: string) => boolean,
  label: string,
): Promise<void> {
  await browser.waitUntil(async () => matches(await pathname()), {
    timeout: 20_000,
    timeoutMsg: `never reached ${label}`,
  });
}

async function openSettingsFromRooms(): Promise<void> {
  await waitForRooms();
  await tap('[data-testid="open-settings"]');
  await waitForPath(
    (path) => path === '/settings' || path.startsWith('/settings/'),
    '/settings',
  );
  await expect($('//h1[normalize-space()="Settings"]')).toBeDisplayed({
    wait: 20_000,
  });
  await expect($('nav[aria-label="Settings sections"]')).toBeDisplayed();
}

async function seedComposerRoom(): Promise<{
  user: string;
  pass: string;
  roomName: string;
}> {
  const user = uniqueId('android-insert');
  const pass = `${user}-pass`;
  const roomName = `Android insert ${user}`;
  await registerUser(user, pass);
  await createRoom(await accessToken(user, pass), roomName);
  return { user, pass, roomName };
}

const clickButton = async (name: string): Promise<void> => {
  const button = $(
    `//button[normalize-space()="${name}" or @aria-label="${name}"]`,
  );
  await expect(button).toBeDisplayed({ wait: 20_000 });
  await button.click();
};

describe('mobile navigation', () => {
  beforeEach(resetApp);

  it('@renderer-smoke logs in, opens settings by touch, and goes Back', async () => {
    const user = uniqueId('android-nav');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsFromRooms();

    await goBack();
    await waitForRooms();
    await expect($('trn-rooms')).toBeDisplayed({ wait: 20_000 });
  });

  it('restores the authenticated route after a native process restart', async () => {
    const user = uniqueId('android-restart');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);

    const accountId = new URL(await browser.getUrl()).searchParams.get(
      'account',
    );
    if (!accountId) {
      throw new Error('Cannot verify authenticated restart without an account');
    }
    await waitForDurableActiveAccount(accountId);
    await restartApp();
    await waitForRooms();
    await expect($('trn-rooms')).toBeDisplayed({ wait: 30_000 });
  });

  it('drills into a section and restores its directory link on Back', async () => {
    const user = uniqueId('android-settings');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsFromRooms();

    const appearance = $('[data-testid="settings-nav-appearance"]');
    await expect(appearance).toBeDisplayed({ wait: 20_000 });
    expect(await appearance.getSize('height')).toBeGreaterThanOrEqual(44);
    await tap('[data-testid="settings-nav-appearance"]');
    await waitForPath(
      (path) => path.endsWith('/settings/appearance'),
      '/settings/appearance',
    );
    await expect($('#appearance-heading')).toBeFocused({ wait: 10_000 });

    await goBack();
    await waitForPath((path) => path.endsWith('/settings'), '/settings');
    await expect(appearance).toBeFocused({ wait: 10_000 });
    const horizontalOverflow = await browser.execute(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    await goBack();
    await waitForRooms();
    await expect($('trn-rooms')).toBeDisplayed({ wait: 20_000 });
  });

  it('dismisses the native keyboard before opening a bounded sheet and handles hardware Back', async function () {
    onlyOn('android', PANEL_BACK_ANDROID_ONLY).call(this);
    const { user, pass, roomName } = await seedComposerRoom();
    await login(user, pass);
    await $('[data-testid="rail-rooms"]').click();
    await expect($('[data-testid="rail-rooms"]')).toHaveAttribute(
      'aria-current',
      'true',
    );
    const room = $(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect(room).toBeDisplayed({ wait: 30_000 });
    await room.click();

    const composer = $('[data-testid="composer-input"]');
    await expect(composer).toBeDisplayed({ wait: 5_000 });
    const fullViewportHeight = await viewportHeight();
    await tap('[data-testid="composer-input"]');
    await browser.waitUntil(
      async () => (await viewportHeight()) < fullViewportHeight - 100,
      { timeout: 10_000, timeoutMsg: 'viewport never shrank for the IME' },
    );
    // One uncommitted token: Space would commit the composing word to the emulator
    // dictionary, whose autocorrect result is host-image dependent.
    await browser.keys('trinity42');
    await expect(composer).toHaveValue(/trinity42/i, { wait: 5_000 });
    const trigger = $('[data-testid="composer-insert"]');
    await tap('[data-testid="composer-insert"]');
    const sheet = $('[data-testid="action-sheet-surface"]');
    await expect(sheet).toBeDisplayed({ wait: 5_000 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Moving from the editor to the non-input `+` dismisses the IME; prove that before
    // measuring the sheet so the geometry cannot switch between keyboard and full viewports.
    await browser.waitUntil(
      async () => (await viewportHeight()) > fullViewportHeight - 20,
      { timeout: 10_000, timeoutMsg: 'viewport never restored after the IME' },
    );

    const geometry = await browser.execute(() => {
      const surface = document.querySelector<HTMLElement>(
        '[data-testid=action-sheet-surface]',
      );
      if (!surface) throw new Error('action sheet surface is missing');
      const box = surface.getBoundingClientRect();
      const viewport = window.visualViewport;
      return {
        top: box.top,
        bottom: box.bottom,
        viewportTop: viewport?.offsetTop ?? 0,
        viewportBottom:
          (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
      };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.viewportTop - 1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportBottom + 1);
    await goBack();
    await expect(sheet).not.toBeDisplayed({ wait: 5_000 });
    await expect(trigger).toBeFocused({ wait: 5_000 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect($('[data-testid="composer-input"]')).toBeDisplayed();
  });

  it('dismisses members before the compact Conversation on hardware Back', async function () {
    onlyOn('android', IME_BACK_ANDROID_ONLY).call(this);
    const { user, pass, roomName } = await seedComposerRoom();
    await login(user, pass);
    await tap('[data-testid="rail-rooms"]');
    const room = $(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect(room).toBeDisplayed({ wait: 30_000 });
    await tap(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect($('[data-testid="composer-input"]')).toBeDisplayed({
      wait: 5_000,
    });
    await expect($('.chat-members')).not.toBeDisplayed();
    const fullViewportHeight = await viewportHeight();

    await tap('[data-testid="room-actions-overflow"]');
    await tap('[data-testid="overflow-toggle-members"]');
    await expect($('.chat-members')).toBeDisplayed({ wait: 5_000 });
    await expect($('[data-testid="member-filter"]')).toBeFocused({
      wait: 5_000,
    });
    await browser.waitUntil(
      async () => (await viewportHeight()) < fullViewportHeight - 100,
      { timeout: 10_000, timeoutMsg: 'viewport never shrank for the IME' },
    );

    // Android consumes Back at the IME before Capacitor can publish a host intent. Once the
    // focused filter's keyboard has gone, the next Back is offered to the Room surface and
    // only the following one to Conversation.
    await goBack();
    await browser.waitUntil(
      async () => (await viewportHeight()) > fullViewportHeight - 20,
      { timeout: 10_000, timeoutMsg: 'viewport never restored after the IME' },
    );
    await expect($('.chat-members')).toBeDisplayed({ wait: 5_000 });

    await goBack();
    await expect($('.chat-members')).not.toBeDisplayed({ wait: 5_000 });
    await expect($('[data-testid="composer-input"]')).toBeDisplayed({
      wait: 5_000,
    });

    await goBack();
    await expect(room).toBeDisplayed({ wait: 5_000 });
    await expect($('[data-testid="composer-input"]')).not.toBeDisplayed({
      wait: 5_000,
    });
  });

  it('moves focus into a routed Settings section on entry and back into Rooms with Back', async () => {
    const user = uniqueId('android-focus');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsFromRooms();
    await waitForPath((path) => path.startsWith('/settings'), '/settings');

    await tap('[data-testid="settings-nav-profile"]');
    await waitForPath(
      (path) => path === '/settings/profile',
      '/settings/profile',
    );
    await expect(
      $('//*[self::h1 or self::h2][normalize-space()="Profile"]'),
    ).toBeFocused({ wait: 10_000 });

    await clickButton('Back');
    await waitForPath((path) => path === '/settings', '/settings');
    await clickButton('Back');
    await waitForRooms();
    await expect($('trn-rooms')).toBeDisplayed({ wait: 20_000 });
    // The phone layout hides the pane holding the shell's <h1>; focus must still
    // land inside Rooms rather than on <body> (#859).
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('trn-rooms')
              ?.contains(document.activeElement) ?? false,
        ),
      { timeout: 20_000, timeoutMsg: 'focus did not enter trn-rooms' },
    );
  });

  it('routes Verify device and returns focus to the Security heading on Close', async () => {
    const user = uniqueId('android-verify');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsFromRooms();
    await tap('[data-testid="settings-nav-security"]');
    await waitForPath(
      (path) => path === '/settings/security',
      '/settings/security',
    );
    await tap('[data-testid="security-verify"]');
    await waitForPath(
      (path) => path === '/encryption/verify',
      '/encryption/verify',
    );
    await expect($('[data-testid="verify-page"]')).toBeDisplayed({
      wait: 20_000,
    });
    await expect(
      $('//*[self::h1 or self::h2][normalize-space()="Verify device"]'),
    ).toBeFocused({ wait: 10_000 });

    await clickButton('Close');
    await waitForPath(
      (path) => path === '/settings/security',
      '/settings/security',
    );
    await expect(
      $('//*[self::h1 or self::h2][normalize-space()="Security"]'),
    ).toBeFocused({ wait: 10_000 });
  });
});
