import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseAppliedProfile,
  parseComposer,
  parseReceiptsView,
  type AppliedProfileObservation,
  type ComposerObservation,
  type ReceiptsViewObservation,
} from './message-receipts-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android read-receipt suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, measured
 * layout boxes, computed style and the location only: no click, focus, key,
 * scroll, class, style, attribute or location write, and no handler is
 * invoked. Window-level values are reached through `document.defaultView`, so
 * a guard can execute the same text in jsdom with only `document` in scope.
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
      const box = element.getBoundingClientRect();
      return {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height,
      };
    };`;

export function composerExpression(): string {
  return `(() => {${PRELUDE}
    const inputs = [...document.querySelectorAll('[data-testid="composer-input"]')];
    const input = inputs.length === 1 ? inputs[0] : null;
    return {
      count: inputs.length,
      visible: !!input && visible(input),
      placeholder: input ? input.getAttribute('placeholder') : null,
      href: view.location.href,
    };
  })()`;
}

/**
 * The timeline rows and the predecessor's first `.scroll` receipt cluster with
 * its owning row's first message text, both as measured renderer boxes.
 */
export function receiptsExpression(): string {
  return `(() => {${PRELUDE}
    const CLUSTER = '[data-testid="read-receipts"]';
    const rows = [...document.querySelectorAll('.scroll .msg[data-mid]')];
    const cluster = document.querySelector('.scroll ' + CLUSTER);
    let first = null;
    if (cluster) {
      const row = cluster.closest('.msg');
      const text = row ? row.querySelector('.msg__text') : null;
      first = {
        rowId: row ? row.getAttribute('data-mid') : null,
        firstInRow: !!row && row.querySelector(CLUSTER) === cluster,
        firstInDocument: document.querySelector(CLUSTER) === cluster,
        tag: cluster.tagName,
        visible: visible(cluster),
        label: cluster.getAttribute('aria-label'),
        avatars: cluster.querySelectorAll('.msg__receipt').length,
        box: measure(cluster),
        text: text ? { content: text.textContent ?? '', box: measure(text) } : null,
      };
    }
    return {
      rows: rows.map((row) => ({
        id: row.getAttribute('data-mid') ?? '',
        event: row.classList.contains('msg--event'),
        visible: visible(row),
        texts: [...row.querySelectorAll('.msg__text')].map((text) => text.textContent ?? ''),
        clusters: row.querySelectorAll(CLUSTER).length,
      })),
      clusters: document.querySelectorAll('.scroll ' + CLUSTER).length,
      first,
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

export async function readComposer(
  client: AccountWorkspaceClient,
  options: ObservationOptions<ComposerObservation> = {},
): Promise<ComposerObservation> {
  return observe(client, composerExpression(), parseComposer,
    'composer observation', options);
}

export async function readReceipts(
  client: AccountWorkspaceClient,
  options: ObservationOptions<ReceiptsViewObservation> = {},
): Promise<ReceiptsViewObservation> {
  return observe(client, receiptsExpression(), parseReceiptsView,
    'read-receipt cluster observation', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}
