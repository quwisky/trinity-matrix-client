import {
  Component,
  DestroyRef,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BELOW_MD_QUERY,
  BELOW_MEMBERS_QUERY,
  MD_QUERY,
  MEMBERS_QUERY,
  matchesQuery,
  mediaQuerySignal,
} from './media-query';

/** A controllable MediaQueryList double: `emit` fires a `change` at every listener. */
function fakeList(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  return {
    list: {
      matches,
      addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) =>
        listeners.add(fn),
      removeEventListener: (
        _type: string,
        fn: (e: MediaQueryListEvent) => void,
      ) => listeners.delete(fn),
    },
    get listenerCount() {
      return listeners.size;
    },
    emit(next: boolean) {
      for (const fn of listeners) {
        fn({ matches: next } as MediaQueryListEvent);
      }
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/**
 * Read the signal through a real component.
 *
 * `mediaQuerySignal` no longer needs an injection context — the caller hands it a
 * `DestroyRef` — but a REAL one is still the point of the teardown assertion below: a
 * hand-rolled double would only prove the function calls `onDestroy`, not that a destroyed
 * caller actually drops the listener. So the host stays, and it is also the shape every
 * call site uses.
 */
function hostFor(query: string): {
  value: Signal<boolean>;
  destroy: () => void;
} {
  @Component({ selector: 'trn-mq-host', template: '' })
  class MqHostComponent {
    readonly value = mediaQuerySignal(query, inject(DestroyRef));
  }
  const fixture = TestBed.createComponent(MqHostComponent);
  return {
    value: fixture.componentInstance.value,
    destroy: () => fixture.destroy(),
  };
}

describe('media queries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes complementary breakpoints that cannot both match', () => {
    expect(MD_QUERY).toBe('(min-width: 768px)');
    expect(BELOW_MD_QUERY).toBe('(max-width: 767.98px)');
    expect(MEMBERS_QUERY).toBe('(min-width: 1100px)');
    expect(BELOW_MEMBERS_QUERY).toBe('(max-width: 1099.98px)');
  });

  // These literals are restated in two other languages — the Tailwind theme and the rooms
  // feature's SCSS — because a media query cannot read a custom property.
  // `scripts/breakpoints.spec.mjs` is what checks all three agree; this only pins the pair
  // that TypeScript owns.
  describe('matchesQuery', () => {
    it('reads the query once, with no listener to clean up', () => {
      const list = fakeList(true);
      const matchMedia = vi.fn().mockReturnValue(list.list);
      vi.stubGlobal('matchMedia', matchMedia);

      expect(matchesQuery(MEMBERS_QUERY)).toBe(true);
      expect(matchMedia).toHaveBeenCalledWith(MEMBERS_QUERY);
    });

    it('registers no listener, which is the whole difference from the signal', () => {
      // Not a style point. `RoomShellStore.membersOpen` SEEDS from this, and a listener here
      // would keep overwriting a state the user owns — reopening the member column on every
      // rotation across the breakpoint. Asserted as listener count rather than as "the
      // returned boolean did not change", which a primitive cannot do anyway.
      const list = fakeList(false);
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(list.list));

      matchesQuery(MEMBERS_QUERY);

      expect(list.listenerCount).toBe(0);
    });

    it('reads false where matchMedia does not exist at all', () => {
      vi.stubGlobal('matchMedia', undefined);

      expect(matchesQuery(MEMBERS_QUERY)).toBe(false);
    });
  });

  it('seeds from the current match', () => {
    const wide = fakeList(true);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(wide.list));

    expect(hostFor(MD_QUERY).value()).toBe(true);
  });

  // The point of a signal rather than a one-shot read: rotating a phone or dragging a window
  // across the breakpoint must re-render, not strand the layout the page loaded with.
  it('tracks the query as it changes', () => {
    const list = fakeList(false);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(list.list));
    const host = hostFor(MD_QUERY);

    expect(host.value()).toBe(false);
    list.emit(true);
    expect(host.value()).toBe(true);
  });

  it('removes its listener when the caller is destroyed', () => {
    const list = fakeList(false);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(list.list));
    const host = hostFor(MD_QUERY);
    expect(list.listenerCount).toBe(1);

    host.destroy();

    expect(list.listenerCount).toBe(0);
  });

  // Specs across this repo stub matchMedia as `vi.fn().mockReturnValue({ matches })` — a bare
  // object with no event API. A fixed value is right for them, so this must not throw.
  it('accepts a stub with no event API', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    expect(() => hostFor(MD_QUERY)).not.toThrow();
    expect(hostFor(MD_QUERY).value()).toBe(true);
  });

  it('reads false where matchMedia does not exist at all', () => {
    vi.stubGlobal('matchMedia', undefined);

    expect(hostFor(MD_QUERY).value()).toBe(false);
  });

  it('does not share state between two queries', () => {
    const lists = new Map([
      [MD_QUERY, fakeList(true)],
      [BELOW_MD_QUERY, fakeList(false)],
    ]);
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => lists.get(query)!.list),
    );

    expect(hostFor(MD_QUERY).value()).toBe(true);
    expect(hostFor(BELOW_MD_QUERY).value()).toBe(false);
  });

  it('is readonly to its caller', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(fakeList(true).list));

    const value = hostFor(MD_QUERY).value as unknown as ReturnType<
      typeof signal<boolean>
    >;
    expect(value.set).toBeUndefined();
  });
});
