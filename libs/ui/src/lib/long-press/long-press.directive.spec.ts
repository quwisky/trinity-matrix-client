import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { LongPressDirective } from './long-press.directive';

@Component({
  imports: [LongPressDirective],
  template: `
    <button
      type="button"
      trnLongPress
      [longPressDelay]="delay"
      (longPress)="pressed.set(pressed() + 1)"
      (click)="clicked.set(clicked() + 1)"
    >
      hold me
    </button>
  `,
})
class HostComponent {
  readonly delay = 500;
  readonly pressed = signal(0);
  readonly clicked = signal(0);
}

/**
 * jsdom has no `PointerEvent` constructor, so build a `MouseEvent` and define the
 * pointer fields the directive reads. `pointerType` is the load-bearing one: the
 * gesture is touch/pen only.
 */
function pointerEvent(
  type: string,
  init: { pointerType?: string; clientX?: number; clientY?: number } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(event, 'pointerType', {
    value: init.pointerType ?? 'touch',
  });
  return event;
}

describe('LongPressDirective', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const { fixture, container } = await render(HostComponent);
    const button = container.querySelector('button')!;
    return { host: fixture.componentInstance, button };
  }

  it('fires once the press is held for the delay', async () => {
    const { host, button } = await setup();

    button.dispatchEvent(pointerEvent('pointerdown'));
    expect(host.pressed()).toBe(0); // not yet — it must be *held*
    vi.advanceTimersByTime(500);

    expect(host.pressed()).toBe(1);
  });

  it('swallows the click the browser synthesises after it fires', async () => {
    // Otherwise a long press on a reaction pill would open the dialog AND toggle
    // the reaction — the tap action the gesture is meant to sit beside.
    const { host, button } = await setup();

    button.dispatchEvent(pointerEvent('pointerdown'));
    vi.advanceTimersByTime(500);
    button.dispatchEvent(pointerEvent('pointerup'));
    button.click();

    expect(host.pressed()).toBe(1);
    expect(host.clicked()).toBe(0);
    // Only the click that belongs to the gesture is swallowed; the next tap works.
    button.click();
    expect(host.clicked()).toBe(1);
  });

  it('ignores mouse presses, however long they are held', async () => {
    const { host, button } = await setup();

    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(5_000);
    button.click();

    expect(host.pressed()).toBe(0);
    expect(host.clicked()).toBe(1); // a slow click is still just a click
  });

  it('abandons the press when the pointer lifts early or drifts away', async () => {
    const { host, button } = await setup();

    button.dispatchEvent(pointerEvent('pointerdown'));
    vi.advanceTimersByTime(200);
    button.dispatchEvent(pointerEvent('pointerup'));
    vi.advanceTimersByTime(500);
    expect(host.pressed()).toBe(0);

    // A press that slides away is a scroll, not a long press.
    button.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 0, clientY: 0 }),
    );
    button.dispatchEvent(
      pointerEvent('pointermove', { clientX: 0, clientY: 40 }),
    );
    vi.advanceTimersByTime(500);
    expect(host.pressed()).toBe(0);
  });
});
