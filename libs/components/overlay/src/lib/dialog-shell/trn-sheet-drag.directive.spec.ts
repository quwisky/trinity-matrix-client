import { Component, DestroyRef, input } from '@angular/core';
import { render } from '@trinity/testing';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import {
  SHEET_DETENT_HEIGHT,
  SHEET_LARGE_HEIGHT,
  type TrnSheetDetent,
} from '../sheet-frame/sheet-detent';
import {
  TRN_SHEET_DISMISS,
  TrnSheetDrag,
  TrnSheetDragHandle,
} from './trn-sheet-drag.directive';

const dismiss = vi.fn<() => boolean>();

@Component({
  imports: [TrnSheetDrag, TrnSheetDragHandle],
  providers: [{ provide: TRN_SHEET_DISMISS, useFactory: () => dismiss }],
  template: `
    <div trnSheetDrag data-testid="sheet">
      <div trnSheetDragHandle data-testid="handle"></div>
      <p data-testid="body">Body</p>
    </div>
  `,
})
class SheetHostComponent {}

const spies: Record<string, ReturnType<typeof vi.fn<() => boolean>>> = {};
function dismissSpyFor(): () => boolean {
  const spy = vi.fn<() => boolean>(() => true);
  spies[`s${Object.keys(spies).length}`] = spy;
  return spy;
}

@Component({
  selector: 'trn-test-sheet',
  imports: [TrnSheetDrag, TrnSheetDragHandle],
  providers: [
    { provide: TRN_SHEET_DISMISS, useFactory: () => dismissSpyFor() },
  ],
  template: `
    <div trnSheetDrag [attr.data-testid]="'sheet-' + name()">
      <div trnSheetDragHandle [attr.data-testid]="'handle-' + name()"></div>
    </div>
  `,
})
class NamedSheetComponent {
  readonly name = input.required<string>();
}

@Component({
  imports: [NamedSheetComponent],
  template: `<trn-test-sheet name="a" /><trn-test-sheet name="b" />`,
})
class StackedHostComponent {}

function pointer(
  type: string,
  clientY: number,
  timeStamp: number,
  target: EventTarget = document,
): void {
  const event = new MouseEvent(type, { clientY, bubbles: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  target.dispatchEvent(event);
}

function touch(
  type: string,
  x: number,
  y: number,
  timeStamp: number,
  target: Element,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: {
      value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
    },
    timeStamp: { value: timeStamp },
  });
  target.dispatchEvent(event);
  return event;
}

/** A slow touch drag of (dx, dy) on `from`; reports whether the first move was claimed. */
function pull(from: Element, dx: number, dy: number): boolean {
  touch('touchstart', 100, 100, 0, from);
  const moved = touch('touchmove', 100 + dx, 100 + dy, 1000, from);
  touch('touchend', 100 + dx, 100 + dy, 1000, from);
  return moved.defaultPrevented;
}

async function setup(): Promise<{ sheet: HTMLElement; handle: HTMLElement }> {
  dismiss.mockReset().mockReturnValue(true);
  await render(SheetHostComponent);
  const sheet = document.querySelector<HTMLElement>('[data-testid=sheet]')!;
  vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue({
    height: 400,
  } as DOMRect);
  return {
    sheet,
    handle: document.querySelector<HTMLElement>('[data-testid=handle]')!,
  };
}

