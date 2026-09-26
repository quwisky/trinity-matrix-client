import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseAppliedProfile,
  parseComposer,
  parseSheet,
  parseSourceDialog,
  parseTimeline,
  type AppliedProfileObservation,
  type ComposerObservation,
  type SheetObservation,
  type SourceDialogObservation,
  type TimelineObservation,
} from './message-source-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android message-source suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, computed
 * style, hit-testing and the location only: no click, focus, key, scroll,
 * class, style, attribute or location write, and no handler is invoked.
 * Window-level values are reached through `document.defaultView`, so a guard
 * can execute the same text in jsdom with only `document` in scope.
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
    return {
      rows: rows.map((row) => ({
        id: row.getAttribute('data-mid') ?? '',
        event: row.classList.contains('msg--event'),
        visible: visible(row),
        text: row.textContent ?? '',
      })),
    };
  })()`;
}

export function sheetExpression(): string {
  return `(() => {${PRELUDE}
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="Message actions"]')];
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    const control = (selector) => {
      const elements = [...document.querySelectorAll(selector)];
      return {
        count: elements.length,
        visible: elements.length === 1 && visible(elements[0]),
      };
    };
    return {
      dialogs: dialogs.length,
      dialogVisible: !!dialog && visible(dialog),
      forward: control('[data-testid="sheet-forward"]'),
      viewSource: control('[data-testid="sheet-view-source"]'),
    };
  })()`;
}

/**
 * The message-source dialog: containment, the JSON text, the measured surface
 * and conversation boxes, a read-only hit test at the surface's centre, and the
 * surface's own computed paint.
 */
export function sourceExpression(): string {
  return `(() => {${PRELUDE}
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="Message source"]')];
    const surfaces = [...document.querySelectorAll('[data-testid="message-source"]')];
    const surface = surfaces.length === 1 ? surfaces[0] : null;
    const json = surface ? [...surface.querySelectorAll('[data-testid="message-source-json"]')] : [];
    const scrollers = [...document.querySelectorAll('.scroll')];
    const box = measure(surface);
    const hit = box && typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      : null;
    const style = surface ? view.getComputedStyle(surface) : null;
    return {
      dialogs: dialogs.length,
      surfaces: surfaces.length,
      surfaceVisible: !!surface && visible(surface),
      surfaceInDialog: !!surface && dialogs.length === 1 && dialogs[0].contains(surface),
      jsonElements: json.length,
      json: json.length === 1 ? json[0].textContent : null,
      sheets: document.querySelectorAll('[role="dialog"][aria-label="Message actions"]').length,
      box,
      conversation: scrollers.length === 1 ? measure(scrollers[0]) : null,
      centerInside: !!surface && !!hit && surface.contains(hit),
      paint: style ? {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        boxShadow: style.boxShadow,
      } : null,
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
    'message-source timeline observation', options);
}

export async function readSheet(
  client: AccountWorkspaceClient,
  options: ObservationOptions<SheetObservation> = {},
): Promise<SheetObservation> {
  return observe(client, sheetExpression(), parseSheet,
    'message-action sheet observation', options);
}

export async function readSourceDialog(
  client: AccountWorkspaceClient,
  options: ObservationOptions<SourceDialogObservation> = {},
): Promise<SourceDialogObservation> {
  return observe(client, sourceExpression(), parseSourceDialog,
    'message-source dialog observation', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}
