import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';
import '@testing-library/jest-dom/vitest';
import { ngMocks } from 'ng-mocks';
import { vi } from 'vitest';

// Shared Vitest setup for the Angular libs + app. Each project's
// src/test-setup.ts (the vite `setupFiles` entry) imports this; lib-specific
// extras (e.g. feature-rooms' ResizeObserver stub) are appended in that file.

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

// jsdom has no matchMedia. brain-sonner's toaster reads it in an afterRender hook
// (theme / reduced-motion), so rendering <hlm-toaster> throws a TypeError there;
// stub it so the toaster initializes fully instead of surviving on render ordering.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
}));

// jsdom 25 has no PointerEvent, and that gap is a silent trap rather than a missing
// feature. brain's BrnTooltip (>= 1.2.0) opens only for a `pointerType` of 'mouse' or
// 'pen', while @testing-library/dom builds events as `window[EventType] || window.Event`
// — so for a window without PointerEvent it falls back to the plain Event constructor,
// which drops `pointerType` on the floor. Without this shim
// `fireEvent.pointerEnter(el, { pointerType: 'mouse' })` arrives ungated and the tooltip
// never opens, failing in a way indistinguishable from the bug it is testing for.
//
// Subclassing MouseEvent (rather than Event) keeps the event's mouse-ness — brn reads
// clientX/clientY off the same object for overlay positioning.
//
// The defaults deliberately DIVERGE from the PointerEvent spec, which says `pointerType`
// is '' and `isPrimary` false. Those are the right defaults for a browser and the wrong
// ones for a test double: they would re-create the very trap above one step later, since
// a plain `fireEvent.pointerEnter(el)` would produce an event brain rejects and a spec
// that fails for an invisible reason. Defaulting to a primary mouse makes the common
// case correct and leaves `{ pointerType: 'touch' }` an explicit opt-in. Angular CDK's
// own test harness takes the same view (`isPrimary: true`).
//
// Not solved here, and not solvable this way: jsdom implements no pointer *capture* —
// setPointerCapture/hasPointerCapture/releasePointerCapture are absent from its DOM — so
// a spec driving brain's sonner/drawer/slider swipe paths (all of which call
// `target.setPointerCapture(event.pointerId)`) needs those three methods stubbed too,
// whatever this shim carries.
vi.stubGlobal(
  'PointerEvent',
  class JsdomPointerEvent extends MouseEvent {
    readonly pointerType: string;
    readonly pointerId: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? 'mouse';
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  },
);

// Zoneless TestBed (provideZonelessChangeDetection); the app runs zoneless in
// production, so specs exercise the same change-detection mode.
setupTestBed({ zoneless: true });

// ng-mocks: back every auto-mocked method with a vitest spy so migrated specs
// can use `.mockReturnValue(...)` / `.toHaveBeenCalledWith(...)` on MockProvider stubs.
ngMocks.autoSpy(() => vi.fn());