describe('TrnSheetDrag', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dismisses past 25% of the sheet height', async () => {
    const { handle } = await setup();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 260, 1000);
    pointer('pointerup', 260, 1000);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('snaps back when a slow drag stays under the threshold', async () => {
    const { sheet, handle } = await setup();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 140, 1000);
    pointer('pointerup', 140, 1000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('dismisses on a fling above 0.5 px/ms', async () => {
    const { handle } = await setup();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 140, 50);
    pointer('pointerup', 140, 50);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('ignores a short flick even when it is fast', async () => {
    const { handle } = await setup();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 112, 20);
    pointer('pointerup', 112, 20);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('stops the drag area from selecting text while enabled', async () => {
    const { handle } = await setup();
    expect(handle.style.userSelect).toBe('none');
  });

  it('snaps back when the dismissal is refused', async () => {
    const { sheet, handle } = await setup();
    dismiss.mockReturnValue(false);
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 300, 1000);
    pointer('pointerup', 300, 1000);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(sheet.style.transform).toBe('');
  });

  it('snaps back on pointercancel even past the threshold', async () => {
    const { sheet, handle } = await setup();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 300, 1000);
    pointer('pointercancel', 300, 1000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('ignores a drag that starts in the body', async () => {
    await setup();
    const body = document.querySelector<HTMLElement>('[data-testid=body]')!;
    pointer('pointerdown', 100, 0, body);
    pointer('pointermove', 340, 10);
    pointer('pointerup', 340, 10);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('follows the pointer without a transition, then eases on release', async () => {
    const { sheet, handle } = await setup();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 130, 1000);
    expect(sheet.style.transform).toBe('translateY(30px)');
    expect(sheet.style.transition).toContain('none');
    pointer('pointerup', 130, 1000);
    expect(sheet.style.transition).toBe(
      'transform var(--trinity-duration-base) ease-out',
    );
  });

  it("dismisses through the dragged sheet's own dismiss function", async () => {
    for (const key of Object.keys(spies)) delete spies[key]; // each host gets a fresh spy
    await render(StackedHostComponent);
    const top = document.querySelector<HTMLElement>('[data-testid=handle-b]')!;
    vi.spyOn(
      document.querySelector<HTMLElement>('[data-testid=sheet-b]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ height: 400 } as DOMRect);
    pointer('pointerdown', 100, 0, top);
    pointer('pointermove', 300, 1000);
    pointer('pointerup', 300, 1000);
    expect(spies['s0']).not.toHaveBeenCalled();
    expect(spies['s1']).toHaveBeenCalledOnce();
  });

  it('leaves no document listeners behind after ten drags', async () => {
    const { handle } = await setup();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    for (let i = 0; i < 10; i++) {
      pointer('pointerdown', 100, 0, handle);
      pointer('pointermove', 110, 1000);
      pointer('pointerup', 110, 1000);
    }
    const added = add.mock.calls.filter(([t]) => t.startsWith('pointer'));
    const removed = remove.mock.calls.filter(([t]) => t.startsWith('pointer'));
    expect(added).toHaveLength(30);
    expect(removed).toHaveLength(30);
    for (const [type, fn] of added) {
      expect(removed.some(([t, f]) => t === type && f === fn)).toBe(true);
    }
  });

  it('removes a drag in flight when destroyed', async () => {
    dismiss.mockReset();
    const { fixture } = await render(SheetHostComponent);
    const handle = document.querySelector<HTMLElement>('[data-testid=handle]')!;
    const remove = vi.spyOn(document, 'removeEventListener');
    pointer('pointerdown', 100, 0, handle);
    fixture.destroy();
    expect(
      remove.mock.calls.filter(([t]) => t.startsWith('pointer')),
    ).toHaveLength(3);
  });

  it.each([
    ['24% of the height', false, 96, 1000],
    ['26% of the height', true, 104, 1000],
    ['just under 0.5 px/ms', false, 40, 82],
    ['just over 0.5 px/ms', true, 40, 78],
  ])('%s (dismissed: %s)', async (_label, expected, dy, ms) => {
    const { handle } = await setup();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 100 + dy, ms);
    pointer('pointerup', 100 + dy, ms);
    expect(dismiss.mock.calls.length > 0).toBe(expected);
  });

  it('drops the first drag listeners when a second drag starts before it ends', async () => {
    const { handle } = await setup();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const pointerCalls = (spy: typeof add) =>
      spy.mock.calls.filter(([t]) => t.startsWith('pointer')).length;

    pointer('pointerdown', 100, 0, handle);
    pointer('pointerdown', 100, 5, handle);
    expect(pointerCalls(add)).toBe(6);
    expect(pointerCalls(remove)).toBe(3);

    pointer('pointerup', 110, 1000);
    expect(pointerCalls(remove)).toBe(6);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it.each(['pointerup', 'pointercancel'])(
    'captures the pointer on the handle and releases it on %s',
    async (ending) => {
      const { handle } = await setup();
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();

      pointer('pointerdown', 100, 0, handle);
      expect(handle.setPointerCapture).toHaveBeenCalledOnce();
      expect(handle.releasePointerCapture).not.toHaveBeenCalled();
      pointer(ending, 110, 1000);
      expect(handle.releasePointerCapture).toHaveBeenCalledOnce();
    },
  );

  it('registers one destroy hook per instance, however many drags run', async () => {
    const { fixture } = await render(SheetHostComponent);
    const sheetEl = document.querySelector<HTMLElement>('[data-testid=sheet]')!;
    const destroyRef = fixture.debugElement
      .query((d) => d.nativeElement === sheetEl)
      .injector.get(DestroyRef);
    const onDestroy = vi.spyOn(Object.getPrototypeOf(destroyRef), 'onDestroy');
    const handle = document.querySelector<HTMLElement>('[data-testid=handle]')!;

    for (let i = 0; i < 5; i++) {
      pointer('pointerdown', 100, 0, handle);
      pointer('pointerup', 110, 1000);
    }

    expect(onDestroy).not.toHaveBeenCalled();
  });

  it('removes no listeners on destroy after the drags have completed', async () => {
    dismiss.mockReset();
    const { fixture } = await render(SheetHostComponent);
    const handle = document.querySelector<HTMLElement>('[data-testid=handle]')!;
    pointer('pointerdown', 100, 0, handle);
    pointer('pointerup', 110, 1000);
    const remove = vi.spyOn(document, 'removeEventListener');

    fixture.destroy();

    expect(
      remove.mock.calls.filter(([t]) => t.startsWith('pointer')),
    ).toHaveLength(0);
  });
});

describe('TrnSheetDrag content drag', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dismisses on a downward pull of content at its top', async () => {
    const { sheet } = await setup();
    const body = document.querySelector('[data-testid=body]')!;
    expect(pull(body, 0, 200)).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(sheet.style.transform).not.toBe('translateY(0px)');
  });

  it('springs back from a short pull', async () => {
    const { sheet } = await setup();
    const body = document.querySelector('[data-testid=body]')!;
    expect(pull(body, 0, 40)).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('leaves an upward or sideways move to native scrolling', async () => {
    await setup();
    const body = document.querySelector('[data-testid=body]')!;
    expect(pull(body, 0, -200)).toBe(false);
    expect(pull(body, 200, 20)).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('leaves content scrolled down to scroll', async () => {
    await setup();
    const body = document.querySelector<HTMLElement>('[data-testid=body]')!;
    body.scrollTop = 30;
    expect(pull(body, 0, 200)).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('leaves a scroller that is still coasting alone', async () => {
    await setup();
    const body = document.querySelector('[data-testid=body]')!;
    body.dispatchEvent(new Event('scroll'));
    expect(pull(body, 0, 200)).toBe(false);
  });

  it('leaves sliders, inputs and opted-out regions their gesture', async () => {
    const { sheet } = await setup();
    for (const html of [
      '<input type="range">',
      '<textarea></textarea>',
      '<div data-trn-sheet-no-drag><i></i></div>',
    ]) {
      sheet.insertAdjacentHTML('beforeend', html);
      const inner = sheet.lastElementChild!;
      expect(pull(inner.firstElementChild ?? inner, 0, 200)).toBe(false);
    }
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('leaves a sheet that scrolls on its own surface to scroll when scrolled down', async () => {
    const { sheet } = await setup();
    const body = document.querySelector('[data-testid=body]')!;
    sheet.scrollTop = 30;
    expect(pull(body, 0, 200)).toBe(false);
    sheet.scrollTop = 0;
    expect(pull(body, 0, 200)).toBe(true);
  });

  it('leaves a nested scroller scrolled down to scroll', async () => {
    const { sheet } = await setup();
    sheet.insertAdjacentHTML('beforeend', '<div><div><b></b></div></div>');
    const outer = sheet.lastElementChild as HTMLElement;
    const leaf = outer.querySelector('b')!;
    outer.scrollTop = 20;
    expect(pull(leaf, 0, 200)).toBe(false);
    outer.scrollTop = 0;
    expect(pull(leaf, 0, 200)).toBe(true);
  });

  it('leaves a horizontal scroller its gesture', async () => {
    const { sheet } = await setup();
    sheet.insertAdjacentHTML('beforeend', '<div><b></b></div>');
    const strip = sheet.lastElementChild as HTMLElement;
    Object.defineProperty(strip, 'scrollWidth', { value: 500 });
    Object.defineProperty(strip, 'clientWidth', { value: 100 });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el === strip
        ? ({ overflowX: 'auto', touchAction: 'auto' } as CSSStyleDeclaration)
        : real(el),
    );
    expect(pull(strip.firstElementChild!, 0, 200)).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('honours touch-action: none and pan-x, but not pan-x pan-y', async () => {
    const { sheet } = await setup();
    sheet.insertAdjacentHTML('beforeend', '<div><b></b></div>');
    const region = sheet.lastElementChild as HTMLElement;
    let touchAction = 'none';
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el === region ? ({ touchAction } as CSSStyleDeclaration) : real(el),
    );
    const leaf = region.firstElementChild!;
    expect(pull(leaf, 0, 200)).toBe(false);
    touchAction = 'pan-x';
    expect(pull(leaf, 0, 200)).toBe(false);
    touchAction = 'pan-x pan-y';
    expect(pull(leaf, 0, 200)).toBe(true);
  });

  it('leaves a text selection alone but ignores a missing selection', async () => {
    await setup();
    const body = document.querySelector('[data-testid=body]')!;
    vi.spyOn(window, 'getSelection').mockReturnValue(null);
    expect(pull(body, 0, 200)).toBe(true);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
    } as Selection);
    expect(pull(body, 0, 200)).toBe(false);
  });

  it('stays open when the dismissal is refused', async () => {
    const { sheet } = await setup();
    dismiss.mockReturnValue(false);
    pull(document.querySelector('[data-testid=body]')!, 0, 200);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(sheet.style.transform).toBe('');
  });
});

let openedDetents: readonly TrnSheetDetent[] = ['medium', 'large'];
let openedAt: TrnSheetDetent | undefined;

@Component({
  imports: [TrnSheetDrag, TrnSheetDragHandle],
  providers: [
    { provide: TRN_SHEET_DISMISS, useFactory: () => dismiss },
    {
      provide: TrnDialogRef,
      useFactory: () =>
        new TrnDialogRef(
          { closed: new Subject(), close: () => undefined },
          'sheet',
          'title',
          null,
          { detents: openedDetents, initialDetent: openedAt },
        ),
    },
  ],
  template: `
    <div trnSheetDrag data-testid="sheet" role="dialog" tabindex="-1">
      <div trnSheetDragHandle data-testid="handle">
        <button
          type="button"
          data-trn-sheet-toggle
          data-testid="toggle"
        ></button>
      </div>
      <ul data-testid="list">
        <li data-testid="row">Row</li>
      </ul>
      <input data-testid="field" />
    </div>
  `,
})
class DetentSheetHostComponent {}

/** An 844px phone with a 59px top inset: half height 422px, full height 785px. */
const PHONE = { medium: 422, large: 785 };

describe('TrnSheetDrag detents', () => {
  afterEach(() => {
    openedDetents = ['medium', 'large'];
    openedAt = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Lays the sheet out as a browser would: inline px, a detent height, or the resting one,
   * with `content` px of content under the sheet's current cap.
   */
  async function setupDetents(
    phone: boolean | (() => unknown) = true,
    content = 2000,
  ) {
    let observed: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observed = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal(
      'matchMedia',
      typeof phone === 'function' ? phone : () => ({ matches: phone }),
    );
    vi.stubGlobal('innerHeight', 844);
    dismiss.mockReset().mockReturnValue(true);
    const view = await render(DetentSheetHostComponent);
    const sheet = document.querySelector<HTMLElement>('[data-testid=sheet]')!;
    const cap = () =>
      sheet.style.getPropertyValue('--trn-sheet-max-height') ===
      SHEET_LARGE_HEIGHT
        ? PHONE.large
        : PHONE.medium;
    const heightOf = (css: string): number =>
      css.endsWith('px')
        ? parseFloat(css)
        : css === SHEET_DETENT_HEIGHT.large
          ? PHONE.large
          : css === SHEET_DETENT_HEIGHT.medium
            ? PHONE.medium
            : css === 'auto'
              ? Math.min(content, cap())
              : heightOf(
                  sheet.style.getPropertyValue('--trn-sheet-height') || 'auto',
                );
    const rect = vi
      .spyOn(sheet, 'getBoundingClientRect')
      .mockImplementation(
        () => ({ height: heightOf(sheet.style.height) }) as DOMRect,
      );
    const drag = view.fixture.debugElement
      .query((el) => el.nativeElement === sheet)
      .injector.get(TrnSheetDrag);
    const handle = document.querySelector<HTMLElement>('[data-testid=handle]')!;
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el === sheet
        ? ({
            maxHeight: `${cap()}px`,
            transitionDuration: '0s',
            touchAction: 'auto',
            overflowX: 'visible',
          } as CSSStyleDeclaration)
        : real(el),
    );
    /** The browser reports the sheet's resting size, as it does once it is laid out. */
    const resized = () => {
      observed?.();
      view.fixture.detectChanges();
    };
    resized();
    const by = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
    const setContent = (px: number) => (content = px);
    return { view, sheet, drag, handle, rect, resized, by, setContent };
  }

  /** Lets a snap's timer hand the height back to the bindings. */
  const settled = () => new Promise((resolve) => setTimeout(resolve));

  it('starts at medium and marks the sheet', async () => {
    const { sheet, drag } = await setupDetents();
    expect(drag.detent()).toBe('medium');
    expect(sheet.getAttribute('data-sheet-detent')).toBe('medium');
    expect(sheet.style.getPropertyValue('--trn-sheet-height')).toBe('auto');
    expect(sheet.style.getPropertyValue('--trn-sheet-max-height')).toBe(
      `min(50svh, ${SHEET_LARGE_HEIGHT})`,
    );
    expect(sheet.getBoundingClientRect().height).toBe(PHONE.medium);
  });

  it('drops the detent and its full-height cap at md and wider', async () => {
    const { sheet, drag } = await setupDetents(false);
    expect(drag.detent()).toBeNull();
    expect(sheet.hasAttribute('data-sheet-detent')).toBe(false);
    expect(sheet.style.getPropertyValue('--trn-sheet-max-height')).toBe('');
  });

  it('snaps to large past the measured midpoint on a notched phone', async () => {
    const { view, sheet, drag, handle } = await setupDetents();
    pointer('pointerdown', 500, 0, handle);
    pointer('pointermove', 300, 1000);
    expect(sheet.style.height).toBe('622px');
    expect(sheet.style.transform).toBe('');
    pointer('pointerup', 300, 1000);
    view.fixture.detectChanges();
    expect(drag.detent()).toBe('large');
    expect(sheet.getAttribute('data-sheet-detent')).toBe('large');
    expect(sheet.style.height).toBe('785px');
    expect(dismiss).not.toHaveBeenCalled();
    await settled();
    expect(sheet.style.height).toBe('');
    expect(sheet.style.getPropertyValue('--trn-sheet-height')).toBe(
      SHEET_LARGE_HEIGHT,
    );
  });

  it('starts a re-grab mid-settle from where the sheet is', async () => {
    const { drag, handle, rect } = await setupDetents();
    drag.setDetent('large');
    rect.mockReturnValueOnce({ height: 600 } as DOMRect);
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 250, 1000);
    pointer('pointerup', 250, 1000);
    expect(drag.detent()).toBe('medium');
  });

  it('slides below medium and springs back to it when the close is refused', async () => {
    const { sheet, drag, handle } = await setupDetents();
    dismiss.mockReturnValue(false);
    drag.setDetent('large');
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 300, 1000);
    expect(sheet.style.transform).toBe('');
    pointer('pointermove', 700, 1000);
    expect(sheet.style.height).toBe('422px');
    expect(sheet.style.transform).toBe('translateY(237px)');
    pointer('pointerup', 700, 5000);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(drag.detent()).toBe('medium');
    expect(sheet.style.transform).toBe('');
  });

  it('dismisses on a drag down from medium', async () => {
    const { handle } = await setupDetents();
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 300, 1000);
    pointer('pointerup', 300, 1000);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('clears the snap transition once it ends', async () => {
    const { sheet, handle } = await setupDetents();
    pointer('pointerdown', 500, 0, handle);
    pointer('pointerup', 300, 1000);
    expect(sheet.style.transition).toContain('height');
    await new Promise((resolve) => setTimeout(resolve));
    expect(sheet.style.transition).toBe('');
  });

  it('clears the full-height cap after a resize to wide', async () => {
    let change: ((e: { matches: boolean }) => void) | undefined;
    const { view, sheet, drag } = await setupDetents(() => ({
      matches: true,
      addEventListener: (_: string, fn: typeof change) => (change = fn),
      removeEventListener: () => undefined,
    }));
    change?.({ matches: false });
    view.fixture.detectChanges();
    expect(drag.detent()).toBeNull();
    expect(sheet.hasAttribute('data-sheet-detent')).toBe(false);
    expect(sheet.style.getPropertyValue('--trn-sheet-height')).toBe('');
    expect(sheet.style.getPropertyValue('--trn-sheet-max-height')).toBe('');
  });

  it('ignores a detent it was not opened with', async () => {
    openedDetents = ['medium'];
    const { sheet, drag } = await setupDetents();
    drag.setDetent('large');
    expect(drag.detent()).toBe('medium');
    expect(sheet.style.getPropertyValue('--trn-sheet-height')).toBe('auto');
  });

  it('shows content shorter than medium at its own height, with no large', async () => {
    const { sheet, drag, handle } = await setupDetents(true, 200);
    expect(sheet.getBoundingClientRect().height).toBe(200);
    expect(drag.toggleable()).toBeNull();

    pointer('pointerdown', 500, 0, handle);
    pointer('pointermove', 100, 1000);
    pointer('pointerup', 100, 1000);
    expect(drag.detent()).toBe('medium');
    drag.setDetent('large');
    expect(drag.detent()).toBe('medium');
    await settled();
    expect(sheet.getBoundingClientRect().height).toBe(200);
  });

  it('opens a short sheet asked for at large at its own height instead', async () => {
    openedAt = 'large';
    const { sheet, drag } = await setupDetents(true, 200);
    expect(drag.detent()).toBe('medium');
    expect(drag.toggleable()).toBeNull();
    expect(sheet.style.height).toBe('');
    expect(sheet.getBoundingClientRect().height).toBe(200);
  });

  it('opens a long sheet asked for at large at full height', async () => {
    openedAt = 'large';
    const { drag } = await setupDetents();
    expect(drag.detent()).toBe('large');
    expect(drag.toggleable()).toBe('collapse');
  });

  it('moves focus to the dialog when content shrinks under a focused handle button', async () => {
    const { sheet, drag, by, resized, setContent } = await setupDetents();
    by('toggle').focus();
    setContent(200);
    resized();
    expect(drag.toggleable()).toBeNull();
    expect(document.activeElement).toBe(sheet);
  });

  it('springs to large when expanded from code, as the keyboard does', async () => {
    const { sheet, drag } = await setupDetents();
    drag.expand();
    expect(drag.detent()).toBe('large');
    expect(sheet.style.transition).toContain('height');
    expect(sheet.style.height).toBe(`${PHONE.large}px`);
    drag.expand();
    expect(drag.detent()).toBe('large');
  });

  it('expands on an upward content drag at medium, before the list scrolls', async () => {
    const { drag, by } = await setupDetents();
    expect(pull(by('row'), 0, -300)).toBe(true);
    expect(drag.detent()).toBe('large');
    expect(by('list').scrollTop).toBe(0);
  });

  it('leaves an upward content drag at large to the list', async () => {
    const { drag, by } = await setupDetents();
    drag.setDetent('large');
    expect(pull(by('row'), 0, -300)).toBe(false);
    expect(drag.detent()).toBe('large');
  });

  it('collapses on a downward content drag at large with the list at its top', async () => {
    const { drag, by } = await setupDetents();
    drag.setDetent('large');
    expect(pull(by('row'), 0, 250)).toBe(true);
    expect(drag.detent()).toBe('medium');
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('changes no detent on a mostly horizontal content drag', async () => {
    const { drag, by } = await setupDetents();
    expect(pull(by('row'), -250, -200)).toBe(false);
    expect(pull(by('row'), 250, 200)).toBe(false);
    expect(drag.detent()).toBe('medium');
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('springs back to medium when a drag down from medium is refused', async () => {
    const { sheet, drag, handle } = await setupDetents();
    dismiss.mockReturnValue(false);
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 400, 1000);
    expect(sheet.style.transform).toBe('translateY(300px)');
    pointer('pointerup', 400, 1000);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(drag.detent()).toBe('medium');
    expect(sheet.style.transform).toBe('');
    expect(sheet.style.height).toBe('422px');
  });

  it('drops a drag in flight and its inline geometry on a resize to wide', async () => {
    let change: ((e: { matches: boolean }) => void) | undefined;
    const { view, sheet, handle } = await setupDetents(() => ({
      matches: true,
      addEventListener: (_: string, fn: typeof change) => (change = fn),
      removeEventListener: () => undefined,
    }));
    pointer('pointerdown', 100, 0, handle);
    pointer('pointermove', 400, 1000);
    expect(sheet.style.transform).not.toBe('');
    change?.({ matches: false });
    view.fixture.detectChanges();
    expect(sheet.hasAttribute('data-sheet-detent')).toBe(false);
    expect(sheet.style.transform).toBe('');
    expect(sheet.style.height).toBe('');
    pointer('pointerup', 400, 1000);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('toggles from the handle button, but not on the click that ends a drag', async () => {
    const { drag, by } = await setupDetents();
    expect(drag.toggleable()).toBe('expand');
    drag.toggle();
    expect(drag.detent()).toBe('large');
    expect(drag.toggleable()).toBe('collapse');

    pointer('pointerdown', 100, 0, by('toggle'));
    pointer('pointermove', 130, 1000);
    pointer('pointerup', 130, 1000);
    drag.toggle();
    expect(drag.detent()).toBe('large');
    await settled();
    drag.toggle();
    expect(drag.detent()).toBe('medium');
  });
});

describe('TrnSheetDrag without detents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('has a null detent, even on a phone', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const view = await render(SheetHostComponent);
    const sheet = document.querySelector<HTMLElement>('[data-testid=sheet]')!;
    const drag = view.fixture.debugElement
      .query((el) => el.nativeElement === sheet)
      .injector.get(TrnSheetDrag);
    expect(drag.detent()).toBeNull();
    expect(sheet.hasAttribute('data-sheet-detent')).toBe(false);
    expect(sheet.style.getPropertyValue('--trn-sheet-height')).toBe('');
  });
});
