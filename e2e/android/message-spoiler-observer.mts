import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseAppliedProfile,
  parseComposer,
  parseSpoiler,
  type AppliedProfileObservation,
  type ComposerObservation,
  type SpoilerObservation,
} from './message-spoiler-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android message-spoiler suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, computed
 * style, hit-testing, running animations and the location only: no click,
 * focus, key, scroll, class, style, attribute or location write, and no handler
 * is invoked. Window-level values are reached through `document.defaultView`,
 * so a guard can execute the same text in jsdom with only `document` in scope.
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
 * Every rendered spoiler leaf in the conversation: its row, own text, revealed
 * state, box, read-only hit tests at its centre and four inset corners, running
 * animations and its own computed text and background colour.
 */
export function spoilerExpression(): string {
  return `(() => {${PRELUDE}
    const scrollers = [...document.querySelectorAll('.scroll')];
    const leaves = [...document.querySelectorAll('.scroll .mx-spoiler')];
    const hit = (leaf, x, y) => {
      if (typeof document.elementFromPoint !== 'function') return false;
      const found = document.elementFromPoint(x, y);
      return !!found && leaf.contains(found);
    };
    return {
      scrollers: scrollers.length,
      conversation: scrollers.length === 1 ? measure(scrollers[0]) : null,
      viewport: { width: view.innerWidth, height: view.innerHeight },
      devicePixelRatio: view.devicePixelRatio,
      leaves: leaves.map((leaf) => {
        const row = leaf.closest('.msg[data-mid]');
        const box = measure(leaf);
        const style = view.getComputedStyle(leaf);
        const inset = Math.min(2, box.width / 4, box.height / 4);
        return {
          rowId: row ? row.getAttribute('data-mid') : null,
          rowEvent: !!row && row.classList.contains('msg--event'),
          rowText: row ? row.textContent ?? '' : '',
          text: leaf.textContent ?? '',
          nested: leaf.querySelectorAll('.mx-spoiler').length,
          revealed: leaf.classList.contains('is-revealed'),
          visible: visible(leaf),
          rects: leaf.getClientRects().length,
          box,
          hits: [
            hit(leaf, box.left + box.width / 2, box.top + box.height / 2),
            hit(leaf, box.left + inset, box.top + inset),
            hit(leaf, box.right - inset, box.top + inset),
            hit(leaf, box.left + inset, box.bottom - inset),
            hit(leaf, box.right - inset, box.bottom - inset),
          ],
          animations: typeof leaf.getAnimations === 'function' ? leaf.getAnimations().length : null,
          color: style.color,
          backgroundColor: style.backgroundColor,
        };
      }),
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

export async function readSpoiler(
  client: AccountWorkspaceClient,
  options: ObservationOptions<SpoilerObservation> = {},
): Promise<SpoilerObservation> {
  return observe(client, spoilerExpression(), parseSpoiler,
    'message-spoiler leaf observation', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}
