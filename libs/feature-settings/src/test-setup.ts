import '../../../test-setup.base';

// jsdom has no ResizeObserver, which the spartan/brain select (hlm-select, used by the
// appearance palette dropdown) sets up on render. A no-op stub is enough here — these
// specs don't drive the overlay's measurement path (opening the dropdown needs a real
// browser and is covered in e2e). feature-rooms ships a controllable stub for its own
// virtualized-list tests; this project only needs the constructor to exist.
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
