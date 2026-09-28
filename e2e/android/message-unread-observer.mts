import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseAppliedProfile,
  parseUnreadView,
  type AppliedProfileObservation,
  type UnreadView,
} from './message-unread-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android message-unread suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, computed
 * style, hit-testing and `matchMedia` only: no click, focus, key, scroll,
 * class, style, attribute or location write, and no handler is invoked.
 * Window-level values are reached through `document.defaultView`, so a guard
 * can execute the same text in jsdom with only `document` in scope. The
 * passive sampler follows the same rule for `requestAnimationFrame`.
 */

const OBSERVATION_TIMEOUT_MS = 15_000;

export interface ObservationOptions<T> {
  /** Poll until this accepts the parsed observation; the default takes the first read. */
  readonly accepts?: (value: T) => boolean;
  readonly description?: string;
  /** Finite polling bound; defaults to 15 s. */
  readonly timeoutMs?: number;
}

const PRELUDE = `
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        view.getComputedStyle(element).visibility === 'visible';
    };
    const measure = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height,
      };
    };`;

/**
 * The unread view: the message scroller, the "New messages" divider (its own
 * thread connector, geometry and computed style), the jump-to-unread and
 * jump-to-latest pills, and the live reduced-motion query. Every field is
 * read in one renderer turn, because opening the Room can still scroll the
 * timeline (predecessor lines 172-173).
 */
export function unreadViewExpression(): string {
  return `(() => {${PRELUDE}
    const scroller = document.querySelector('.scroll[data-message-scroller]');
    const dividers = scroller
      ? [...scroller.querySelectorAll('[data-testid="new-messages-divider"]')]
      : [];
    const divider = dividers.length > 0 ? dividers[0] : null;
    const connectors = divider ? [...divider.querySelectorAll('.thread-connector')] : [];
    const connector = connectors.length > 0 ? connectors[0] : null;
    const extension = divider && connector ? (() => {
      const dividerBox = divider.getBoundingClientRect();
      const connectorBox = connector.getBoundingClientRect();
      return {
        above: dividerBox.top - connectorBox.top,
        below: connectorBox.bottom - dividerBox.bottom,
      };
    })() : { above: 0, below: 0 };
    const dividerStyle = divider ? view.getComputedStyle(divider) : null;
    const beforeStyle = divider ? view.getComputedStyle(divider, '::before') : null;
    const pill = (selector) => {
      const elements = [...document.querySelectorAll(selector)];
      const element = elements.length === 1 ? elements[0] : null;
      return {
        count: elements.length,
        visible: !!element && visible(element),
        box: element ? measure(element) : null,
      };
    };
    return {
      scroller: scroller ? {
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        box: measure(scroller),
      } : null,
      divider: divider ? {
        count: dividers.length,
        textContent: (divider.textContent ?? '').trim(),
        innerText: divider.innerText,
        box: measure(divider),
        connectorCount: connectors.length,
        above: extension.above,
        below: extension.below,
        display: dividerStyle.display,
        alignItems: dividerStyle.alignItems,
        fontWeight: dividerStyle.fontWeight,
        ruleFlexGrow: beforeStyle.flexGrow,
      } : null,
      jump: pill('[data-testid="jump-to-unread"]'),
      latest: pill('[data-testid="jump-to-latest"]'),
      reducedMotion: view.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  })()`;
}

export function appliedProfileExpression(): string {
  return `(() => {
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    return {
      innerWidth: view.innerWidth,
      innerHeight: view.innerHeight,
      devicePixelRatio: view.devicePixelRatio,
      coarsePointer: view.matchMedia('(pointer: coarse)').matches,
      hoverNone: view.matchMedia('(hover: none)').matches,
      platform: typeof view.Capacitor?.getPlatform === 'function' ? view.Capacitor.getPlatform() : null,
    };
  })()`;
}

/** Evaluate one read-only expression, parse it and poll within a finite bound. */
async function observe<T>(
  client: AccountWorkspaceClient,
  expression: string,
  parse: (value: unknown) => T,
  description: string,
  options: ObservationOptions<T>,
): Promise<T> {
  return waitForNativeShellState(
    async () => parse(await evaluateNative(client.webview, expression)),
    options.accepts ?? (() => true),
    options.description ?? description,
    client.signal,
    options.timeoutMs ?? OBSERVATION_TIMEOUT_MS,
  );
}

export async function readUnreadView(
  client: AccountWorkspaceClient,
  options: ObservationOptions<UnreadView> = {},
): Promise<UnreadView> {
  return observe(client, unreadViewExpression(), parseUnreadView,
    'message-unread view observation', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}

// The passive frame sampler: read-only per D4, never reusing a window key.

export function samplerKey(n: number): string {
  assert(Number.isSafeInteger(n) && n > 0, 'Sampler window number');
  return `__trinityUnreadTrajectory${n}`;
}

/**
 * Passive: reads scrollTop and the divider rect once per frame into its own
 * never-reused key. A passive capture listener only notes that the tap's click
 * arrived. The 45 s window counts from the first frame after that click,
 * because the native tap's latency is unbounded under load; a 120 s ceiling
 * from the start ends every loop, and the contract fails that window closed.
 */
export function startSamplerExpression(key: string): string {
  assert(/^__trinityUnreadTrajectory[1-9]\d*$/u.test(key), 'Sampler key');
  return `(() => {
    const key = ${JSON.stringify(key)};
    if (Object.prototype.hasOwnProperty.call(window, key)) return false;
    const scroller = document.querySelector('.scroll[data-message-scroller]');
    if (!scroller) return false;
    const state = { samples: [], done: false, tapped: false, ended: null };
    Object.defineProperty(window, key, { value: state, writable: false, configurable: false, enumerable: false });
    document.addEventListener('click', () => { state.tapped = true; }, { capture: true, once: true, passive: true });
    const inView = () => {
      const divider = scroller.querySelector('[data-testid="new-messages-divider"]');
      if (!divider) return false;
      const d = divider.getBoundingClientRect(), s = scroller.getBoundingClientRect();
      return d.height > 0 && d.top >= s.top && d.bottom <= s.bottom;
    };
    let start, tappedAt, last = scroller.scrollTop, moved = false, still = 0;
    const tick = (now) => {
      start ??= now;
      if (state.tapped) tappedAt ??= now;
      const top = scroller.scrollTop;
      state.samples.push([Math.round(now - start), top, inView()]);
      if (top !== last) { moved = true; still = 0; } else still++;
      last = top;
      state.ended = moved && still >= 60 ? 'settled'
        : tappedAt !== undefined && now - tappedAt > 45000 ? 'tap-window'
        : now - start > 120000 ? 'ceiling'
        : null;
      if (state.ended) { state.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  })()`;
}

export function readSamplerExpression(key: string): string {
  assert(/^__trinityUnreadTrajectory[1-9]\d*$/u.test(key), 'Sampler key');
  return `(() => { const s = window[${JSON.stringify(key)}]; return s ? { done: s.done, tapped: s.tapped, ended: s.ended, samples: s.samples.slice() } : null; })()`;
}
