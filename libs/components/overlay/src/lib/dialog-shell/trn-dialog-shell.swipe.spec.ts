import { ApplicationRef, Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnDialogShellComponent } from './trn-dialog-shell.component';

@Component({
  imports: [TrnDialogShellComponent],
  template: `<trn-dialog-shell title="Swipe me" [closable]="closable()">
    <p>Body</p>
  </trn-dialog-shell>`,
})
class SheetContentComponent {
  readonly closable = input(true);
}

const surface = () =>
  document.querySelector<HTMLElement>('[data-testid=dialog-surface]');
const handle = () =>
  document.querySelector<HTMLElement>('[data-testid=sheet-handle]');
const header = () => document.querySelector<HTMLElement>('header')!;

function pointer(type: string, y: number, t: number, to: EventTarget): void {
  const event = new MouseEvent(type, { clientY: y, bubbles: true });
  Object.defineProperty(event, 'timeStamp', { value: t });
  to.dispatchEvent(event);
}

/** A slow drag of `dy` px on `from`, released over a second. */
function drag(from: Element, dy: number): void {
  pointer('pointerdown', 0, 0, from);
  pointer('pointermove', dy, 1000, document);
  pointer('pointerup', dy, 1000, document);
}

describe('TrnDialogShellComponent swipe to close, on a real dialog', () => {
  let service: TrnDialogService;

  function open(
    options: Parameters<TrnDialogService['open']>[1] = {},
    inputs: Record<string, unknown> = {},
  ) {
    const ref = service.open(SheetContentComponent, {
      placement: 'bottom',
      inputs,
      ...options,
    });
    TestBed.inject(ApplicationRef).tick();
    vi.spyOn(surface()!, 'getBoundingClientRect').mockReturnValue({
      height: 400,
    } as DOMRect);
    return ref;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTrnIcons()] });
    service = TestBed.inject(TrnDialogService);
  });

  afterEach(() => service.closeAll());

  it('closes the dialog on a swipe past the threshold', () => {
    open();

    drag(handle()!, 200);

    expect(service.hasOpen()).toBe(false);
  });

  it('keeps the dialog open and snaps back when its dismissGuard refuses', () => {
    const guard = vi.fn(() => false);
    open({ dismissGuard: guard });

    drag(handle()!, 300);

    expect(guard).toHaveBeenCalledOnce();
    expect(service.hasOpen()).toBe(true);
    expect(surface()!.style.transform).toBe('');
  });

  it('cannot be swiped shut when opened disableClose', () => {
    open({ disableClose: true });

    expect(handle()).toBeNull();
    drag(header(), 300);

    expect(service.hasOpen()).toBe(true);
    expect(surface()!.style.transform).toBe('');
  });

  it('still swipes shut without an X, because it can be dismissed', () => {
    open({}, { closable: false });

    expect(handle()).not.toBeNull();
    drag(handle()!, 300);

    expect(service.hasOpen()).toBe(false);
  });

  it('does not start a drag on the close button, which still clicks', () => {
    open();
    const x = document.querySelector<HTMLElement>(
      '[data-testid=dialog-close]',
    )!;
    const capture = vi.fn();
    header().setPointerCapture = capture;

    pointer('pointerdown', 0, 0, x);
    pointer('pointermove', 300, 1000, document);
    expect(surface()!.style.transform).toBe('');
    pointer('pointerup', 300, 1000, document);
    expect(service.hasOpen()).toBe(true);
    expect(capture).not.toHaveBeenCalled();

    x.click();
    expect(service.hasOpen()).toBe(false);
  });
});
