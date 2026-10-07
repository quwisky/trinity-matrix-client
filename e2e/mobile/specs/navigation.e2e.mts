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
import { pressBack, resetApp, restartApp } from '../support/session.mts';

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

describe('Android navigation', () => {
  beforeEach(resetApp);

  it('@renderer-smoke logs in, opens settings by touch, and handles hardware Back', async () => {
    const user = uniqueId('android-nav');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);
    await openSettingsFromRooms();

    await pressBack();
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

  it('drills into a section and restores its directory link on hardware Back', async () => {
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

    await pressBack();
    await expect(appearance).toBeFocused({ wait: 10_000 });
    await expect($(settingsDialog)).toBeDisplayed();
    expect(await pathname()).not.toMatch(/^\/settings/u);
    const horizontalOverflow = await browser.execute(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    await pressBack();
    await expect($(settingsDialog)).not.toBeDisplayed({ wait: 10_000 });
    await waitForRooms();
    await expect($('trn-rooms')).toBeDisplayed({ wait: 20_000 });
  });

  it('dismisses the native keyboard before opening a bounded sheet and handles hardware Back', async () => {
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
    await pressBack();
    await expect(sheet).not.toBeDisplayed({ wait: 5_000 });
    await expect(trigger).toBeFocused({ wait: 5_000 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect($('[data-testid="composer-input"]')).toBeDisplayed();
  });

  it('dismisses members before the compact Conversation on hardware Back', async () => {
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
    await pressBack();
    await browser.waitUntil(
      async () => (await viewportHeight()) > fullViewportHeight - 20,
      { timeout: 10_000, timeoutMsg: 'viewport never restored after the IME' },
    );
    await expect($('.chat-members')).toBeDisplayed({ wait: 5_000 });

    await pressBack();
    await expect($('.chat-members')).not.toBeDisplayed({ wait: 5_000 });
    await expect($('[data-testid="composer-input"]')).toBeDisplayed({
      wait: 5_000,
    });

    await pressBack();
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
    // The stacked dialog restores focus to the control that opened it.
    await expect($('[data-testid="security-verify"]')).toBeFocused({
      wait: 10_000,
    });
  });
});
