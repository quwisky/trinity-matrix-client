import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import type { ObservationOptions } from './message-quote-observer.mts';

/*
 * Read-only renderer observations for the installed-Android who-reacted suite.
 * Each builder returns one pure expression: it reads the DOM, computed style,
 * geometry, scroll offsets and the route only. No click, focus, key, scroll,
 * class, style, text or location write, and no handler call. Window values are
 * reached through `document.defaultView`, so the guard runs the same text in jsdom.
 * Identifiers and names enter only as in-page comparison values; none is returned.
 */

const OBSERVATION_TIMEOUT_MS = 15_000;

export interface ReactionRowObservation {
  readonly rows: number;
  readonly exactEvent: boolean;
  readonly pills: number;
  readonly thumbsPills: number;
  readonly thumbsCount: string | null;
  readonly summaryMatches: boolean;
  readonly summaryOthers: number | null;
  readonly who: number;
  readonly whoUnobstructed: boolean;
  readonly composers: number;
  readonly composerVisible: boolean;
}

export interface ReactionDialogObservation {
  readonly dialogs: number;
  readonly sheetHost: boolean;
  readonly box: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } | null;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly total: string | null;
  readonly closeVisible: boolean;
  readonly keys: number;
  readonly pressedKeys: readonly string[];
  readonly lastKey: { readonly key: string | null; readonly pressed: boolean; readonly unobstructed: boolean };
  readonly reactors: number;
  readonly listContainsLong: boolean;
  readonly longName: { readonly found: boolean; readonly textOverflow: string | null; readonly overflow: number | null };
  readonly detailOverflow: number | null;
  readonly directory: {
    readonly scrollWidth: number; readonly clientWidth: number; readonly scrollLeft: number;
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  } | null;
  readonly background: string | null;
  readonly composers: number;
  readonly composerVisible: boolean;
}

export interface ShellRouteObservation {
  readonly path: string;
  /** The `account` query value, compared in Node and never recorded. */
  readonly account: string | null;
  readonly settingsHosts: number;
  readonly sectionsVisible: boolean;
  readonly dark: boolean;
  readonly backToRoomsVisible: boolean;
  readonly composers: number;
  readonly composerVisible: boolean;
}

const HELPERS = `
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    const shown = (element) => {
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const style = view.getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility === 'visible' && style.display !== 'none';
    };
    const unobstructed = (element) => {
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return !!hit && element.contains(hit);
    };
    const composers = [...document.querySelectorAll('[data-testid="composer-input"]')];`;

export function reactionRowExpression(body: string, eventId: string): string {
  return `(() => {${HELPERS}
    const { body, eventId } = ${JSON.stringify({ body, eventId })};
    const rows = [...document.querySelectorAll('.scroll .msg[data-mid^="$"]')]
      .filter((row) => (row.textContent ?? '').includes(body));
    const row = rows.length === 1 ? rows[0] : null;
    const pills = row ? [...row.querySelectorAll('.reaction:not(.reaction--who)')] : [];
    const thumbs = pills.filter((pill) => pill.querySelector('.reaction__key')?.textContent?.trim() === '👍');
    const label = thumbs.length === 1 ? thumbs[0].getAttribute('aria-label') ?? '' : '';
    const others = /^👍 reacted by You, .* and (\\d+) others$/u.exec(label);
    const who = row ? [...row.querySelectorAll('[data-testid="reactions-who"]')] : [];
    return {
      rows: rows.length,
      exactEvent: !!row && row.getAttribute('data-mid') === eventId,
      pills: pills.length,
      thumbsPills: thumbs.length,
      thumbsCount: thumbs.length === 1 ? thumbs[0].querySelector('.reaction__count')?.textContent?.trim() ?? null : null,
      summaryMatches: others !== null,
      summaryOthers: others ? Number(others[1]) : null,
      who: who.length,
      whoUnobstructed: who.length === 1 && unobstructed(who[0]),
      composers: composers.length,
      composerVisible: composers.length === 1 && shown(composers[0]),
    };
  })()`;
}

