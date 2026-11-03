import { Component, DestroyRef, input } from '@angular/core';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
