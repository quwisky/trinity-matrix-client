import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseFlashWindow,
  parseSheetView,
  parseWorkflowView,
  type FlashWindow,
  type SheetView,
  type WorkflowView,
} from './pinned-message-workflow-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android
 * pinned-message-workflow suite.
 *
 * Every builder returns one pure expression string. It reads the DOM,
 * computed style and hit-testing only: no click, focus, key, scroll, class,
 * style, attribute or location write, and no handler is invoked. The passive
 * flash recorder (armed once per jump) only observes class and click events;
 * it never prevents, stops or re-dispatches (spec D5).
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

export interface WorkflowTexts {
  readonly roomName: string;
  readonly targetBody: string;
  /** Stage 2 only; `null` in stage 1. */
  readonly lastFillerBody: string | null;
}

/** Playwright's toBeInViewport: a positive-area box after clipping by `.scroll` and the window. */
const IN_VIEW = `
    const inView = (e) => {
      if (!e || e.getClientRects().length === 0) return false;
      const r = e.getBoundingClientRect(), s = e.closest('.scroll')?.getBoundingClientRect();
      const top = Math.max(r.top, s ? s.top : 0, 0), bottom = Math.min(r.bottom, s ? s.bottom : view.innerHeight, view.innerHeight);
      const left = Math.max(r.left, s ? s.left : 0, 0), right = Math.min(r.right, s ? s.right : view.innerWidth, view.innerWidth);
      return bottom - top > 0 && right - left > 0;
    };`;

export function workflowViewExpression(texts: WorkflowTexts): string {
  return `(() => {${PRELUDE}${IN_VIEW}
    const { roomName, targetBody, lastFillerBody } = ${JSON.stringify(texts)};
    const norm = (t) => (t ?? '').replace(/\\s+/gu, ' ').trim();
    const rows = [...document.querySelectorAll('.scroll .msg[data-mid]')];
    const match = (body) => body === null ? [] : rows.filter((e) => (e.textContent ?? '').includes(body));
    const target = match(targetBody), last = match(lastFillerBody);
    const scrolls = [...document.querySelectorAll('.scroll')];
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
      .filter((h) => norm(h.textContent) === 'Pinned messages' && visible(h));
    const pinRows = [...document.querySelectorAll('.pin-item')].filter((e) => (e.textContent ?? '').includes(targetBody));
    const empties = [...document.querySelectorAll('[data-testid="pinned-empty"]')];
    const closes = [...document.querySelectorAll('[data-testid="pinned-close"]')];
    const open = [...document.querySelectorAll('[data-testid="open-pinned"]')];
    const latest = [...document.querySelectorAll('[data-testid="jump-to-latest"]')];
    const hit = (e) => { const b = e?.getBoundingClientRect(); if (!b || b.width === 0) return false;
      const h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!h && e.contains(h); };
    const unpins = pinRows[0] ? [...pinRows[0].querySelectorAll('[data-testid="pinned-unpin"]')] : [];
    return {
      reducedMotion: view.matchMedia('(prefers-reduced-motion: reduce)').matches,
      namesRoom: [...document.querySelectorAll('trn-page-header h1')].some((h) => (h.textContent ?? '').includes(roomName)),
      scroll: { count: scrolls.length, visible: scrolls.length === 1 && visible(scrolls[0]) },
      target: { count: target.length, inViewport: inView(target[0]) },
      lastFiller: { count: last.length, inViewport: inView(last[0]) },
      badges: [...document.querySelectorAll('.header-pin__badge')].map((b) => ({
        host: b.parentElement?.getAttribute('data-testid') ?? null, text: norm(b.textContent), visible: visible(b) })),
      heading: { count: headings.length },
      pinRow: { count: pinRows.length, visible: !!pinRows[0] && visible(pinRows[0]),
        bodyIncludes: (pinRows[0]?.querySelector('.pin-item__body')?.textContent ?? '').includes(targetBody),
        unpinCount: unpins.length, unpinInside: !!unpins[0] && pinRows[0].contains(unpins[0]), unpinUnobstructed: hit(unpins[0]) },
      empty: { count: empties.length, visible: !!empties[0] && visible(empties[0]),
        exact: norm(empties[0]?.textContent) === 'No pinned messages in this channel yet.' },
      close: { count: closes.length, label: closes[0]?.getAttribute('aria-label') ?? null },
      openPinned: { count: open.length, rendered: !!open[0] && open[0].getClientRects().length > 0 &&
        open[0].getBoundingClientRect().width > 0 },
      jumpLatest: { count: latest.length, visible: !!latest[0] && visible(latest[0]), unobstructed: hit(latest[0]) },
    };
  })()`;
}

