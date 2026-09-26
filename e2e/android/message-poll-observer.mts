import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  parseAppliedProfile,
  parseComposer,
  parsePollDialog,
  parseTimeline,
  type AppliedProfileObservation,
  type ComposerObservation,
  type PollDialogObservation,
  type TimelineObservation,
} from './message-poll-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android poll suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, computed
 * style and the location only: no click, focus, key, scroll, class, style,
 * attribute or location write, and no handler is invoked. Window-level values
 * are reached through `document.defaultView`, so a guard can execute the same
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
    const norm = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();`;

export function composerExpression(): string {
  return `(() => {${PRELUDE}
    const inputs = [...document.querySelectorAll('[data-testid="composer-input"]')];
    const inserts = [...document.querySelectorAll('[data-testid="composer-insert"]')];
    const input = inputs.length === 1 ? inputs[0] : null;
    const insert = inserts.length === 1 ? inserts[0] : null;
    return {
      count: inputs.length,
      visible: !!input && visible(input),
      placeholder: input ? input.getAttribute('placeholder') : null,
      href: view.location.href,
      insertCount: inserts.length,
      insertVisible: !!insert && visible(insert),
      insertDisabled: insert ? insert.matches(':disabled') : null,
      insertHasPopup: insert ? insert.getAttribute('aria-haspopup') : null,
      insertExpanded: insert ? insert.getAttribute('aria-expanded') : null,
      inlinePollCount: document.querySelectorAll('[data-testid="composer-poll"]').length,
      trayPollCount: document.querySelectorAll('[data-testid="insert-poll"]').length,
    };
  })()`;
}

export function pollDialogExpression(): string {
  return `(() => {${PRELUDE}
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="Create poll"]')];
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    const questions = dialog ? [...dialog.querySelectorAll('[data-testid="poll-question"]')] : [];
    const question = questions.length === 1 ? questions[0] : null;
    const creates = dialog ? [...dialog.querySelectorAll('[data-testid="poll-create"]')] : [];
    const options = dialog
      ? [...dialog.querySelectorAll('input[data-testid^="poll-option-"]')]
      : [];
    return {
      count: dialogs.length,
      visible: !!dialog && visible(dialog),
      questionCount: questions.length,
      questionValue: question && 'value' in question ? question.value : null,
      questionFocused: !!question && document.activeElement === question,
      options: options.map((option) => option.value),
      createCount: creates.length,
      createDisabled: creates.length === 1 ? creates[0].matches(':disabled') : null,
    };
  })()`;
}

export function timelineExpression(): string {
  return `(() => {${PRELUDE}
    const polls = [...document.querySelectorAll('.scroll [data-testid="poll"]')];
    const rows = [...document.querySelectorAll('.scroll .msg[data-mid]')]
      .filter((row) => row.querySelector('[data-testid="poll"]'));
    return {
      pollCount: polls.length,
      polls: rows.map((row) => {
        const poll = row.querySelector('[data-testid="poll"]');
        const ends = [...poll.querySelectorAll('[data-testid="poll-end"]')];
        return {
          rowId: row.getAttribute('data-mid') ?? '',
          visible: visible(row) && visible(poll),
          question: norm(poll.querySelector('.poll__question')?.textContent),
          total: norm(poll.querySelector('.poll__total')?.textContent),
          text: norm(poll.textContent),
          endCount: ends.length,
          endDisabled: ends.length === 1 ? ends[0].matches(':disabled') : null,
          options: [...poll.querySelectorAll('.poll__option')].map((option) => ({
            text: norm(option.querySelector('.poll__option-text')?.textContent),
            count: norm(option.querySelector('.poll__option-count')?.textContent),
            disabled: option.matches(':disabled'),
            pressed: option.getAttribute('aria-pressed'),
          })),
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
    'composer and insert-tray observation', options);
}

export async function readPollDialog(
  client: AccountWorkspaceClient,
  options: ObservationOptions<PollDialogObservation> = {},
): Promise<PollDialogObservation> {
  return observe(client, pollDialogExpression(), parsePollDialog,
    'Create poll dialog observation', options);
}

export async function readTimeline(
  client: AccountWorkspaceClient,
  options: ObservationOptions<TimelineObservation> = {},
): Promise<TimelineObservation> {
  return observe(client, timelineExpression(), parseTimeline,
    'poll timeline observation', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}
