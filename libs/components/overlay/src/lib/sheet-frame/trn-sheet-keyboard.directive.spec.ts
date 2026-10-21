import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnSheetFrameComponent } from './trn-sheet-frame.component';

@Component({
  imports: [TrnSheetFrameComponent],
  template: `<trn-sheet-frame testId="probe-sheet">
    <input data-testid="probe-search" aria-label="Search" />
    <button type="button" data-testid="probe-button">Pick</button>
  </trn-sheet-frame>`,
})
class SearchSheetComponent {}

/** A stand-in for `window.visualViewport`: an event target with the geometry we set. */
class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  scale = 1;
  resize(height: number, offsetTop = this.offsetTop): void {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event('resize'));
  }
  scroll(): void {
    this.dispatchEvent(new Event('scroll'));
  }
}

/** A stand-in for Chromium's `navigator.virtualKeyboard`. */
class FakeVirtualKeyboard extends EventTarget {
  boundingRect = { height: 0 };
  show(height: number): void {
    this.boundingRect = { height };
    this.dispatchEvent(new Event('geometrychange'));
  }
}

const surface = () =>
  document.querySelector<HTMLElement>('[data-testid=probe-sheet]')!;
const search = () =>
  document.querySelector<HTMLInputElement>('[data-testid=probe-search]')!;

describe('TrnSheetKeyboardAvoidance (on every sheet frame)', () => {
  let viewport: FakeVisualViewport;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let dialogs: TrnDialogService;
  const tick = () => TestBed.inject(ApplicationRef).tick();

  beforeEach(() => {
    viewport = new FakeVisualViewport();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    dialogs = TestBed.inject(TrnDialogService);
  });
  afterEach(() => {
    dialogs.closeAll();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'visualViewport');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    Reflect.deleteProperty(navigator, 'virtualKeyboard');
  });

  /** Open the probe sheet, optionally focus its search, then let a render pass run. */
  async function openSheet(focusSearch = true): Promise<void> {
    dialogs.open(SearchSheetComponent, {
      placement: 'bottom',
      autoFocus: false,
    });
    tick();
    if (focusSearch) {
      search().focus();
    }
    tick();
    await Promise.resolve();
  }

  async function settle(): Promise<void> {
    tick();
    await Promise.resolve();
    tick();
  }

  it('leaves the sheet where it is while no keyboard is open', () => {
    dialogs.open(SearchSheetComponent, { placement: 'bottom' });
    tick();

    expect(surface().style.maxHeight).toBe('');
    expect(surface().style.translate).toBe('');
  });

  it('lifts the sheet above the keyboard, fits it to the visible area and keeps the focused field in view', async () => {
    dialogs.open(SearchSheetComponent, { placement: 'bottom' });
    tick();
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid=probe-search]',
    )!;
    search.focus();

    viewport.resize(510); // a 334px keyboard over a 844px layout viewport
    tick();
    await Promise.resolve();
    tick();

    expect(surface().style.translate).toBe('0 -334px');
    expect(surface().style.maxHeight).toContain('510px');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(search);

    viewport.resize(844); // the keyboard closes
    tick();

    expect(surface().style.translate).toBe('');
    expect(surface().style.maxHeight).toBe('');
  });

  it('leaves the keyboard to the overlay layer when the iOS shell publishes its inset', async () => {
    document.documentElement.style.setProperty(
      '--trinity-keyboard-inset',
      '334px',
    );
    try {
      await openSheet();

      viewport.resize(510);
      await settle();

      expect(surface().style.translate).toBe('');
      expect(surface().style.maxHeight).toBe('');
    } finally {
      document.documentElement.style.removeProperty('--trinity-keyboard-inset');
    }
  });

  it('ignores a pinch zoom, which shrinks the visual viewport without a keyboard', () => {
    dialogs.open(SearchSheetComponent, { placement: 'bottom' });
    tick();

    viewport.scale = 2;
    viewport.resize(422);
    tick();

    expect(surface().style.translate).toBe('');
  });

  it('treats a small gap as browser chrome, not a keyboard', async () => {
    // iOS Safari's collapsing toolbar and rubber-band scrolling open gaps of tens of px.
    await openSheet();

    viewport.resize(804);
    await settle();

    expect(surface().style.translate).toBe('');
    expect(surface().style.maxHeight).toBe('');
  });

  it('does not lift for a large gap while nothing editable in the sheet has focus', async () => {
    await openSheet(false);
    document
      .querySelector<HTMLButtonElement>('[data-testid=probe-button]')!
      .focus();

    viewport.resize(510);
    await settle();

    expect(surface().style.translate).toBe('');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('measures the covered height below an iOS visual viewport that has scrolled down', async () => {
    await openSheet();

    // iOS pans the visual viewport up to the caret: 400px visible starting 100px down
    // leaves 844 - 500 = 344px covered.
    viewport.resize(400, 100);
    await settle();

    expect(surface().style.translate).toBe('0 -344px');
    expect(surface().style.maxHeight).toContain('400px');
  });

  it('follows the VirtualKeyboard API where Chromium reports it', async () => {
    const keyboard = new FakeVirtualKeyboard();
    Object.defineProperty(navigator, 'virtualKeyboard', {
      configurable: true,
      value: keyboard,
    });
    await openSheet();

    keyboard.show(300); // overlays content: the visual viewport does not shrink
    await settle();

    expect(surface().style.translate).toBe('0 -300px');
  });

  it('scrolls the focused field into view once per keyboard change, not on every viewport scroll', async () => {
    await openSheet();

    viewport.resize(510);
    await settle();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Scrolling inside the sheet moves the visual viewport; it must not snap the body back.
    viewport.scroll();
    viewport.resize(510);
    await settle();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    viewport.resize(480); // a taller keyboard (a suggestion bar) is a change
    await settle();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
