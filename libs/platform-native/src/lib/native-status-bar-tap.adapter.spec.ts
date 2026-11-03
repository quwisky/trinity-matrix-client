import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeStatusBarTapAdapter } from './native-status-bar-tap.adapter';

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: vi.fn(() => 'ios') },
}));

const platform = vi.mocked(Capacitor.getPlatform);
const tap = () => window.dispatchEvent(new Event('statusTap'));

function pane(testId: string, overflowY: string, scrollable = true) {
  const el = document.createElement('div');
  el.dataset['testid'] = testId;
  el.style.overflowY = overflowY;
  Object.defineProperty(el, 'scrollHeight', { value: scrollable ? 900 : 100 });
  Object.defineProperty(el, 'clientHeight', { value: 100 });
  el.scrollTo = vi.fn() as never;
  document.body.append(el);
  return el;
}

describe('NativeStatusBarTapAdapter', () => {
  let under: Element | null;

  beforeEach(() => {
    platform.mockReturnValue('ios');
    window.matchMedia = vi.fn(() => ({ matches: false }) as never);
    under = null;
    document.elementFromPoint = vi.fn(() => under);
  });
  afterEach(() => document.body.replaceChildren());

  it('scrolls the scrollable pane under the screen centre to its top', () => {
    const scroller = pane('list', 'auto');
    const row = document.createElement('p');
    scroller.append(row);
    under = row;
    const run = TestBed.inject(NativeStatusBarTapAdapter).run().subscribe();

    tap();

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'smooth',
    });
    run.unsubscribe();
  });

  it('skips an inner pane that cannot scroll and finds the one that can', () => {
    const outer = pane('outer', 'scroll');
    const inner = pane('inner', 'auto', false);
    outer.append(inner);
    under = inner;
    const run = TestBed.inject(NativeStatusBarTapAdapter).run().subscribe();

    tap();

    expect(inner.scrollTo).not.toHaveBeenCalled();
    expect(outer.scrollTo).toHaveBeenCalledOnce();
    run.unsubscribe();
  });

  it('jumps instead of gliding when the user asks for reduced motion', () => {
    const scroller = pane('list', 'auto');
    under = scroller;
    window.matchMedia = vi.fn(
      (query: string) => ({ matches: query.includes('reduce') }) as never,
    );
    const run = TestBed.inject(NativeStatusBarTapAdapter).run().subscribe();

    tap();

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'auto',
    });
    run.unsubscribe();
  });

  it('does nothing when nothing under the centre scrolls', () => {
    under = pane('fixed', 'hidden');
    const run = TestBed.inject(NativeStatusBarTapAdapter).run().subscribe();

    expect(() => tap()).not.toThrow();
    expect((under as HTMLElement).scrollTo).not.toHaveBeenCalled();
    run.unsubscribe();
  });

  it('probes the centre of the topmost open sheet, not the screen centre', () => {
    const container = document.createElement('div');
    container.className = 'cdk-overlay-container';
    const below = document.createElement('div');
    below.setAttribute('role', 'dialog');
    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    // A half-height sheet: its top edge is the screen centre.
    sheet.getBoundingClientRect = () =>
      ({ left: 0, top: 422, width: 390, height: 422 }) as DOMRect;
    container.append(below, sheet);
    document.body.append(container);
    const scroller = pane('sheet-list', 'auto');
    sheet.append(scroller);
    document.elementFromPoint = vi.fn((x: number, y: number) =>
      x === 195 && y === 633 ? scroller : null,
    );
    const run = TestBed.inject(NativeStatusBarTapAdapter).run().subscribe();

    tap();

    expect(scroller.scrollTo).toHaveBeenCalledOnce();
    run.unsubscribe();
  });

  it('ignores the event off iOS, and after unsubscribing', () => {
    const scroller = pane('list', 'auto');
    under = scroller;
    platform.mockReturnValue('web');
    TestBed.inject(NativeStatusBarTapAdapter).run().subscribe();
    tap();
    platform.mockReturnValue('ios');
    const run = TestBed.inject(NativeStatusBarTapAdapter).run().subscribe();
    run.unsubscribe();
    tap();

    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});
