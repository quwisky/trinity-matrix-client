import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnSheetFrameComponent } from './trn-sheet-frame.component';

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
});
