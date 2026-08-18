import '../../../../test-setup.base';

// jsdom has no ResizeObserver, and the kit's select sets one up on render — brain's
// `getSharedObserver()` runs inside an `afterRender` hook, which SWALLOWS the
// ReferenceError. Without this stub the suite still reported "4 passed" while printing
// four stack traces, and every test ran against a component whose `_triggerWidth` had
// never been measured. A no-op is enough: these specs assert the trigger's label, class
// and placeholder, not the overlay's measurement path (that needs a real browser and is
// covered in e2e). Same stub, and the same reason, as libs/feature/settings.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe(): void {
      // no-op
    }
    unobserve(): void {
      // no-op
    }
    disconnect(): void {
      // no-op
    }
  }
  globalThis.ResizeObserver =
    NoopResizeObserver as unknown as typeof ResizeObserver;
}
