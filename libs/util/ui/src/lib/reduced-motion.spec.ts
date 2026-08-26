import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, scrollBehavior } from './reduced-motion';

/** Replace `matchMedia` with one that answers `matches` for the reduced-motion query. */
function prefers(matches: boolean): (query: string) => MediaQueryList {
  const impl = vi.fn(
    (query: string) => ({ matches, media: query }) as MediaQueryList,
  );
  vi.stubGlobal('matchMedia', impl);
  return impl;
}

describe('reduced motion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the preference the browser reports', () => {
    prefers(true);
    expect(prefersReducedMotion()).toBe(true);

    prefers(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('asks about reduced motion specifically', () => {
    // A helper that asked a different question would still return a boolean, and every
    // assertion here would still pass — the query string is the whole meaning.
    const impl = prefers(true);

    prefersReducedMotion();

    expect(impl).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('jumps instead of animating when the user asked for less motion', () => {
    prefers(true);
    expect(scrollBehavior()).toBe('auto');
  });

  it('animates when they did not', () => {
    prefers(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('falls back to the behaviour the app had before, with no matchMedia', () => {
    // Not merely "does not throw": the fallback has to be `smooth`, because `auto` would
    // silently remove the animation for everyone in any context lacking the API.
    vi.stubGlobal('matchMedia', undefined);

    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe('smooth');
  });
});
