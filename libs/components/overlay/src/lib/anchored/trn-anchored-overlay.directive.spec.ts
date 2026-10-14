import { Component, OnDestroy, inject, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnAnchoredOverlayDirective } from './trn-anchored-overlay.directive';

/**
 * What a unit test can reach here is the CONTRACT, not the geometry.
 *
 * jsdom does no layout, so where the layer lands is a browser's answer and belongs to a
 * story or an e2e. What is pinned here is everything else: that the content leaves the
 * host's DOM for the overlay container at all — the thing every consumer's own spec will
 * have to account for — that it goes away again, that an outside press writes the host's
 * signal back rather than leaving it lying, and that a destroyed host takes its layer with it.
 */
@Component({
  imports: [TrnAnchoredOverlayDirective],
  template: `
    @if (mounted()) {
      <div #anchor data-t="anchor">field</div>
      <ng-template
        [trnAnchoredOverlay]="anchor"
        [(open)]="open"
        [side]="side()"
        [align]="'end'"
        [matchAnchorWidth]="matchWidth()"
        [closeOnOutsidePress]="closeOnOutside()"
      >
        <div data-t="layer">picker</div>
      </ng-template>
    }
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly side = signal<'top' | 'bottom'>('top');
  readonly matchWidth = signal(false);
  readonly closeOnOutside = signal(true);
  readonly mounted = signal(true);
}

/** The layer, wherever CDK put it — deliberately not scoped to the fixture. */
const layer = () => document.querySelector('[data-t="layer"]');

/** How many overlay panes CDK is holding open, content or not. */
const panes = () => document.querySelectorAll('.cdk-overlay-pane').length;

/** The pane element itself, which is what carries the size CDK was given. */
const pane = () =>
  document.querySelector<HTMLElement>('.cdk-overlay-pane') ?? undefined;

/**
 * jsdom implements no `ResizeObserver`, so the directive's guard would skip the whole path.
 * Stubbed and fired by hand — what is being pinned is the DECISION to re-measure, not the
 * browser's ability to notice.
 */
let resizeCallbacks: (() => void)[] = [];
const fireResize = () => resizeCallbacks.forEach((cb) => cb());

/**
 * A whole press, both halves.
 *
 * CDK records the target on `pointerdown` and decides on the following `click`, so a test
 * that dispatches only the first half asserts nothing — the outside-press path never runs.
 */
function press(target: EventTarget): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function build() {
  const { container, fixture } = await render(HostComponent);
  TestBed.tick();
  return { container, host: fixture.componentInstance };
}

describe('TrnAnchoredOverlayDirective', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly cb: () => void) {
          resizeCallbacks.push(this.cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document
      .querySelectorAll('.cdk-overlay-container')
      .forEach((node) => node.remove());
  });

  it('renders nothing until it is opened', async () => {
    await build();

    expect(layer()).toBeNull();
  });

  it('renders the layer OUTSIDE the host, which is the whole point', async () => {
    // The reason to move a floating layer here at all: inside the host it is clipped by
    // whatever `overflow: hidden` ancestor happens to exist. Consumers' specs have to switch
    // from `fixture.nativeElement.querySelector` to `document.querySelector` because of this
    // line, so it is worth stating rather than assuming.
    const { container, host } = await build();
    host.open.set(true);
    TestBed.tick();

    expect(layer()).not.toBeNull();
    expect(container.querySelector('[data-t="layer"]')).toBeNull();
    expect(layer()?.closest('.cdk-overlay-container')).not.toBeNull();
  });

  it('takes the layer away again when it closes', async () => {
    const { host } = await build();
    host.open.set(true);
    TestBed.tick();
    expect(layer()).not.toBeNull();

    host.open.set(false);
    TestBed.tick();

    expect(layer()).toBeNull();
  });

  it('writes the host signal back when a press lands outside', async () => {
    // Closing the layer without telling the host would leave the host rendering an open
    // state for something that is gone — and the next `open.set(true)` would be a no-op,
    // because the signal never went false.
    const { host } = await build();
    host.open.set(true);
    TestBed.tick();

    press(document.body);
    TestBed.tick();

    expect(host.open()).toBe(false);
    expect(layer()).toBeNull();
  });

  it('stays open on an outside press when the host says its openness is derived', async () => {
    // For a layer whose `open` is a `computed` — the composer's suggestion menus are open
    // exactly when the query has matches — there is no flag for a write-back to land in.
    // Closing itself would hide the menu while the host still answered Enter for it.
    const { host } = await build();
    host.closeOnOutside.set(false);
    host.open.set(true);
    TestBed.tick();

    press(document.body);
    TestBed.tick();

    expect(host.open()).toBe(true);
    expect(layer()).not.toBeNull();
  });

  it('leaves a press on the ANCHOR alone, so a trigger can toggle', async () => {
    // The anchor is where a trigger for this layer lives. Treating a press there as "outside"
    // races the trigger's own click handler: one wins, and the layer either reopens at once or
    // ends up gone while the button still reports `aria-expanded="true"`.
    const { container, host } = await build();
    host.open.set(true);
    TestBed.tick();

    press(container.querySelector('[data-t="anchor"]')!);
    TestBed.tick();

    expect(host.open()).toBe(true);
    expect(layer()).not.toBeNull();
  });

  it('leaves a press INSIDE the layer alone', async () => {
    // A picker is made of things to click; closing on the first of them would make it
    // unusable.
    const { host } = await build();
    host.open.set(true);
    TestBed.tick();

    press(layer()!);
    TestBed.tick();

    expect(host.open()).toBe(true);
    expect(layer()).not.toBeNull();
  });

  it('moves the open layer rather than replacing it when only geometry changes', async () => {
    // Re-creating destroys the view inside: an emoji picker would lose the text typed into
    // its search field and the focus that was in it. Only `open` and `anchor` may re-create.
    const { host } = await build();
    host.open.set(true);
    TestBed.tick();
    const before = layer();

    host.side.set('bottom');
    TestBed.tick();

    expect(layer()).toBe(before); // the same element, moved — not a new one
  });

  it('follows the anchor when the anchor changes shape', async () => {
    // CDK recomputes a connected position on scroll and on nothing else, and reads `width`
    // once — so an anchor that grows in place takes the layer with it in neither respect.
    // Absolute positioning, which this replaces, tracked both for free. The composer's
    // textarea auto-grows as you type, which is exactly this case.
    const { container, host } = await build();
    host.matchWidth.set(true);
    const anchor = container.querySelector('[data-t="anchor"]') as HTMLElement;
    anchor.getBoundingClientRect = () => ({ width: 500 }) as DOMRect;
    host.open.set(true);
    TestBed.tick();
    expect(pane()?.style.width).toBe('500px');

    // The anchor grows, and the only thing that hears about it is the observer.
    anchor.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    fireResize();

    expect(pane()?.style.width).toBe('800px');
  });

  it('gives the width back when matching is turned off', async () => {
    // The other direction, and the one that is easy to miss: `updateSize` is the only thing
    // that clears a width CDK already holds, so an implementation that only calls it while
    // matching leaves the layer pinned at the last measurement for good.
    const { container, host } = await build();
    host.matchWidth.set(true);
    const anchor = container.querySelector('[data-t="anchor"]') as HTMLElement;
    anchor.getBoundingClientRect = () => ({ width: 500 }) as DOMRect;
    host.open.set(true);
    TestBed.tick();
    expect(pane()?.style.width).toBe('500px');

    host.matchWidth.set(false);
    TestBed.tick();

    expect(pane()?.style.width).toBe('');
  });

  it('disposes the layer when the host that owns it is destroyed', async () => {
    // Asserted on the PANE, not on the content, and that distinction is the test.
    //
    // The portal's embedded view belongs to the directive's `ViewContainerRef`, so a
    // destroyed host takes the content down with it whatever this directive does — an
    // assertion on `[data-t="layer"]` stays green with the teardown deleted, which is where
    // this test started. What survives is CDK's own pane element, its position strategy and
    // its reposition-on-scroll subscription: an empty box, still listening, for good.
    const { host } = await build();
    host.open.set(true);
    TestBed.tick();
    expect(panes()).toBe(1);

    host.mounted.set(false);
    TestBed.tick();

    expect(panes()).toBe(0);
    expect(layer()).toBeNull();
  });
});

/** Counts its own lifecycle, so a test can tell a kept view from a rebuilt one. */
const lifecycle = { created: 0, destroyed: 0 };
@Component({
  selector: 'trn-test-counted',
  template: `<span data-t="kept">{{ label() }}</span
    ><span data-t="shown">{{ overlay.shown() }}</span>`,
})
class CountedComponent implements OnDestroy {
  protected readonly overlay = inject(TrnAnchoredOverlayDirective);
  readonly label = input('kept');
  constructor() {
    lifecycle.created++;
  }
  ngOnDestroy(): void {
    lifecycle.destroyed++;
  }
}

@Component({
  imports: [TrnAnchoredOverlayDirective, CountedComponent],
  template: `
    @if (mounted()) {
      <div #anchor data-t="anchor">field</div>
      <ng-template
        [trnAnchoredOverlay]="anchor"
        [(open)]="open"
        [retainFor]="retainMs()"
        [retainKey]="key()"
      >
        <trn-test-counted [label]="label()" />
      </ng-template>
    }
  `,
})
class RetainHostComponent {
  readonly open = signal(false);
  readonly retainMs = signal(60_000);
  readonly mounted = signal(true);
  readonly key = signal('@a:hs');
  readonly label = signal('kept');
}

describe('TrnAnchoredOverlayDirective retained view (#1320)', () => {
  const kept = () => document.querySelector('[data-t="kept"]');
  async function buildRetained(retainMs = 60_000) {
    lifecycle.created = 0;
    lifecycle.destroyed = 0;
    const { fixture } = await render(RetainHostComponent);
    fixture.componentInstance.retainMs.set(retainMs);
    TestBed.tick();
    return fixture.componentInstance;
  }
  const toggle = (host: RetainHostComponent, open: boolean) => {
    host.open.set(open);
    TestBed.tick();
  };

  afterEach(() => {
    document
      .querySelectorAll('.cdk-overlay-container')
      .forEach((el) => el.remove());
  });

  it('shows the same rendered content again instead of rebuilding it', async () => {
    const host = await buildRetained();
    toggle(host, true);
    const first = kept();
    expect(first).not.toBeNull();

    toggle(host, false);
    toggle(host, true);

    // Rebuilding a large layer (the composer's emoji grid, ~5,500 nodes) on every open is
    // the cost this avoids.
    expect(kept()).toBe(first);
    expect(lifecycle.created).toBe(1);
    expect(lifecycle.destroyed).toBe(0);
  });

  it('takes the kept content out of the document while closed', async () => {
    const host = await buildRetained();
    toggle(host, true);
    const element = kept();

    toggle(host, false);

    expect(kept()).toBeNull();
    expect(element?.isConnected).toBe(false);
  });

  it('lets the kept content see every reopen, which it is not created again for', async () => {
    const host = await buildRetained();
    const shown = () => document.querySelector('[data-t="shown"]')?.textContent;
    toggle(host, true);
    expect(shown()).toBe('1');

    toggle(host, false);
    toggle(host, true);

    expect(shown()).toBe('2');
  });

  it('shows an input that changed while the view was kept', async () => {
    const host = await buildRetained();
    toggle(host, true);
    toggle(host, false);

    host.label.set('renamed');
    TestBed.tick();
    toggle(host, true);

    expect(kept()?.textContent).toBe('renamed');
  });

  it('destroys the kept view with the host while it is open', async () => {
    const host = await buildRetained();
    toggle(host, true);

    host.mounted.set(false);
    TestBed.tick();

    expect(lifecycle.destroyed).toBe(1);
  });

  it('releases the kept view when retention is turned off', async () => {
    const host = await buildRetained();
    toggle(host, true);
    toggle(host, false);

    host.retainMs.set(0);
    TestBed.tick();

    expect(lifecycle.destroyed).toBe(1);
  });

  it.each([-5, Number.NaN])(
    'treats a retention of %s as off',
    async (retainMs) => {
      const host = await buildRetained(retainMs);
      toggle(host, true);
      toggle(host, false);
      toggle(host, true);

      expect(lifecycle.created).toBe(2);
    },
  );

  it('waits as long as a timer can for a retention past that, rather than not at all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const host = await buildRetained(Number.POSITIVE_INFINITY);
      toggle(host, true);
      toggle(host, false);

      // `setTimeout` fires at once for a delay past 2^31 - 1 ms.
      vi.advanceTimersByTime(60_000);

      expect(lifecycle.destroyed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the kept view when the layer changes hands', async () => {
    const host = await buildRetained();
    toggle(host, true);
    toggle(host, false);

    host.key.set('@b:hs');
    TestBed.tick();

    expect(lifecycle.destroyed).toBe(1);
  });

  it('releases a view that changed hands while open once it closes, not under the user', async () => {
    const host = await buildRetained();
    toggle(host, true);

    host.key.set('@b:hs');
    TestBed.tick();
    expect(lifecycle.destroyed).toBe(0);

    toggle(host, false);
    expect(lifecycle.destroyed).toBe(1);
    toggle(host, true);
    expect(lifecycle.created).toBe(2);
  });

  it('destroys the kept view with the host', async () => {
    const host = await buildRetained();
    toggle(host, true);
    toggle(host, false);

    host.mounted.set(false);
    TestBed.tick();

    expect(lifecycle.destroyed).toBe(1);
  });

  it('releases the kept view once it has stayed closed long enough', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const host = await buildRetained(60_000);
      toggle(host, true);
      toggle(host, false);

      // A reopen inside the window keeps it, and restarts the clock when it closes again.
      vi.advanceTimersByTime(59_000);
      toggle(host, true);
      toggle(host, false);
      vi.advanceTimersByTime(59_000);
      expect(lifecycle.destroyed).toBe(0);

      // Idle past the window, its memory goes; the next open builds a fresh view.
      vi.advanceTimersByTime(2_000);
      expect(lifecycle.destroyed).toBe(1);
      toggle(host, true);
      expect(lifecycle.created).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rebuilds the content on every open without the opt-in', async () => {
    const host = await buildRetained(0);
    toggle(host, true);
    toggle(host, false);
    toggle(host, true);

    expect(lifecycle.created).toBe(2);
    expect(lifecycle.destroyed).toBe(1);
  });
});
