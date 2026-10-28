import { Injectable, inject } from '@angular/core';
import {
  Observable,
  concat,
  concatMap,
  defer,
  last,
  map,
  of,
  throwError,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { type EngineResult, unwrapEngineResult } from '@trinity/util/matrix';
import type { KeywordRule } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationSettingsStore } from './notification-settings.store';

/**
 * A keyword the user typed that cannot be stored, with a message written for them.
 * Distinct from network or server failures so the UI can show it verbatim.
 */
export class KeywordValidationError extends Error {}

/**
 * Glob metacharacters, which a content rule's `pattern` honours.
 *
 * A `*` typed into the keyword field would become "notify on every message in every room"
 * on every device and client. Rejected rather than escaped: escaping would store something
 * other than what was typed, and escape support across homeservers is not worth betting a
 * runaway notification rule on.
 */
const GLOB_CHARACTERS = /[*?]/;

/**
 * Characters that cannot appear in a keyword because the keyword IS the rule id.
 *
 * A leading dot marks a server-defined rule, which the keyword list leaves out, so `.net`
 * would notify yet be invisible and unremovable in the UI. A slash breaks the id's path segment.
 */
function unusableAsRuleId(pattern: string): boolean {
  return pattern.startsWith('.') || pattern.includes('/');
}

/**
 * The account's **keyword** push rules: content rules that notify when a message body
 * contains a word. Separate from {@link PushRulesService} (predefined toggles) and
 * {@link RoomNotificationsService} (per-room overrides) because the user supplies the rule
 * and every operation is a create/delete.
 *
 * **Keywords are keyed by the word** (matrix-rust-sdk semantics): one entry per word, no
 * sound of its own, and removing a word deletes every rule for it, whatever its id.
 *
 * **Precedence:** content rules are evaluated below overrides, so a room muted through
 * {@link RoomNotificationsService} stays muted even when a keyword matches there. The
 * settings copy says so.
 *
 * Reads are synchronous snapshots of the {@link NotificationSettingsStore};
 * {@link hasLoaded} separates "no keywords" from "not synced yet". A command replies once
 * those reads hold its effect.
 */
@Injectable({ providedIn: 'root' })
export class KeywordRulesService {
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly store = inject(NotificationSettingsStore);
  private readonly session = inject(SessionStateService);

  /** Whether the account's push rules have synced, so an empty list means something. */
  hasLoaded(accountId?: string): boolean {
    const id = this.accountOrActive(accountId);
    return !!id && this.store.settings(id).loaded;
  }

  /** The account's keywords, one per word, in the order the server holds them. */
  keywords(accountId?: string): readonly KeywordRule[] {
    const id = this.accountOrActive(accountId);
    return id ? this.store.settings(id).keywords : [];
  }

  /**
   * The existing keyword matching `pattern`, if any. Case-insensitive because the server's
   * content matching is: `OnCall` and `oncall` would otherwise notify twice.
   */
  find(pattern: string, accountId?: string): KeywordRule | undefined {
    const normalised = pattern.trim().toLowerCase();
    return this.keywords(accountId).find(
      (keyword) => keyword.pattern.toLowerCase() === normalised,
    );
  }

  /**
   * Add a keyword, or re-point and re-enable one that already exists.
   *
   * Adding `oncall` where `OnCall` is stored replaces it rather than adding a second rule
   * for the same word: the typed spelling is set, then the other spellings are removed.
   */
  add(pattern: string, accountId?: string): Observable<void> {
    const trimmed = pattern.trim();
    return defer(() => {
      if (!trimmed) {
        return throwError(
          () =>
            new KeywordValidationError('Enter a word to be notified about.'),
        );
      }
      if (GLOB_CHARACTERS.test(trimmed)) {
        return throwError(
          () =>
            new KeywordValidationError('A keyword cannot contain “*” or “?”.'),
        );
      }
      if (unusableAsRuleId(trimmed)) {
        return throwError(
          () =>
            new KeywordValidationError(
              'A keyword cannot start with “.” or contain “/”.',
            ),
        );
      }
      const id = this.accountOrActive(accountId);
      if (!id) {
        return throwError(() => new Error('Not signed in.'));
      }
      const normalised = trimmed.toLowerCase();
      // Add first: a failure after it leaves a harmless duplicate, never a lost keyword.
      return this.engine.setKeyword(id, trimmed).pipe(
        unwrapEngineResult(),
        concatMap(() => {
          const stored = this.keywords(id).map((keyword) => keyword.pattern);
          // A stale snapshot (failed re-read) may list the rule just written under its old
          // pattern, and removing that pattern would delete it: leave the duplicate instead.
          const respelled = stored.includes(trimmed)
            ? stored.filter(
                (p) => p !== trimmed && p.toLowerCase() === normalised,
              )
            : [];
          return concat(
            of(null),
            ...respelled.map((p) =>
              defer(() => this.engine.removeKeyword(id, p)).pipe(
                unwrapEngineResult(),
              ),
            ),
          );
        }),
        last(),
        map(() => undefined),
      );
    });
  }

  /** Remove a keyword: every rule for the word. */
  remove(pattern: string, accountId?: string): Observable<void> {
    return defer(() => {
      const id = this.accountOrActive(accountId);
      if (!id) {
        return throwError(() => new Error('Not signed in.'));
      }
      return this.done(this.engine.removeKeyword(id, pattern));
    });
  }

  /**
   * The named account, else the active one, as in {@link RoomNotificationsService}, so a
   * non-active account's keywords are reachable.
   */
  private accountOrActive(accountId?: string): string | null {
    return accountId ?? this.session.activeAccountId();
  }

  private done(command: Observable<EngineResult<null>>): Observable<void> {
    return command.pipe(
      unwrapEngineResult(),
      map(() => undefined),
    );
  }
}
