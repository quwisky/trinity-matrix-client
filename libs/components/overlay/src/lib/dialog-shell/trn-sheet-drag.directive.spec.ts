import { Component, input } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
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
    expect(sheet.style.transition).toBe('transform 200ms ease-out');
  });

  it('dismisses only the dragged sheet of a stack', async () => {
    for (const key of Object.keys(spies)) delete spies[key];
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
});
