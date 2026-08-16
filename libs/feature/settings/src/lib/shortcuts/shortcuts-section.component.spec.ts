import { render } from '@trinity/testing';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { KeyboardShortcutsService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
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

describe('ShortcutsSectionComponent', () => {
  let confirm: Mock;
  let toast: Mock;

  beforeEach(() => {
    confirm = vi.fn().mockResolvedValue(true);
    toast = vi.fn();
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });
  afterEach(() => {
    // The real (root) service persisted overrides during a test — reset for the next.
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  async function setup() {
    const rendered = await render(ShortcutsSectionComponent, {
      providers: [
        MockProvider(TrnAlertService, { confirm }),
        MockProvider(TrnToastService, { show: toast }),
      ],
    });
    const svc = rendered.fixture.debugElement.injector.get(
      KeyboardShortcutsService,
    );
    svc.resetAll(); // start from defaults regardless of test order
    rendered.fixture.detectChanges();
    return { ...rendered, svc };
  }

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
