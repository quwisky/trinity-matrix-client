import { vi } from 'vitest';

/**
 * A controllable IntersectionObserver for jsdom, which has none: it records what it observes
 * and its options, and {@link report} delivers an entry for one target as the browser would.
 */
export class TestIntersectionObserver {
  static readonly instances: TestIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    TestIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
    this.disconnected = true;
  }

  /** Report `target` as within the root's margin (or not), if it is still observed. */
  report(target: Element, isIntersecting: boolean): void {
    if (!this.observed.has(target)) return;
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

/** Install {@link TestIntersectionObserver} as the global, starting a fresh registry. */
export function stubIntersectionObserver(): void {
  TestIntersectionObserver.instances.length = 0;
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
}
