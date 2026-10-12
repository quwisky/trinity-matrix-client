import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnSheetFrameComponent } from './trn-sheet-frame.component';

@Component({
  imports: [TrnSheetFrameComponent],
  template: `<trn-sheet-frame testId="probe-sheet">
    <input data-testid="probe-search" aria-label="Search" />
  </trn-sheet-frame>`,
})
class SearchSheetComponent {}

/** A stand-in for `window.visualViewport`: an event target with the geometry we set. */
class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  scale = 1;
  resize(height: number): void {
    this.height = height;
    this.dispatchEvent(new Event('resize'));
  }
}

const surface = () =>
  document.querySelector<HTMLElement>('[data-testid=probe-sheet]')!;

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
  });

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

  it('ignores a pinch zoom, which shrinks the visual viewport without a keyboard', () => {
    dialogs.open(SearchSheetComponent, { placement: 'bottom' });
    tick();

    viewport.scale = 2;
    viewport.resize(422);
    tick();

    expect(surface().style.translate).toBe('');
  });
});
