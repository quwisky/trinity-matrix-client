import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';
import '@testing-library/jest-dom/vitest';
import { ngMocks } from 'ng-mocks';
import { vi } from 'vitest';

// Shared Vitest setup for the Angular libs + app. Each project's
// src/test-setup.ts (the vite `setupFiles` entry) imports this; lib-specific
// extras (e.g. feature-rooms' ResizeObserver stub) are appended in that file.

// jsdom forwards non-fatal "jsdomError" events to the console, flooding test
// output with noise from feature gaps our components legitimately hit:
//   • "Could not parse CSS stylesheet" — originally cascade layers (`@layer`, emitted
//     by ng-icons and the CDK overlay), which jsdom 27 learned to parse. Verified on
//     jsdom 30: `@layer` alone no longer errors. The entry stays because it is keyed on
//     a message, not a cause, and Tailwind v4 still emits constructs jsdom's CSS parser
//     rejects (`@property`, `color-mix`, nested rules). Do not drop it on the strength
//     of `@layer` being fixed — confirm nothing else trips it first.
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

// jsdom has no ResizeObserver. Most component specs only need the browser API to
// exist so layout-aware dependencies can initialize; projects that assert resize
// behavior replace this with a controllable observer in their own test setup.
class NoopResizeObserver {
  observe(): void {
    // jsdom has no layout to observe.
  }
  unobserve(): void {
    // jsdom has no layout to observe.
  }
  disconnect(): void {
    // jsdom has no layout to observe.
  }
}
globalThis.ResizeObserver =
  NoopResizeObserver as unknown as typeof ResizeObserver;

// jsdom HAS shipped PointerEvent since 27, so this is no longer a missing-feature shim.
// It survives for its DEFAULTS. The native constructor follows the spec — `pointerType`
// is '' and `isPrimary` false — while brain's BrnTooltip (>= 1.2.0) opens only for a
// `pointerType` of 'mouse' or 'pen'. So on stock jsdom a plain
// `fireEvent.pointerEnter(el)` builds an event brain silently rejects, and the spec fails
// in a way indistinguishable from the bug it is testing for.
//
// Those are the right defaults for a browser and the wrong ones for a test double.
// Defaulting to a primary mouse makes the common case correct and leaves
// `{ pointerType: 'touch' }` an explicit opt-in. Angular CDK's own test harness takes the
// same view (`isPrimary: true`).
//
// Deleting it would pass today — all three pointer call sites in
// message-row.component.spec.ts name `pointerType` explicitly — and would re-arm the trap
// for the next spec written without one. That is the whole reason it is still here.
//
// Subclassing MouseEvent keeps the event's mouse-ness: brn reads clientX/clientY off the
// same object for overlay positioning.
//
// Two things this does NOT solve, both verified against jsdom 30:
//   - jsdom still implements no pointer *capture*. setPointerCapture, hasPointerCapture
//     and releasePointerCapture are absent from its DOM, so a spec driving brain's
//     sonner/drawer/slider swipe paths (all of which call
//     `target.setPointerCapture(event.pointerId)`) needs those three stubbed too,
//     whatever this shim carries.
//   - `element.click()` fires a NATIVE PointerEvent on jsdom >= 27, so an event from a
//     click is not an instance of the class stubbed here. Nothing in the tree does
//     `instanceof PointerEvent` today (checked across brain, CDK and core), so this is
//     latent rather than live — but it is the seam a future dependency would trip on.
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
