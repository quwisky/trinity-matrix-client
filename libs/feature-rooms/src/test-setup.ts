import '@analogjs/vitest-angular/setup-zone';

import { getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

// jsdom 25 forwards non-fatal "jsdomError" events to the console, flooding test
// output with noise from feature gaps our components legitimately hit:
//   • "Could not parse CSS stylesheet" — jsdom can't parse CSS cascade layers
//     (`@layer`, emitted by ng-icons and the CDK overlay) on every style inject.
//   • "Not implemented: navigation" — jsdom has no real navigation, so a component
//     that redirects via `location.href` (e.g. SSO login) trips this.
// Filter just these known-benign messages at their source, the per-window
// VirtualConsole, so genuine errors still surface. (A console.error override can't
// catch them: jsdom captured the original console reference before vitest swapped
// in its capturing one.)
const IGNORED_JSDOM_ERRORS = [
  'Could not parse CSS stylesheet',
  'Not implemented: navigation',
];
const virtualConsole = (
  globalThis as unknown as {
    window?: {
      _virtualConsole?: { emit(event: string, ...args: unknown[]): boolean };
    };
  }
).window?._virtualConsole;
if (virtualConsole) {
  const emit = virtualConsole.emit.bind(virtualConsole);
  virtualConsole.emit = (event: string, ...args: unknown[]): boolean => {
    if (event === 'jsdomError') {
      const payload = args[0] as { message?: unknown } | undefined;
      const message =
        typeof payload?.message === 'string' ? payload.message : '';
      if (IGNORED_JSDOM_ERRORS.some((pattern) => message.includes(pattern))) {
        return false;
      }
    }
    return emit(event, ...args);
  };
}

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

getTestBed().initTestEnvironment(
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting(),
);
