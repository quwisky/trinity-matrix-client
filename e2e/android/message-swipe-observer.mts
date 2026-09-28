import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parsePointerEvents,
  parseSwipeView,
  type SwipeViewObservation,
  type TrustedPointerEvent,
} from './message-swipe-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android message-swipe suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, computed
 * style, geometry, scroll offsets and the location only: no click, focus, key,
 * scroll, class, style, attribute or location write, no pointer dispatch, and
 * no handler is invoked. The one exception is the pointer recorder, which adds
 * passive capture listeners that copy trusted event fields into an array; it
 * never prevents, stops or dispatches an event. Window-level values are reached
 * through `document.defaultView`, so a guard can execute the same text in jsdom.
 */

const OBSERVATION_TIMEOUT_MS = 15_000;

export interface ObservationOptions<T> {
  readonly accepts?: (value: T) => boolean;
  readonly description?: string;
  readonly timeoutMs?: number;
}

/** One target row: its exact body and, once known, its arranged event id. */
export interface RowTarget {
  readonly body: string;
  readonly eventId: string;
}

export function swipeViewExpression(targets: readonly RowTarget[]): string {
  return `(() => {
    const targets = ${JSON.stringify(targets)};
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    const measure = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height };
    };
    const visible = (element) => {
      if (!element) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        view.getComputedStyle(element).visibility === 'visible' &&
        view.getComputedStyle(element).display !== 'none';
    };
    const rows = [...document.querySelectorAll('.scroll .msg[data-mid]')]
      .filter((row) => !row.classList.contains('msg--event'));
    const composers = [...document.querySelectorAll('[data-testid="composer-input"]')];
    const composer = composers.length === 1 ? composers[0] : null;
    const drawers = [...document.querySelectorAll('.chat-members')];
    const scrollers = [...document.querySelectorAll('.scroll')];
    const scroller = scrollers[0] ?? null;
    const detail = document.querySelector('[data-testid="settings-detail"]');
    return {
      href: view.location.href,
      timeOrigin: view.performance.timeOrigin,
      innerWidth: view.innerWidth,
      innerHeight: view.innerHeight,
      rows: targets.map(({ body, eventId }) => {
        const matches = rows.filter((row) => (row.textContent ?? '').includes(body));
        const row = matches.at(-1) ?? null;
        const icons = row ? [...row.querySelectorAll('.msg__swipe')] : [];
        const icon = icons.length === 1 ? icons[0] : null;
        const glyph = icon ? icon.querySelector('trn-icon') : null;
        const style = icon ? view.getComputedStyle(icon) : null;
        return {
          body,
          matches: matches.length,
          exactEvent: !!row && eventId.length > 0 && row.getAttribute('data-mid') === eventId,
          reconciled: !!row && (row.getAttribute('data-mid') ?? '').startsWith('$'),
          visible: visible(row),
          box: measure(row),
          drag: row ? row.style.getPropertyValue('--swipe-drag') : '',
          progress: row ? row.style.getPropertyValue('--swipe-progress') : '',
          swiping: !!row && row.classList.contains('msg--swiping'),
          armed: !!row && row.classList.contains('msg--swipe-armed'),
          affordance: {
            count: icons.length,
            action: icon ? icon.getAttribute('data-swipe-action') : null,
            end: !!icon && icon.classList.contains('msg__swipe--end'),
            visible: visible(icon),
            opacity: style ? Number(style.opacity) : null,
            color: style ? style.color : null,
            scale: glyph ? view.getComputedStyle(glyph).scale : null,
            icon: measure(glyph),
          },
        };
      }),
      banners: [...document.querySelectorAll('.composer__banner')].map((banner) => ({
        text: (banner.textContent ?? '').trim(),
        strong: banner.querySelector('strong')?.textContent?.trim() ?? null,
      })),
      composer: {
        count: composers.length,
        visible: visible(composer),
        value: composer && 'value' in composer ? composer.value : null,
        placeholder: composer ? composer.getAttribute('placeholder') : null,
      },
      encryptionBanners: [...document.querySelectorAll('trn-banner')]
        .filter((banner) => (banner.textContent ?? '').includes('Set up encryption') && visible(banner)).length,
      drawer: {
        count: drawers.length,
        visible: drawers.some(visible),
        box: measure(drawers[0] ?? null),
      },
      scroll: {
        count: scrollers.length,
        scrollTop: scroller ? scroller.scrollTop : null,
        scrollHeight: scroller ? scroller.scrollHeight : null,
        clientHeight: scroller ? scroller.clientHeight : null,
        box: measure(scroller),
      },
      settings: {
        hosts: document.querySelectorAll('trn-settings').length,
        dialogs: [...document.querySelectorAll('[role="dialog"]')]
          .filter((dialog) => dialog.getAttribute('aria-label') === 'Settings' && visible(dialog)).length,
        sectionsVisible: visible(document.querySelector('nav[aria-label="Settings sections"]')),
        detailNonEmpty: !!detail && (detail.textContent ?? '').trim().length > 0,
        backButtons: [...document.querySelectorAll('button')]
          .filter((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === 'Back' && visible(button)).length,
      },
    };
  })()`;
}

/** Install passive capture listeners that copy trusted pointer fields; never prevents or dispatches. */
export function pointerRecorderExpression(): string {
  return `(() => {
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    const previous = view.__trinitySwipeRecorder;
    if (previous) for (const [type, listener] of previous.listeners)
      document.removeEventListener(type, listener, true);
    const recorder = { events: [], listeners: [] };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      const listener = (event) => recorder.events.push({
        type: event.type, trusted: event.isTrusted, pointerType: event.pointerType,
        pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        timeStamp: event.timeStamp,
      });
      recorder.listeners.push([type, listener]);
      document.addEventListener(type, listener, { capture: true, passive: true });
    }
    view.__trinitySwipeRecorder = recorder;
    return true;
  })()`;
}

export function pointerEventsExpression(): string {
  return `(() => {
    const recorder = document.defaultView?.__trinitySwipeRecorder;
    return recorder ? recorder.events.slice() : [];
  })()`;
}

export async function readSwipeView(
  client: AccountWorkspaceClient,
  targets: readonly RowTarget[],
  options: ObservationOptions<SwipeViewObservation> = {},
): Promise<SwipeViewObservation> {
  return waitForNativeShellState(
    async () => parseSwipeView(await evaluateNative(client.webview, swipeViewExpression(targets))),
    options.accepts ?? (() => true),
    options.description ?? 'message-swipe view observation',
    client.signal,
    options.timeoutMs ?? OBSERVATION_TIMEOUT_MS,
  );
}

export async function installPointerRecorder(client: AccountWorkspaceClient): Promise<void> {
  await evaluateNative(client.webview, pointerRecorderExpression());
}

export async function readPointerEvents(
  client: AccountWorkspaceClient,
): Promise<readonly TrustedPointerEvent[]> {
  return parsePointerEvents(await evaluateNative(client.webview, pointerEventsExpression()));
}

/** The per-stage `profile-applied.json` payload read back from the WebView. */
export async function readAppliedProfile(client: AccountWorkspaceClient): Promise<unknown> {
  return evaluateNative(client.webview, `(() => {
    const view = document.defaultView;
    return {
      innerWidth: view.innerWidth,
      innerHeight: view.innerHeight,
      devicePixelRatio: view.devicePixelRatio,
      coarsePointer: view.matchMedia('(pointer: coarse)').matches,
      hoverNone: view.matchMedia('(hover: none)').matches,
      platform: view.Capacitor?.getPlatform?.() ?? null,
    };
  })()`);
}