export function sheetViewExpression(): string {
  return `(() => {${PRELUDE}
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="Message actions"]')];
    const pins = [...document.querySelectorAll('[role="dialog"][aria-label="Message actions"] [data-testid="sheet-pin"]')];
    const b = pins[0]?.getBoundingClientRect();
    const h = b ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
    return { dialogs: dialogs.length, dialogVisible: dialogs.length === 1 && visible(dialogs[0]),
      pin: { count: pins.length, visible: pins.length === 1 && visible(pins[0]), unobstructed: !!h && !!pins[0]?.contains(h) } };
  })()`;
}

// The passive flash recorder (spec D5): one never-reused window key per jump.

export function flashRecorderKey(n: number): string {
  assert(Number.isSafeInteger(n) && n > 0, 'Flash window number');
  return `__trinityPinnedFlash${n}`;
}

const KEY = /^__trinityPinnedFlash[1-9]\d*$/u;

/**
 * Passive: a MutationObserver (microtask delivery, not frame-bound) notes every
 * `msg--flash` membership change on a timeline row; a passive capture-phase
 * listener notes each click. Nothing is prevented, stopped or re-dispatched.
 */
export function armFlashRecorderExpression(key: string, targetBody: string): string {
  assert(KEY.test(key), 'Flash recorder key');
  return `(() => {${PRELUDE}${IN_VIEW}
    const key = ${JSON.stringify(key)}, targetBody = ${JSON.stringify(targetBody)};
    if (Object.prototype.hasOwnProperty.call(view, key)) throw new Error('Flash recorder already armed: ' + key);
    const label = (e) => (e.textContent ?? '').includes(targetBody) ? 'target' : 'other';
    const targetRow = () => [...document.querySelectorAll('.scroll .msg[data-mid]')].find((e) => label(e) === 'target') ?? null;
    const state = { events: [] };
    Object.defineProperty(view, key, { value: state, writable: false, configurable: false, enumerable: false });
    new view.MutationObserver((records) => {
      for (const r of records) {
        const e = r.target;
        if (!(e instanceof view.Element) || !e.matches('.scroll .msg[data-mid]')) continue;
        const was = (r.oldValue ?? '').split(/\\s+/u).includes('msg--flash');
        const now = e.classList.contains('msg--flash');
        if (was !== now) state.events.push({ kind: now ? 'add' : 'remove', at: view.performance.now(), label: label(e), inViewport: inView(e) });
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    document.addEventListener('click', (event) => {
      const item = event.target instanceof view.Element ? event.target.closest('[data-testid="pinned-item"]') : null;
      state.events.push({ kind: 'click', at: view.performance.now(), itemLabel: item ? label(item) : null,
        trusted: event.isTrusted, targetInViewport: inView(targetRow()) });
    }, { capture: true, passive: true });
    const row = targetRow();
    return { armed: true, targetRendered: row ? 1 : 0, targetFlashing: !!row && row.classList.contains('msg--flash') };
  })()`;
}

export function readFlashRecorderExpression(key: string): string {
  assert(KEY.test(key), 'Flash recorder key');
  return `(() => { const s = document.defaultView?.[${JSON.stringify(key)}]; return s ? { events: s.events.slice() } : null; })()`;
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

export async function readWorkflowView(
  client: AccountWorkspaceClient, texts: WorkflowTexts, options: ObservationOptions<WorkflowView> = {},
): Promise<WorkflowView> {
  return observe(client, workflowViewExpression(texts), parseWorkflowView, 'pinned workflow view observation', options);
}

export async function readSheetView(
  client: AccountWorkspaceClient, options: ObservationOptions<SheetView> = {},
): Promise<SheetView> {
  return observe(client, sheetViewExpression(), parseSheetView, 'message actions sheet observation', options);
}

export async function readFlashRecorder(
  client: AccountWorkspaceClient, key: string, options: ObservationOptions<FlashWindow> = {},
): Promise<FlashWindow> {
  return observe(client, readFlashRecorderExpression(key), parseFlashWindow, 'pinned flash recorder window', options);
}

/** Arm once, immediately before the jump tap; asserts the target is rendered and not already flashing. */
export async function armFlashRecorder(
  client: AccountWorkspaceClient, key: string, targetBody: string,
): Promise<void> {
  const result = await evaluateNative(client.webview, armFlashRecorderExpression(key, targetBody));
  assert(result && typeof result === 'object', 'Flash recorder arm result is an object');
  const value = result as Record<string, unknown>;
  assert(value['armed'] === true && value['targetRendered'] === 1 && value['targetFlashing'] === false,
    'Flash recorder armed with the target rendered and not flashing');
}
