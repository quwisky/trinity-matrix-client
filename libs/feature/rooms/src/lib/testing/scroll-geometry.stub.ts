type Measure = number | (() => number);

/**
 * jsdom has no layout, so give a scroller the geometry a test depends on. Pass only the
 * properties the test needs. `scrollTop` is a writable number, or `{ get, set }` when the
 * test keeps its own variable to assert on; `clientHeight`/`scrollHeight` may be getters.
 */
export function setScrollGeometry(
  scroll: HTMLElement,
  geometry: {
    readonly scrollTop?: number | { get(): number; set(value: number): void };
    readonly clientHeight?: Measure;
    readonly scrollHeight?: Measure;
  },
): HTMLElement {
  const { scrollTop, clientHeight, scrollHeight } = geometry;
  const measure = (value: Measure): PropertyDescriptor =>
    typeof value === 'number'
      ? { value, configurable: true }
      : { get: value, configurable: true };
  if (clientHeight !== undefined) {
    Object.defineProperty(scroll, 'clientHeight', measure(clientHeight));
  }
  if (scrollHeight !== undefined) {
    Object.defineProperty(scroll, 'scrollHeight', measure(scrollHeight));
  }
  if (scrollTop !== undefined) {
    Object.defineProperty(
      scroll,
      'scrollTop',
      typeof scrollTop === 'number'
        ? { value: scrollTop, configurable: true, writable: true }
        : { get: scrollTop.get, set: scrollTop.set, configurable: true },
    );
  }
  return scroll;
}