export function reactionDialogExpression(longName: string): string {
  return `(() => {${HELPERS}
    const longName = ${JSON.stringify(longName)};
    const dialogs = [...document.querySelectorAll('[data-testid="reactions-dialog"]')].filter(shown);
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    const host = dialog ? dialog.closest('trn-reactions-dialog') : null;
    const box = dialog ? dialog.getBoundingClientRect() : null;
    const keys = dialog ? [...dialog.querySelectorAll('[data-testid="reactions-key"]')] : [];
    const keyOf = (key) => (key.getAttribute('aria-label') ?? '').split(',')[0] || null;
    const last = keys.at(-1) ?? null;
    const names = dialog ? [...dialog.querySelectorAll('.reactor__name')] : [];
    const long = names.find((name) => (name.textContent ?? '').trim() === longName) ?? null;
    const list = dialog ? dialog.querySelector('[data-testid="reactors-list"]') : null;
    const detail = dialog ? dialog.querySelector('.reactions-dialog__detail') : null;
    const directory = document.querySelector('[data-testid="reactions-directory"]');
    const close = document.querySelector('[data-testid="close-reactions"]');
    const rect = directory ? directory.getBoundingClientRect() : null;
    return {
      dialogs: dialogs.length,
      sheetHost: !!host && host.classList.contains('reactions-dialog--sheet'),
      box: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null,
      innerWidth: view.innerWidth,
      innerHeight: view.innerHeight,
      total: dialog ? dialog.querySelector('.reactions-dialog__total')?.textContent?.trim() ?? null : null,
      closeVisible: shown(close),
      keys: keys.length,
      pressedKeys: keys.filter((key) => key.getAttribute('aria-pressed') === 'true').map(keyOf),
      lastKey: { key: last ? keyOf(last) : null, pressed: last?.getAttribute('aria-pressed') === 'true', unobstructed: unobstructed(last) },
      reactors: dialog ? dialog.querySelectorAll('.reactor').length : 0,
      listContainsLong: !!list && (list.textContent ?? '').includes(longName),
      longName: {
        found: !!long,
        textOverflow: long ? view.getComputedStyle(long).textOverflow : null,
        overflow: long ? long.scrollWidth - long.clientWidth : null,
      },
      detailOverflow: detail ? detail.scrollHeight - detail.clientHeight : null,
      directory: directory && rect ? {
        scrollWidth: directory.scrollWidth, clientWidth: directory.clientWidth, scrollLeft: directory.scrollLeft,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      } : null,
      background: dialog ? view.getComputedStyle(dialog).backgroundColor : null,
      composers: composers.length,
      composerVisible: composers.length === 1 && shown(composers[0]),
    };
  })()`;
}

export function shellRouteExpression(): string {
  return `(() => {${HELPERS}
    const url = new URL(view.location.href);
    const back = document.querySelector('[data-testid="back-to-rooms"]');
    return {
      path: url.pathname,
      account: url.searchParams.get('account'),
      settingsHosts: document.querySelectorAll('trn-settings').length,
      sectionsVisible: shown(document.querySelector('nav[aria-label="Settings sections"]')),
      dark: document.documentElement.classList.contains('dark'),
      backToRoomsVisible: shown(back),
      composers: composers.length,
      composerVisible: composers.length === 1 && shown(composers[0]),
    };
  })()`;
}

async function observe<T>(client: AccountWorkspaceClient, expression: string, description: string,
  options: ObservationOptions<T>): Promise<T> {
  return waitForNativeShellState(
    async () => (await evaluateNative(client.webview, expression)) as T,
    options.accepts ?? (() => true),
    options.description ?? description,
    client.signal,
    options.timeoutMs ?? OBSERVATION_TIMEOUT_MS,
  );
}

export const readReactionRow = (client: AccountWorkspaceClient, body: string, eventId: string,
  options: ObservationOptions<ReactionRowObservation> = {}): Promise<ReactionRowObservation> =>
  observe(client, reactionRowExpression(body, eventId), 'who-reacted target row', options);
export const readReactionDialog = (client: AccountWorkspaceClient, longName: string,
  options: ObservationOptions<ReactionDialogObservation> = {}): Promise<ReactionDialogObservation> =>
  observe(client, reactionDialogExpression(longName), 'who-reacted dialog', options);
export const readShellRoute = (client: AccountWorkspaceClient,
  options: ObservationOptions<ShellRouteObservation> = {}): Promise<ShellRouteObservation> =>
  observe(client, shellRouteExpression(), 'who-reacted shell route', options);
