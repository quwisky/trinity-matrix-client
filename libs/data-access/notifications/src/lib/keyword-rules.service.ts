import { Injectable, inject } from '@angular/core';
import {
  PushRuleActionName,
  PushRuleKind,
  TweakName,
  type IPushRule,
  type MatrixClient,
  type PushRuleAction,
} from 'matrix-js-sdk';
import { Observable, defer, from, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * A keyword the user typed that cannot be stored, with a message written for them.
 * Distinct from network or server failures so the UI can show it verbatim.
 */
export class KeywordValidationError extends Error {}

/** A word the account notifies on, as it currently stands on the server. */
export interface KeywordRule {
  /**
   * The id every write addresses. Usually equal to {@link pattern} (Element keys keyword
   * rules by the word), but the spec permits any id; addressing by pattern 404s when they
   * differ.
   */
  readonly ruleId: string;
  /** The word that matches, and what the list displays. */
  readonly pattern: string;
  /** False for a keyword some client has switched off without deleting. */
  readonly enabled: boolean;
  /** Whether a match plays a sound, as opposed to only badging the room. */
  readonly sound: boolean;
  /** The sound another client chose, carried forward so a toggle cannot downgrade it. */
  readonly soundValue: string;
}

/**
 * A rule id the homeserver defines. The spec reserves a leading dot for server-defined
 * rules, and `.m.rule.contains_user_name` lives in the same `content` bucket as the user's
 * keywords; listing it would offer the username as a deletable keyword.
 */
function isServerRule(ruleId: string): boolean {
  return ruleId.startsWith('.');
}

/**
 * Glob metacharacters, which a content rule's `pattern` honours.
 *
 * A `*` typed into the keyword field would become "notify on every message in every room"
 * on every device and client. Rejected rather than escaped: escaping would store something
 * other than what was typed, and escape support across homeservers is not worth betting a
 * runaway notification rule on.
 */
const GLOB_CHARACTERS = /[*?]/;

/** The tone a keyword plays unless another client chose a different one. */
const DEFAULT_SOUND = 'default';

/**
 * Characters that cannot appear in a keyword because the keyword IS the rule id.
 *
 * A leading dot is filtered out by {@link isServerRule}, so `.net` would notify yet be
 * invisible and unremovable in the UI. A slash breaks the id's path segment.
 */
function unusableAsRuleId(pattern: string): boolean {
  return pattern.startsWith('.') || pattern.includes('/');
}

/**
 * Actions for a keyword match: always notify + highlight, optionally with a sound.
 *
 * `soundValue` carries another client's chosen sound forward. The rest of the action list
 * is regenerated rather than merged: a blindly carried unknown action could be a
 * `dont_notify`, which would silently turn the keyword off.
 */
function actionsFor(
  sound: boolean,
  soundValue = DEFAULT_SOUND,
): PushRuleAction[] {
  const actions: PushRuleAction[] = [PushRuleActionName.Notify];
  if (sound) {
    actions.push({ set_tweak: TweakName.Sound, value: soundValue });
  }
  // Highlight regardless: it is what colours the room in the list.
  actions.push({ set_tweak: TweakName.Highlight });
  return actions;
}

/**
 * The sound a rule plays, or undefined when it plays none.
 *
 * Null-safe, because `typeof null` is `'object'` and a throw here would break the settings
 * read.
 */
function soundValueOf(rule: IPushRule): string | undefined {
  for (const action of rule.actions) {
    if (
      !!action &&
      typeof action === 'object' &&
      action.set_tweak === TweakName.Sound
    ) {
      const value: unknown = action.value;
      return typeof value === 'string' ? value : DEFAULT_SOUND;
    }
  }
  return undefined;
}

/**
 * The account's **keyword** push rules: content rules that notify when a message body
 * contains a word. Separate from {@link PushRulesService} (predefined toggles) and
 * {@link RoomNotificationsService} (per-room overrides) because the user supplies the rule
 * and every operation is a create/delete.
 *
 * **Keywords are addressed by rule id, displayed by pattern.** {@link add} keys the rule by
 * the word, as Element does, but a rule written elsewhere may use any id and one addressed
 * by the wrong string 404s.
 *
 * **Precedence:** content rules are evaluated below overrides, so a room muted through
 * {@link RoomNotificationsService} stays muted even when a keyword matches there. The
 * settings copy says so.
 *
 * Reads are synchronous snapshots of the cached `pushRules`; {@link hasLoaded} separates
 * "no keywords" from "not synced yet".
 */
@Injectable({ providedIn: 'root' })
export class KeywordRulesService {
  private readonly matrix = inject(MatrixClientService);

  /** Whether the account's push rules have synced, so an empty list means something. */
  hasLoaded(accountId?: string): boolean {
    return !!this.clientOwning(accountId)?.pushRules?.global;
  }

  /**
   * The account's keywords, in the order the server holds them.
   *
   * Tolerates malformed rules (data from the server or another client): it is read inside a
   * computed, where a throw would blank the settings page.
   */
  keywords(accountId?: string): KeywordRule[] {
    const content = this.clientOwning(accountId)?.pushRules?.global?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const keywords: KeywordRule[] = [];
    for (const rule of content) {
      const ruleId = typeof rule?.rule_id === 'string' ? rule.rule_id : '';
      // A rule whose id we cannot address must not be offered for removal.
      if (!ruleId || isServerRule(ruleId) || !Array.isArray(rule.actions)) {
        continue;
      }
      keywords.push({
        ruleId,
        pattern: typeof rule.pattern === 'string' ? rule.pattern : ruleId,
        enabled: rule.enabled !== false,
        sound: soundValueOf(rule) !== undefined,
        soundValue: soundValueOf(rule) ?? DEFAULT_SOUND,
      });
    }
    return keywords;
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
   * Writes against the EXISTING rule's id when one matches: adding `oncall` where `OnCall`
   * is stored must replace it, not add a second rule.
   */
  add(pattern: string, sound = true, accountId?: string): Observable<void> {
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
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const existing = this.find(trimmed, accountId);
      const ruleId = existing?.ruleId ?? trimmed;
      return from(
        this.write(client, async () => {
          await client.addPushRule(
            'global',
            PushRuleKind.ContentSpecific,
            ruleId,
            {
              actions: actionsFor(sound, existing?.soundValue),
              pattern: trimmed,
            },
          );
          // Only when needed: a new rule is already enabled, and the extra round trip
          // tips a burst of adds into the rate limiter.
          if (existing && !existing.enabled) {
            await client.setPushRuleEnabled(
              'global',
              PushRuleKind.ContentSpecific,
              ruleId,
              true,
            );
          }
        }),
      );
    });
  }

  /** Remove a keyword, addressed by its rule id. */
  remove(ruleId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.write(client, () =>
          client.deletePushRule('global', PushRuleKind.ContentSpecific, ruleId),
        ),
      );
    });
  }

  /** Turn a keyword's sound on or off, leaving the keyword itself alone. */
  setSound(
    ruleId: string,
    sound: boolean,
    accountId?: string,
  ): Observable<void> {
    return defer(() => {
      const existing = this.keywords(accountId).find(
        (keyword) => keyword.ruleId === ruleId,
      );
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.write(client, () =>
          client.setPushRuleActions(
            'global',
            PushRuleKind.ContentSpecific,
            ruleId,
            actionsFor(sound, existing?.soundValue),
          ),
        ),
      );
    });
  }

  /**
   * The named account's client, else the active one, as in {@link RoomNotificationsService},
   * so a non-active account's keywords are reachable.
   */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  /**
   * Run a write, then re-read the rules so the next {@link keywords} call is accurate
   * before the `m.push_rules` account-data echo arrives on sync. `getPushRules()` assigns
   * `client.pushRules` itself, so it is called for that effect.
   */
  private async write(
    client: MatrixClient,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    await operation();
    // The write has already landed, so a failed refresh must not be reported as a failed
    // write (a retry would 404). The list is merely stale until the next sync echo.
    await client.getPushRules().catch(() => undefined);
  }
}
