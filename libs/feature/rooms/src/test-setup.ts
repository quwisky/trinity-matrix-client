import '../../../../test-setup.base';

// jsdom has no ResizeObserver. This controllable stub lets the message-list tests
// drive the measurement path: it records the observed elements and its callback, and
// a static `instances` registry + `emit()` let a test deliver synthetic resize
// entries. (The virtualized list also feature-detects RO and degrades to render-all
// without one, so this needs to exist regardless.)
class TestResizeObserver {
  static readonly instances: TestResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  /** Test hook: deliver resize entries to this observer's callback. */
  emit(entries: ResizeObserverEntry[]): void {
    this.callback(entries, this as unknown as ResizeObserver);
  }
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver =
    TestResizeObserver as unknown as typeof ResizeObserver;
}
