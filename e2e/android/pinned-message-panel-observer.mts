import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseAppliedProfile,
  parsePinnedView,
  type AppliedProfileObservation,
  type PinnedView,
} from './pinned-message-panel-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android
 * pinned-message-panel suite.
 *
 * Every builder returns one pure expression string. It reads the DOM,
 * computed style and hit-testing only: no click, focus, key, scroll, class,
 * style, attribute or location write, and no handler is invoked.
 * `pinnedViewExpression` and `appliedProfileExpression` reach window-level
 * values through `document.defaultView`, so a guard can execute the same
 * text in jsdom with only `document` in scope.
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

export interface PinnedTexts { readonly roomName: string; readonly unpinBody: string; readonly keepBody: string }

/** One renderer turn; the texts enter only in-page comparisons and are never returned. */
export function pinnedViewExpression(texts: PinnedTexts): string {
  return `(() => {${PRELUDE}
    const { roomName, unpinBody, keepBody } = ${JSON.stringify(texts)};
    const box = (e) => { if (!e || e.getClientRects().length === 0) return null;
      const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const label = (text) => text.includes(unpinBody) ? 'unpin' : text.includes(keepBody) ? 'keep' : 'other';
    const headers = [...document.querySelectorAll('trn-page-header header')];
    const panels = [...document.querySelectorAll('[data-testid="pinned-panel"]')];
    const panel = panels[0] ?? null;
    const host = panel?.closest('trn-pinned-messages-panel') ?? panel;
    const text = panel?.textContent ?? '';
    const bars = panel ? [...panel.querySelectorAll('.panel-header')] : [];
    const titles = panel ? [...panel.querySelectorAll('.panel-header h2')] : [];
    const items = [...document.querySelectorAll('[data-testid="pinned-item"]')];
    const rows = [...document.querySelectorAll('.pin-item')].map((row) => {
      const controls = [...row.querySelectorAll('[data-testid="pinned-unpin"]')];
      const u = controls[0] ?? null, b = box(u);
      const hit = b ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
      return { label: label(row.textContent ?? ''), box: box(row), unpinCount: controls.length,
        unpin: b, unobstructed: !!(u && hit && u.contains(hit)) };
    });
    const open = [...document.querySelectorAll('[data-testid="open-pinned"]')];
    return {
      roomHeader: { count: headers.length, first: box(headers[0]),
        namesRoom: (headers[0]?.querySelector('h1')?.textContent ?? '').includes(roomName) },
      panel: { count: panels.length, visible: !!panel && visible(panel), box: box(panel),
        containsKeep: text.includes(keepBody), containsUnpin: text.includes(unpinBody),
        animating: !!host && host.getAnimations({ subtree: true }).some((a) => a.playState === 'running') },
      panelHeader: { count: bars.length, box: box(bars[0]) },
      panelTitle: { count: titles.length, box: box(titles[0]) },
      items: { count: items.length, order: items.map((e) => label(e.textContent ?? '')) },
      rows,
      openPinned: { count: open.length, box: box(open[0]) },
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

export async function readPinnedView(
  client: AccountWorkspaceClient, texts: PinnedTexts, options: ObservationOptions<PinnedView> = {},
): Promise<PinnedView> {
  return observe(client, pinnedViewExpression(texts), parsePinnedView, 'pinned panel view observation', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}
