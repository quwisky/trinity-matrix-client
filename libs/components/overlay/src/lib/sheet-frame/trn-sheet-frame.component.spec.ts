import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnSheetFrameComponent } from './trn-sheet-frame.component';
import { SHEET_LARGE_HEIGHT } from './sheet-detent';

@Component({
  imports: [TrnSheetFrameComponent],
  template: `<trn-sheet-frame testId="probe-sheet">
    <p trnSheetFrameHeader data-testid="probe-head">Head</p>
    <p data-testid="probe-body">Body</p>
  </trn-sheet-frame>`,
})
class FramedComponent {}

const surface = () =>
  document.querySelector<HTMLElement>('[data-testid=probe-sheet]')!;
const handle = () =>
  document.querySelector<HTMLElement>('[data-testid=sheet-handle]');

function pointer(type: string, y: number, t: number, to: EventTarget): void {
  const event = new MouseEvent(type, { clientY: y, bubbles: true });
  Object.defineProperty(event, 'timeStamp', { value: t });
  to.dispatchEvent(event);
}

/** A slow drag of `dy` px started on `from`, released after a second. */
function drag(from: Element, dy: number): void {
  pointer('pointerdown', 0, 0, from);
  pointer('pointermove', dy, 1000, document);
  pointer('pointerup', dy, 1000, document);
}

describe('TrnSheetFrameComponent', () => {
  let dialogs: TrnDialogService;

  function open(options: Parameters<TrnDialogService['open']>[1] = {}) {
    const ref = dialogs.open(FramedComponent, {
      placement: 'bottom',
      ...options,
    });
    TestBed.inject(ApplicationRef).tick();
    vi.spyOn(surface(), 'getBoundingClientRect').mockReturnValue({
      height: 400,
    } as DOMRect);
    return ref;
  }

  beforeEach(() => (dialogs = TestBed.inject(TrnDialogService)));
  afterEach(() => {
    dialogs.closeAll();
    vi.restoreAllMocks();
  });

  it('is the sheet surface, with its entrance, handle and projected header', () => {
    open();

    expect(surface().getAttribute('data-trn-layout')).toBe('sheet');
    expect(surface().classList).toContain('trn-overlay-enter-sheet');
    expect(handle()?.getAttribute('aria-hidden')).toBe('true');
    expect(handle()?.parentElement).toBe(
      document.querySelector('[data-testid=probe-head]')?.parentElement,
    );
  });

  it('closes through its dialog on a swipe down the handle', () => {
    const closed = vi.fn();
    open().closed.subscribe(closed);

    drag(handle()!, 200);

    expect(closed).toHaveBeenCalledOnce();
  });

  it('also follows a swipe that starts on the projected header', () => {
    const closed = vi.fn();
    open().closed.subscribe(closed);

    drag(document.querySelector('[data-testid=probe-head]')!, 200);

    expect(closed).toHaveBeenCalledOnce();
  });

  it('ignores a swipe that starts in the body', () => {
    const closed = vi.fn();
    open().closed.subscribe(closed);

    drag(document.querySelector('[data-testid=probe-body]')!, 200);

    expect(closed).not.toHaveBeenCalled();
  });

  it('snaps back and stays open when the dismissGuard refuses', () => {
    const guard = vi.fn(() => false);
    open({ dismissGuard: guard });

    drag(handle()!, 200);

    expect(guard).toHaveBeenCalledOnce();
    expect(dialogs.hasOpen()).toBe(true);
    expect(surface().style.transform).toBe('');
  });

  it('has no handle and does not move under a drag when opened disableClose', () => {
    open({ disableClose: true });
    const head = document.querySelector<HTMLElement>(
      '[data-testid=probe-head]',
    )!;

    pointer('pointerdown', 0, 0, head);
    pointer('pointermove', 200, 500, document);

    expect(handle()).toBeNull();
    expect(surface().style.transform).toBe('');
    expect(head.parentElement?.style.touchAction).toBe('');
    pointer('pointerup', 200, 1000, document);
    expect(dialogs.hasOpen()).toBe(true);
  });

  it('rests a phone sheet opened with detents at half height', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      open({ detents: ['medium', 'large'] });

      expect(surface().getAttribute('data-sheet-detent')).toBe('medium');
      expect(surface().style.getPropertyValue('--trn-sheet-height')).toBe(
        'auto',
      );
      expect(surface().classList).toContain('h-[var(--trn-sheet-height)]');
      expect(surface().classList).toContain(
        'max-h-[var(--trn-sheet-max-height)]',
      );
      expect(surface().style.getPropertyValue('--trn-sheet-max-height')).toBe(
        `min(50svh, ${SHEET_LARGE_HEIGHT})`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('makes the handle a button that expands and collapses the sheet', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      open({ detents: ['medium', 'large'] });
      const toggle = () =>
        document.querySelector<HTMLButtonElement>('[data-trn-sheet-toggle]')!;

      expect(toggle().tagName).toBe('BUTTON');
      expect(toggle().getAttribute('aria-label')).toBe('Sheet height');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(toggle().contains(handle())).toBe(true);

      toggle().click();
      TestBed.inject(ApplicationRef).tick();
      expect(surface().getAttribute('data-sheet-detent')).toBe('large');
      expect(toggle().getAttribute('aria-label')).toBe('Sheet height');
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      await new Promise((resolve) => setTimeout(resolve));

      toggle().click();
      TestBed.inject(ApplicationRef).tick();
      expect(surface().getAttribute('data-sheet-detent')).toBe('medium');
      expect(toggle().getAttribute('aria-label')).toBe('Sheet height');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps focus in the dialog when a resize to wide removes a focused handle button', () => {
    let change: ((e: { matches: boolean }) => void) | undefined;
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (_: string, fn: typeof change) => (change = fn),
      removeEventListener: () => undefined,
    }));
    try {
      open({ detents: ['medium', 'large'] });
      document.querySelector<HTMLElement>('[data-trn-sheet-toggle]')!.focus();

      change?.({ matches: false });
      TestBed.inject(ApplicationRef).tick();

      expect(document.querySelector('[data-trn-sheet-toggle]')).toBeNull();
      expect(document.activeElement?.getAttribute('role')).toBe('dialog');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the plain handle on a sheet that cannot change height', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      open();
      expect(document.querySelector('[data-trn-sheet-toggle]')).toBeNull();
      expect(handle()?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a sheet without detents content-sized', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      open();

      expect(surface().hasAttribute('data-sheet-detent')).toBe(false);
      expect(surface().classList).not.toContain('h-[var(--trn-sheet-height)]');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
