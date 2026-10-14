import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { AppLockService } from '@trinity/data-access/app-lock';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { KeyboardShortcutsService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { ShortcutsSectionComponent } from './shortcuts-section.component';

// A settings-scoped keyboard event, dispatched on window (the capture listener).
function pressWindow(init: Partial<KeyboardEvent>): void {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
  });
  for (const [k, v] of Object.entries(init)) {
    Object.defineProperty(event, k, { value: v });
  }
  window.dispatchEvent(event);
}

/** The heading levels in document order, as a section sits under its page's h1. */
function skippedHeadingLevel(root: HTMLElement): string | null {
  let previous = 1;
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const level = Number(heading.tagName.slice(1));
    if (level > previous + 1) {
      return `${heading.tagName} "${heading.textContent?.trim()}" follows h${previous}`;
    }
    previous = level;
  }
  return null;
}

describe('ShortcutsSectionComponent', () => {
  let confirm: Mock;
  let toast: Mock;

  beforeEach(() => {
    confirm = vi.fn(() => of(true));
    toast = vi.fn();
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });
  afterEach(() => {
    // The real (root) service persisted overrides during a test — reset for the next.
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  async function setup(
    locked = signal(false),
    lock: { enabled?: boolean; offered?: boolean; appName?: string } = {},
  ) {
    const rendered = await render(ShortcutsSectionComponent, {
      providers: [
        MockProvider(TrnAlertService, { confirm$: confirm }),
        MockProvider(TrnToastService, { show: toast }),
        MockProvider(AppLockService, {
          locked: locked.asReadonly(),
          enabled: signal(lock.enabled ?? false).asReadonly(),
          offered: signal(lock.offered ?? true).asReadonly(),
          appName: lock.appName ?? 'Trinity',
        }),
      ],
    });
    const svc = rendered.fixture.debugElement.injector.get(
      KeyboardShortcutsService,
    );
    svc.resetAll(); // start from defaults regardless of test order
    rendered.fixture.detectChanges();
    return { ...rendered, svc };
  }

  it('skips no heading level under the page heading', async () => {
    const { container } = await setup();
    expect(container.querySelector('h2')).not.toBeNull();
    expect(skippedHeadingLevel(container)).toBeNull();
  });

  it('lists a row per shortcut with its binding', async () => {
    const { container } = await setup();

    const rows = container.querySelectorAll('[data-testid^="shortcut-"]');
    expect(rows.length).toBeGreaterThan(0);
    const hop = container.querySelector(
      '[data-testid="shortcut-room.hop.back"]',
    );
    expect(hop?.textContent).toContain('Hop to the previous room');
    // Its default binding renders as key-caps (Ctrl/Cmd + ').
    expect(
      hop?.querySelector('[data-testid="shortcut-binding"]')?.textContent,
    ).toContain('Ctrl/Cmd');
  });

  it('rebinds a shortcut by capturing a chord', async () => {
    const { container, fixture, svc } = await setup();

    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-edit-switcher.open"]',
      )!
      .click();
    fixture.detectChanges();
    expect(
      container.querySelector('[data-testid="capture-hint"]'),
    ).toBeTruthy();

    pressWindow({ key: 'p', code: 'KeyP', ctrlKey: true });
    fixture.detectChanges();

    expect(svc.binding('switcher.open')).toEqual({
      accel: true,
      alt: false,
      shift: false,
      key: 'p',
    });
  });

  it('records no chord while App lock is locked', async () => {
    const locked = signal(false);
    const { container, fixture, svc } = await setup(locked);
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-edit-switcher.open"]',
      )!
      .click();
    fixture.detectChanges();

    locked.set(true); // the lock arrives while the row is capturing
    pressWindow({ key: 'p', code: 'KeyP', ctrlKey: true });
    expect(svc.binding('switcher.open')?.key).toBe('k');

    locked.set(false);
    pressWindow({ key: 'p', code: 'KeyP', ctrlKey: true });
    expect(svc.binding('switcher.open')?.key).toBe('p');
  });

  it('rejects a modifier-less chord with a hint', async () => {
    const { container, fixture, svc } = await setup();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-edit-switcher.open"]',
      )!
      .click();
    fixture.detectChanges();

    pressWindow({ key: 'p', code: 'KeyP' }); // no modifier

    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('modifier'),
      expect.anything(),
    );
    // Still the default — nothing was bound.
    expect(svc.binding('switcher.open')?.key).toBe('k');
  });

  it('warns that a browser-reserved chord only works on desktop', async () => {
    const { container, fixture } = await setup();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-edit-room.hop.back"]',
      )!
      .click();
    fixture.detectChanges();

    pressWindow({ key: 't', code: 'KeyT', ctrlKey: true }); // Ctrl+T is reserved

    expect(toast).toHaveBeenCalledWith(expect.stringContaining('desktop app'));
  });

  describe('Lock Trinity', () => {
    const lockRow = (root: HTMLElement) =>
      root.querySelector<HTMLElement>('[data-testid="shortcut-lock.now"]');

    it('lists it under General, unset, with a hint while App lock is off', async () => {
      const { container } = await setup();

      const general = container.querySelector(
        '[data-testid="shortcut-group-general"]',
      );
      expect(general?.textContent?.trim()).toBe('General');
      const row = lockRow(container);
      expect(general?.nextElementSibling?.contains(row)).toBe(true);
      expect(row?.textContent).toContain('Lock Trinity');
      expect(row?.textContent).toContain('Available when App lock is on');
      expect(
        row?.querySelector('[data-testid="shortcut-binding"]')?.textContent,
      ).toContain('Unset');
      expect(row?.querySelector('kbd')).toBeNull();
      // Unassigned is its default, so there is nothing to reset.
      expect(
        container.querySelector('[data-testid="shortcut-reset-lock.now"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="shortcuts-reset-all"]'),
      ).toBeNull();
    });

    it('names the running app and drops the hint while App lock is on', async () => {
      const { container } = await setup(signal(false), {
        enabled: true,
        appName: 'Trinity Next',
      });

      const row = lockRow(container);
      expect(row?.textContent).toContain('Lock Trinity Next');
      expect(row?.textContent).not.toContain('Available when App lock is on');
    });

    it('is not listed where App lock is not offered', async () => {
      const { container } = await setup(signal(false), { offered: false });

      expect(lockRow(container)).toBeNull();
      expect(
        container.querySelector('[data-testid="shortcut-group-general"]'),
      ).toBeNull();
    });

    it('offers no Reset all for an unlisted binding alone', async () => {
      const { container, fixture, svc } = await setup(signal(false), {
        offered: false,
      });
      // Arrived through a config import on a host without App lock.
      svc.setOverrides({
        'lock.now': { accel: true, alt: false, shift: true, key: 'l' },
      });
      fixture.detectChanges();

      expect(
        container.querySelector('[data-testid="shortcuts-reset-all"]'),
      ).toBeNull();
      svc.resetAll();
    });

    it('binds a chord, shows it, and Reset unassigns it again', async () => {
      const { container, fixture, svc } = await setup();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="shortcut-edit-lock.now"]',
        )!
        .click();
      fixture.detectChanges();

      pressWindow({ key: 'l', code: 'KeyL', ctrlKey: true, shiftKey: true });
      fixture.detectChanges();

      expect(svc.binding('lock.now')).toEqual({
        accel: true,
        alt: false,
        shift: true,
        key: 'l',
      });
      expect(lockRow(container)?.querySelectorAll('kbd').length).toBe(3);
      // The capture ended with the bind, so the new chord works at once.
      expect(
        svc.resolve(
          new KeyboardEvent('keydown', {
            key: 'l',
            ctrlKey: true,
            shiftKey: true,
          }),
        ),
      ).toEqual({ id: 'lock.now' });

      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="shortcut-reset-lock.now"]',
        )!
        .click();
      fixture.detectChanges();

      expect(svc.binding('lock.now')).toBeNull();
      expect(
        lockRow(container)?.querySelector('[data-testid="shortcut-binding"]')
          ?.textContent,
      ).toContain('Unset');
    });

    it('names it by the running app when another shortcut takes its chord', async () => {
      const { container, fixture, svc } = await setup(signal(false), {
        enabled: true,
        appName: 'Trinity Next',
      });
      svc.rebind('lock.now', {
        accel: true,
        alt: false,
        shift: true,
        key: 'l',
      });
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="shortcut-edit-room.search"]',
        )!
        .click();
      fixture.detectChanges();

      pressWindow({ key: 'l', code: 'KeyL', ctrlKey: true, shiftKey: true });
      fixture.detectChanges();

      expect(toast).toHaveBeenCalledWith(
        'Removed from “Lock Trinity Next” (now unset).',
      );
      expect(
        lockRow(container)?.querySelector('[data-testid="shortcut-binding"]')
          ?.textContent,
      ).toContain('Unset');
    });
  });

  it('keeps every shortcut quiet while a row captures a chord', async () => {
    const { container, fixture, svc } = await setup();
    svc.rebind('lock.now', {
      accel: true,
      alt: false,
      shift: true,
      key: 'l',
    });
    const lockChord = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      shiftKey: true,
    });
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-edit-room.search"]',
      )!
      .click();
    fixture.detectChanges();

    // The page's handler would lock the app with this chord: while capturing it resolves
    // to nothing, so pressing it rebinds instead.
    expect(svc.resolve(lockChord)).toBeNull();

    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="capture-hint"] + button',
      )!
      .click();
    fixture.detectChanges();
    expect(svc.resolve(lockChord)).toEqual({ id: 'lock.now' });
  });

  it('stops capturing on Escape', async () => {
    const { container, fixture, svc } = await setup();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-edit-room.search"]',
      )!
      .click();
    fixture.detectChanges();
    const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true });
    expect(svc.resolve(ctrlK)).toBeNull();

    pressWindow({ key: 'Escape', code: 'Escape' });
    fixture.detectChanges();

    expect(container.querySelector('[data-testid="capture-hint"]')).toBeNull();
    expect(svc.resolve(ctrlK)).toEqual({ id: 'switcher.open' });
  });

  it('stops capturing when the section closes mid-capture', async () => {
    const { container, fixture, svc } = await setup();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-edit-room.search"]',
      )!
      .click();
    fixture.detectChanges();

    fixture.destroy();

    const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true });
    expect(svc.resolve(ctrlK)).toEqual({ id: 'switcher.open' });
  });

  it('resets one shortcut and, after confirm, all of them', async () => {
    const { container, fixture, svc } = await setup();
    svc.rebind('switcher.open', {
      accel: true,
      alt: false,
      shift: false,
      key: 'p',
    });
    svc.rebind('room.hop.back', {
      accel: false,
      alt: true,
      shift: false,
      key: 'j',
    });
    fixture.detectChanges();

    // Per-row reset restores just that one.
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="shortcut-reset-switcher.open"]',
      )!
      .click();
    expect(svc.binding('switcher.open')?.key).toBe('k');
    expect(svc.binding('room.hop.back')?.key).toBe('j'); // still custom

    // Reset all, behind the confirm.
    fixture.detectChanges();
    await container
      .querySelector<HTMLButtonElement>('[data-testid="shortcuts-reset-all"]')!
      .click();
    await Promise.resolve();
    expect(confirm).toHaveBeenCalled();
    expect(svc.binding('room.hop.back')?.key).toBe("'");
  });
});
