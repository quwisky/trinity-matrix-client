import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseAppliedProfile,
  parseComposer,
  parseTimeline,
  type AppliedProfileObservation,
  type ComposerObservation,
  type TimelineObservation,
} from './message-markdown-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android Markdown suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, computed
 * style (including the generated `::after` caption) and the location only: no
 * click, focus, key, scroll, class, style, attribute or location write, and no
 * handler is invoked. Window-level values are reached through
 * `document.defaultView`, so a guard can execute the same text in jsdom with
 * only `document` in scope.
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
    const norm = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();`;

export function composerExpression(): string {
  return `(() => {${PRELUDE}
    const inputs = [...document.querySelectorAll('[data-testid="composer-input"]')];
    const sends = [...document.querySelectorAll('[data-testid="composer-send"]')];
    const input = inputs.length === 1 ? inputs[0] : null;
    const field = input && 'value' in input ? input : null;
    const send = sends.length === 1 ? sends[0] : null;
    return {
      count: inputs.length,
      visible: !!input && visible(input),
      focused: !!input && document.activeElement === input,
      value: field ? field.value : null,
      placeholder: input ? input.getAttribute('placeholder') : null,
      selectionStart: field ? field.selectionStart : null,
      selectionEnd: field ? field.selectionEnd : null,
      sendCount: sends.length,
      sendDisabled: send ? send.matches(':disabled') : null,
      href: view.location.href,
    };
  })()`;
}

export function timelineExpression(): string {
  return `(() => {${PRELUDE}
    const rows = [...document.querySelectorAll('.scroll .msg[data-mid]')];
    const code = (pre) => {
      const caption = view.getComputedStyle(pre, '::after');
      return {
        visible: visible(pre),
        language: pre.getAttribute('language'),
        caption: caption ? caption.content : null,
        captionOpacity: caption ? caption.opacity : null,
        captionDisplay: caption ? caption.display : null,
        text: pre.textContent ?? '',
      };
    };
    const text = (element) => ({
      html: element.classList.contains('msg__text--html'),
      text: element.textContent ?? '',
      normalized: norm(element.textContent),
      visible: visible(element),
      whiteSpace: view.getComputedStyle(element).whiteSpace,
      strong: [...element.querySelectorAll('strong')].map((node) => node.textContent ?? ''),
      breaks: element.querySelectorAll('br').length,
      items: [...element.querySelectorAll('li')].map((node) => norm(node.textContent)),
      inputs: element.querySelectorAll('input').length,
      checkboxes: element.querySelectorAll('[role="checkbox"], [type="checkbox"]').length,
      pres: [...element.querySelectorAll('pre')].map(code),
    });
    return {
      hoverNone: typeof view.matchMedia === 'function'
        ? view.matchMedia('(hover: none)').matches : null,
      toolbarCount: document.querySelectorAll('.scroll .msg__toolbar').length,
      rows: rows.map((row) => ({
        id: row.getAttribute('data-mid') ?? '',
        event: row.classList.contains('msg--event'),
        continuation: row.classList.contains('msg--cont'),
        visible: visible(row),
        text: row.textContent ?? '',
        toolbarCount: row.querySelectorAll('.msg__toolbar').length,
        texts: [...row.querySelectorAll('.msg__text')].map(text),
      })),
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

export async function readTimeline(
  client: AccountWorkspaceClient,
  options: ObservationOptions<TimelineObservation> = {},
): Promise<TimelineObservation> {
  return observe(client, timelineExpression(), parseTimeline,
    'Markdown timeline observation', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}
