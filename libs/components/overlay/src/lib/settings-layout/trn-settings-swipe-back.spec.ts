import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnSettingsSwipeBack } from './trn-settings-swipe-back';

@Component({
  imports: [TrnSettingsSwipeBack],
  template: `
    <div
      data-testid="host"
      [trnSettingsSwipeBack]="enabled()"
      [trnSettingsSwipeBackPage]="page"
      [trnSettingsSwipeBackUnder]="under"
      (swiped)="swiped = swiped + 1"
    >
      <nav #under></nav>
      <section #page data-testid="page">
        <p data-testid="text">Text</p>
        <input data-testid="field" />
        <div role="slider" data-testid="slider"></div>
        <div data-testid="scroller"><span data-testid="chip">Chip</span></div>
      </section>
    </div>
  `,
})
class SwipeHostComponent {
  readonly enabled = signal(true);
  swiped = 0;
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
      value:
        type === 'touchend' || type === 'touchcancel'
          ? []
          : [{ clientX: x, clientY: y }],
    },
    timeStamp: { value: timeStamp },
  });
  target.dispatchEvent(event);
  return event;
}

describe('TrnSettingsSwipeBack', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    // jsdom has no Web Animations: settle at once.
    HTMLElement.prototype.animate = vi.fn(
      () =>
        ({
          finished: Promise.resolve(),
          cancel: vi.fn(),
        }) as unknown as Animation,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setup() {
    const view = await render(SwipeHostComponent);
    const host = view.getByTestId('host');
    // A 300px wide layout at the left of the screen.
    for (const element of [host, view.getByTestId('page')]) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: 300,
      } as DOMRect);
    }
    return { view, host, component: view.fixture.componentInstance };
  }

  /** A slow drag of (dx, dy) from (x, 100); reports whether the first move was claimed. */
  function drag(
    from: Element,
    x: number,
    dx: number,
    dy: number,
    end = 'touchend',
  ): boolean {
    touch('touchstart', x, 100, 0, from);
    const moved = touch('touchmove', x + dx, 100 + dy, 1000, from);
    touch(end, x + dx, 100 + dy, 1000, from);
    return moved.defaultPrevented;
  }

  it('follows a sideways drag from the leading edge and commits past the threshold', async () => {
    const { view, host, component } = await setup();
    const page = view.getByTestId('page');
    touch('touchstart', 8, 100, 0, view.getByTestId('text'));
    const moved = touch('touchmove', 98, 104, 500, view.getByTestId('text'));
    expect(moved.defaultPrevented).toBe(true);
    expect(host.hasAttribute('data-pane-swipe')).toBe(true);
    expect(page.style.transform).toBe('translateX(90px)');

    touch('touchmove', 208, 104, 1000, view.getByTestId('text'));
    touch('touchend', 208, 104, 1000, view.getByTestId('text'));
    await Promise.resolve();
    await Promise.resolve();
    expect(component.swiped).toBe(1);
  });

  it('springs back short of the threshold, and on touchcancel', async () => {
    const { view, host, component } = await setup();
    expect(drag(view.getByTestId('text'), 8, 60, 0)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.swiped).toBe(0);
    expect(host.hasAttribute('data-pane-swipe')).toBe(false);
    expect(view.getByTestId('page').style.transform).toBe('');

    expect(drag(view.getByTestId('text'), 8, 250, 0, 'touchcancel')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.swiped).toBe(0);
  });

  it('leaves a downward drag to the sheet, and a start away from the edge alone', async () => {
    const { view, host } = await setup();
    expect(drag(view.getByTestId('text'), 8, 20, 30)).toBe(false);
    expect(drag(view.getByTestId('text'), 60, 200, 0)).toBe(false);
    expect(drag(view.getByTestId('text'), 8, -40, 0)).toBe(false);
    expect(host.hasAttribute('data-pane-swipe')).toBe(false);
  });

  it('leaves text fields, sliders and horizontal scrollers their own drag', async () => {
    const { view } = await setup();
    expect(drag(view.getByTestId('field'), 8, 200, 0)).toBe(false);
    expect(drag(view.getByTestId('slider'), 8, 200, 0)).toBe(false);

    const scroller = view.getByTestId('scroller');
    scroller.style.overflowX = 'auto';
    Object.defineProperty(scroller, 'scrollWidth', { value: 600 });
    Object.defineProperty(scroller, 'clientWidth', { value: 300 });
    expect(drag(view.getByTestId('chip'), 8, 200, 0)).toBe(false);
  });

  it('leaves a text selection alone', async () => {
    const { view } = await setup();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
    } as Selection);
    expect(drag(view.getByTestId('text'), 8, 200, 0)).toBe(false);
  });

  it('does nothing while turned off', async () => {
    const { view, component } = await setup();
    component.enabled.set(false);
    view.fixture.detectChanges();
    expect(drag(view.getByTestId('text'), 8, 200, 0)).toBe(false);
  });
});
