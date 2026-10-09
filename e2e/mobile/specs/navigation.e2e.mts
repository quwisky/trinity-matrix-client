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
import {
  goBack,
  resetApp,
  restartApp,
  historyGestures,
  recordHistoryGestures,
} from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

/** iOS has no system Back for an open panel: MainViewController turns the edge swipe off. */
const PANEL_BACK_ANDROID_ONLY =
  'iOS has no system Back for an open sheet or panel; MainViewController disables the edge swipe while Angular holds one';
const IME_BACK_ANDROID_ONLY =
  'Android consumes Back at the IME before the app; iOS has no system Back for an open panel';

const backToSections =
  '[data-testid="settings-detail"] .settings-layout__topbar button[aria-label="Back to sections"]';
const closeSettings = '[data-testid="close-settings"]';

/**
 * Take one step back in the Settings dialog. Android takes the system Back; iOS has no
 * system Back while a dialog is open (MainViewController disables the edge swipe), so a
 * user taps the dialog's own `control` instead.
 */
async function backFromSettings(control: string): Promise<void> {
  if (browser.isIOS) await tap(control);
  else await goBack();
}

const viewportHeight = (): Promise<number> =>
  browser.execute(() => window.visualViewport?.height ?? window.innerHeight);

const pathname = async (): Promise<string> =>
  new URL(await browser.getUrl()).pathname;

const settingsDialog = '[role="dialog"][aria-label="Settings"]';

