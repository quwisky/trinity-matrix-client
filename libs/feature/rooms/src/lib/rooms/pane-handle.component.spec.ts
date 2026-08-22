import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { PaneHandleComponent } from './pane-handle.component';

/**
 * The handle's contract is small and almost entirely about what it does NOT do.
 *
 * A drag must not write a signal — the timeline beside it is a virtual scroller that
 * re-measures every row on a width change, and doing that per `pointermove` is the
 * measurement storm #179 warns about. So the gesture writes one CSS custom property on the
 * shell and commits exactly once, on release. These tests pin both halves: the property moves
 * during the drag, and `committed` stays silent until the pointer comes up.
 */
@Component({
  imports: [PaneHandleComponent],
  template: `
    <div data-shell-root>
      @if (show()) {
        <trn-pane-handle
          cssVariable="--w"
          label="Room list width"
          [value]="value()"
          [min]="200"
          [max]="560"
          [invert]="invert()"
          (committed)="committed.push($event)"
        />
      }
    </div>
  `,
})
class HostComponent {
  readonly value = signal(352);
  readonly invert = signal(false);
  /** So a test can take the handle away mid-gesture, as closing the slot does. */
  readonly show = signal(true);
  readonly committed: number[] = [];
}

/** jsdom has no pointer capture; the component calls it unconditionally. */
function stubPointerCapture(el: Element): void {
  (el as HTMLElement).setPointerCapture = vi.fn();
  (el as HTMLElement).releasePointerCapture = vi.fn();
}

function pointer(type: string, clientX: number): PointerEvent {
  return new PointerEvent(type, {
    clientX,
    button: 0,
    pointerId: 1,
    bubbles: true,
  });
}

async function build() {
  const { container, fixture } = await render(HostComponent);
  const handle = container.querySelector('trn-pane-handle') as HTMLElement;
  const shell = container.querySelector('[data-shell-root]') as HTMLElement;
  stubPointerCapture(handle);
  return { handle, shell, host: fixture.componentInstance };
}

describe('PaneHandleComponent', () => {
  it('announces itself as a separator with its range', async () => {
    const { handle } = await build();

    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-valuenow')).toBe('352');
    expect(handle.getAttribute('aria-valuemin')).toBe('200');
    expect(handle.getAttribute('aria-valuemax')).toBe('560');
    expect(handle.getAttribute('aria-label')).toBe('Room list width');
    // Focusable, or the keyboard path below is unreachable.
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  it('moves the CSS property during a drag and commits nothing until release', async () => {
    const { handle, shell, host } = await build();

    handle.dispatchEvent(pointer('pointerdown', 100));
    handle.dispatchEvent(pointer('pointermove', 150));

    // The whole point: the layout has moved, and Angular has not been told.
    expect(shell.style.getPropertyValue('--w')).toBe('402px');
    expect(host.committed).toEqual([]);

    handle.dispatchEvent(pointer('pointermove', 180));
    expect(shell.style.getPropertyValue('--w')).toBe('432px');
    expect(host.committed).toEqual([]);

    handle.dispatchEvent(pointer('pointerup', 180));

    // One commit for the whole gesture, and the property left at the width being committed:
    // the host binds this same inline property, so clearing it here would drop the pane to
    // the stylesheet default until Angular rendered the new value.
    expect(host.committed).toEqual([432]);
    expect(shell.style.getPropertyValue('--w')).toBe('432px');
  });

  it('clamps a drag to the bounds rather than following the pointer out of them', async () => {
    const { handle, shell, host } = await build();

    handle.dispatchEvent(pointer('pointerdown', 100));
    handle.dispatchEvent(pointer('pointermove', 5_000));

    expect(shell.style.getPropertyValue('--w')).toBe('560px');

    handle.dispatchEvent(pointer('pointerup', 5_000));
    expect(host.committed).toEqual([560]);
  });

  it('inverts the delta for a pane that grows leftwards', async () => {
    // The right-hand panel widens as the pointer moves LEFT. Without this the panel shrinks
    // when you drag it wider, which is the kind of thing that reads as a broken handle.
    const { handle, shell, host } = await build();
    host.invert.set(true);
    // The input is a binding, so it needs a pass to reach the component.
    TestBed.tick();

    handle.dispatchEvent(pointer('pointerdown', 100));
    handle.dispatchEvent(pointer('pointermove', 60));
    handle.dispatchEvent(pointer('pointerup', 60));

    expect(host.committed).toEqual([392]);
    expect(shell.style.getPropertyValue('--w')).toBe('392px');
  });

  it('resizes from the keyboard, which a pointer drag cannot be emulated with', async () => {
    const { handle, host } = await build();

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    handle.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
      }),
    );
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );

    // Each press commits immediately — there is no gesture to end. Values are computed from
    // the bound width, which the host does not change here, so they are all relative to 352.
    expect(host.committed).toEqual([368, 336, 416, 200, 560]);
  });

  it('ignores a key it does not handle, leaving the pane alone', async () => {
    const { handle, host } = await build();

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    );

    expect(host.committed).toEqual([]);
  });

  it('takes focus on press, so the keyboard can finish what the pointer started', async () => {
    // `preventDefault` on pointerdown — which stops the browser starting a text selection —
    // also suppresses the focus the press would have given. This is the one control whose
    // whole point is that arrows continue the drag.
    const { handle } = await build();

    handle.dispatchEvent(pointer('pointerdown', 100));

    expect(document.activeElement).toBe(handle);
  });

  it('hands the property back when it is destroyed mid-drag', async () => {
    // The right-hand handle lives inside the slot's `@if`, and Escape closes the slot from a
    // document listener — so it can be destroyed with the pointer still down and `pointerup`
    // never delivered. Left behind, the inline override wins over the binding for good.
    const { handle, shell, host } = await build();

    handle.dispatchEvent(pointer('pointerdown', 100));
    handle.dispatchEvent(pointer('pointermove', 150));
    expect(shell.style.getPropertyValue('--w')).toBe('402px');

    host.show.set(false);
    TestBed.tick();

    // Back to the width the binding still holds — not removed, which would fall through to
    // the stylesheet default, and not left at the abandoned drag's value.
    expect(shell.style.getPropertyValue('--w')).toBe('352px');
    // And nothing is committed: the gesture never ended.
    expect(host.committed).toEqual([]);
  });

  it('ignores a non-primary button, so a right-click is not a drag', async () => {
    const { handle, shell, host } = await build();

    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: 100,
        button: 2,
        pointerId: 1,
        bubbles: true,
      }),
    );
    handle.dispatchEvent(pointer('pointermove', 200));

    expect(shell.style.getPropertyValue('--w')).toBe('');
    expect(host.committed).toEqual([]);
  });
});
