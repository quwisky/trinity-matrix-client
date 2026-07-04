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

// jsdom has no ResizeObserver. The virtualized message list feature-detects it and
// degrades to render-all without one, but a no-op stub lets the observer wiring run
// (and be exercised) in the message-list component tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  } as unknown as typeof ResizeObserver;
}

getTestBed().initTestEnvironment(
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting(),
);