async function openSettingsFromRooms(): Promise<void> {
  await waitForRooms();
  const routeBefore = await pathname();
  await tap('[data-testid="open-settings"]');
  // On a phone Settings is a bottom-sheet dialog over Rooms, not a route.
  await expect($(settingsDialog)).toBeDisplayed({ wait: 20_000 });
  await expect($('//h2[normalize-space()="Settings"]')).toBeDisplayed();
  await expect($('[data-testid="close-settings"]')).toBeDisplayed();
  await expect($('nav[aria-label="Settings sections"]')).toBeDisplayed();
  expect(await pathname()).toBe(routeBefore);
  expect(await pathname()).not.toMatch(/^\/settings/u);
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

    await backFromSettings(closeSettings);
    await expect($(settingsDialog)).not.toBeDisplayed({ wait: 10_000 });
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
    await expect(
      $('[data-testid="settings-detail"] .settings-layout__topbar h1'),
    ).toBeFocused({ wait: 10_000 });
    await expect(
      $(
        '[data-testid="settings-detail"] .settings-layout__topbar button[aria-label="Back to sections"]',
      ),
    ).toBeDisplayed();
    expect(await pathname()).not.toMatch(/^\/settings/u);

    await backFromSettings(backToSections);
    await expect(appearance).toBeFocused({ wait: 10_000 });
    await expect($(settingsDialog)).toBeDisplayed();
    expect(await pathname()).not.toMatch(/^\/settings/u);
    const horizontalOverflow = await browser.execute(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    await backFromSettings(closeSettings);
    await expect($(settingsDialog)).not.toBeDisplayed({ wait: 10_000 });
    await waitForRooms();
    await expect($('trn-rooms')).toBeDisplayed({ wait: 20_000 });
  });

  it('turns the iOS history swipe on for a routed Settings page, whose Back is history', async function () {
    onlyOn(
      'ios',
      "WebKit's edge swipe; Android's system Back on routed pages is covered above",
    ).call(this);
    const user = uniqueId('ios-swipe');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await waitForRooms();
    const { search } = new URL(await browser.getUrl());
    await recordHistoryGestures();

    // A phone opens Settings as a sheet; a direct link still renders the routed page.
    // Push it as one in-app history entry, the way the router would follow such a link.
    await browser.execute((path: string) => {
      history.pushState(null, '', path);
      dispatchEvent(new PopStateEvent('popstate', { state: null }));
    }, `/settings/appearance${search}`);
    await browser.waitUntil(
      async () => (await pathname()) === '/settings/appearance',
      { timeout: 20_000, timeoutMsg: 'routed Settings never opened' },
    );
    await expect($('trn-settings')).toBeDisplayed({ wait: 20_000 });
    await browser.waitUntil(
      async () => (await historyGestures()).at(-1) === true,
      {
        timeout: 10_000,
        timeoutMsg: 'routed Settings never turned the history swipe on',
      },
    );

    // The swipe itself is WebKit's: a synthesized edge pan fires it only intermittently on
    // the Simulator, so the spec takes the same history step it would.
    await browser.execute(() => history.back());
    await browser.waitUntil(async () => (await pathname()) === '/rooms', {
      timeout: 20_000,
      timeoutMsg: 'history Back never left routed Settings',
    });
    await waitForRooms();
  });

  it('turns the iOS history swipe on over a room opened from the list, and pops it on Back', async function () {
    onlyOn(
      'ios',
      "WebKit's edge swipe; Android's system Back over a room is covered below",
    ).call(this);
    const { user, pass, roomName } = await seedComposerRoom();
    await login(user, pass);
    await tap('[data-testid="rail-rooms"]');
    const room = $(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect(room).toBeDisplayed({ wait: 30_000 });
    await recordHistoryGestures();

    await tap(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect($('[data-testid="composer-input"]')).toBeDisplayed({
      wait: 20_000,
    });
    // The room sits on the list as one history entry, so the swipe stays on (#1113).
    await browser.waitUntil(
      async () => (await historyGestures()).at(-1) === true,
      {
        timeout: 10_000,
        timeoutMsg:
          'a room opened from the list never turned the history swipe on',
      },
    );
    const entries = await browser.execute(() => history.length);

    await tap('[data-testid="back-to-rooms"]');
    await expect(room).toBeDisplayed({ wait: 20_000 });
    // The in-app Back popped the room's entry; it did not push a list on top of it.
    expect(await browser.execute(() => history.length)).toBe(entries);
  });

  it('steps System status back to its sections, then closes it, on hardware Back', async function () {
    onlyOn('android', PANEL_BACK_ANDROID_ONLY).call(this);
    const { user, pass, roomName } = await seedComposerRoom();
    await login(user, pass);
    await tap('[data-testid="rail-rooms"]');
    const room = $(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect(room).toBeDisplayed({ wait: 30_000 });
    await room.click();
    await expect($('[data-testid="composer-input"]')).toBeDisplayed({
      wait: 20_000,
    });

    await tap('[data-testid="room-actions-overflow"]');
    await tap('[data-testid="overflow-open-system-status"]');
    const status = $('[role="dialog"][aria-label="System status"]');
    await expect(status).toBeDisplayed({ wait: 10_000 });
    await expect($('[data-testid="sheet-handle"]')).toBeDisplayed();
    const sections = $('nav[aria-label="System status sections"]');
    await expect(sections).not.toBeDisplayed();

    await goBack();
    await expect(sections).toBeDisplayed({ wait: 5_000 });
    await expect(status).toBeDisplayed();
    await goBack();
    await expect(status).not.toBeDisplayed({ wait: 10_000 });
    await expect($('[data-testid="composer-input"]')).toBeDisplayed();
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

  it('moves focus into a Settings sheet section on entry and back into Rooms with Back', async () => {
    const user = uniqueId('android-focus');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsFromRooms();

    await tap('[data-testid="settings-nav-profile"]');
    await expect(
      $('//*[self::h1 or self::h2][normalize-space()="Profile"]'),
    ).toBeFocused({ wait: 10_000 });

    await clickButton('Back to sections');
    await expect($('[data-testid="settings-nav-profile"]')).toBeFocused({
      wait: 10_000,
    });
    await clickButton('Close settings');
    await expect($(settingsDialog)).not.toBeDisplayed({ wait: 10_000 });
    await waitForRooms();
    await expect($('trn-rooms')).toBeDisplayed({ wait: 20_000 });
    // The phone layout hides the pane holding the shell's <h1>; focus must still
    // land inside Rooms rather than on <body> (#859).
    try {
      await browser.waitUntil(
        () =>
          browser.execute(
            () =>
              document
                .querySelector('trn-rooms')
                ?.contains(document.activeElement) ?? false,
          ),
        { timeout: 20_000 },
      );
    } catch (error) {
      // Say where focus was, so a recurrence shows whether the handoff ran at all.
      const state = await browser.execute(() => {
        const rooms = document.querySelector('trn-rooms');
        const active = document.activeElement;
        return {
          path: location.pathname + location.search,
          active: active
            ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}`
            : null,
          roomsTabindex: rooms?.getAttribute('tabindex') ?? null,
          hasFocus: document.hasFocus(),
        };
      });
      throw new Error(
        `focus did not enter trn-rooms: ${JSON.stringify(state)}`,
        { cause: error },
      );
    }
  });

  it('stacks Verify device over the Settings sheet and returns focus to its opener on Close', async () => {
    const user = uniqueId('android-verify');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsFromRooms();
    await tap('[data-testid="settings-nav-security"]');
    await expect(
      $('//*[self::h1 or self::h2][normalize-space()="Security"]'),
    ).toBeDisplayed({ wait: 20_000 });
    await tap('[data-testid="security-verify"]');
    const verify = $(
      '//*[@role="dialog"][.//h2[normalize-space()="Verify device"]]',
    );
    await expect(verify).toBeDisplayed({ wait: 20_000 });
    // A dialog over the Settings sheet, not a route.
    await expect($(settingsDialog)).toExist();
    expect(await pathname()).not.toMatch(/^\/(settings|encryption)/u);

    await clickButton('Close');
    await expect(verify).not.toBeDisplayed({ wait: 10_000 });
    await expect($(settingsDialog)).toBeDisplayed();
    // The stacked dialog restores focus to the control that opened it, also on iOS,
    // where the tap never focused it (#1109).
    await expect($('[data-testid="security-verify"]')).toBeFocused({
      wait: 10_000,
    });
  });
});
