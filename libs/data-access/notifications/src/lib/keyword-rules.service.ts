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
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/**
 * A keyword the user typed that cannot be stored, with a message written for them.
 *
 * Distinct from a network or server failure so the UI knows which errors are worth
 * repeating verbatim: "a keyword cannot contain *" helps, and the raw text of a 429 does
 * not.
 */
export class KeywordValidationError extends Error {}

/** A word the account notifies on, as it currently stands on the server. */
export interface KeywordRule {
  /**
   * The id every write addresses. Usually identical to {@link pattern} — Element keys
   * keyword rules by the word — but the spec permits any id, so the two are kept apart
   * rather than assumed equal. Addressing a rule by its pattern 404s whenever they differ.
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
 * A rule id the homeserver defines, not the user. The spec reserves a leading dot for
 * server-defined rules, and one of them — `.m.rule.contains_user_name` — lives in the very
 * `content` bucket the user's keywords do. Listing it would show someone their own username
 * as a keyword they could delete.
 */
function isServerRule(ruleId: string): boolean {
  return ruleId.startsWith('.');
}

/**
 * Glob metacharacters, which a content rule's `pattern` honours.
 *
 * The field asks for a word, so a `*` typed into it would silently become "notify on every
 * message in every room" — stored on the account, so on every device and in every other
 * client, with nothing to say where it came from. Rejected rather than escaped: escaping
 * would store something other than what was typed, and escape support across homeservers
 * is not worth betting a runaway notification rule on.
 */
const GLOB_CHARACTERS = /[*?]/;

/** The tone a keyword plays unless another client chose a different one. */
const DEFAULT_SOUND = 'default';

/**
 * Characters that cannot appear in a keyword because the keyword IS the rule id.
 *
 * A leading dot is the sharp one: {@link isServerRule} filters those out of the list, so a
 * keyword like `.net` would be created, would notify, and would be invisible and
 * unremovable in the UI — worse than refusing it. A slash breaks the id's own path segment
 * on the way to the server.
 */
function unusableAsRuleId(pattern: string): boolean {
  return pattern.startsWith('.') || pattern.includes('/');
}

/**
 * Actions for a keyword match: always notify + highlight, optionally with a sound.
 *
 * `soundValue` carries forward whatever sound another client chose, so toggling Sound off
 * and back on does not quietly downgrade a custom tone to the default. The rest of the
 * action list is regenerated rather than merged: an unknown action carried forward blindly
 * could be a `dont_notify`, which would turn the keyword off while looking like it works.
 */
function actionsFor(
  sound: boolean,
  soundValue = DEFAULT_SOUND,
): PushRuleAction[] {
  const actions: PushRuleAction[] = [PushRuleActionName.Notify];
  if (sound) {
    actions.push({ set_tweak: TweakName.Sound, value: soundValue });
  }
  // Highlight regardless: it is what colours the room in the list, and a keyword that
  // notifies without marking where it matched is a notification you cannot act on.
  actions.push({ set_tweak: TweakName.Highlight });
  return actions;
}

/**
 * The sound a rule plays, or undefined when it plays none.
 *
 * Null-safe, because `typeof null` is `'object'` — a single null in the actions array
 * would otherwise throw inside a read the settings page cannot afford to lose.
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
 * The account's **keyword** push rules — content rules that notify when a message body
 * contains a particular word.
 *
 * A sibling to {@link PushRulesService}, which owns the predefined toggles, and to
 * {@link RoomNotificationsService}, which owns per-room overrides. This one is the only
 * push-rule surface where the user supplies the rule itself, which is what makes it a
 * separate service rather than more toggles: the set is unbounded, and every operation is
 * a create/delete rather than a flip.
 *
 * **Keywords are addressed by rule id, displayed by pattern.** Element keys a keyword rule
 * by the word itself, and {@link add} matches that so a list round-trips between clients
 * rather than each accumulating duplicates — but a rule written elsewhere may use any id,
 * and one addressed by the wrong string simply 404s.
 *
 * **Precedence is deliberate and worth knowing.** Content rules are evaluated *below*
 * overrides, so a room muted through {@link RoomNotificationsService} stays muted even when
 * a keyword matches there. Users coming from apps where a keyword pierces a mute expect the
 * opposite, so the settings copy says it.
 *
 * Reads are synchronous snapshots off the synced client's cached `pushRules`, exactly as
 * {@link PushRulesService} reads its toggles; {@link hasLoaded} separates "no keywords"
 * from "not synced yet", which look identical and only one of which is a fact.
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
   * Tolerates a malformed rule rather than throwing: this is user data that has been
   * round-tripped through a server and possibly another client, and it is read from inside
   * a computed where a throw would blank the settings page.
   */
  keywords(accountId?: string): KeywordRule[] {
    const content = this.clientOwning(accountId)?.pushRules?.global?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const keywords: KeywordRule[] = [];
    for (const rule of content) {
      const ruleId = typeof rule?.rule_id === 'string' ? rule.rule_id : '';
      // A rule whose id we cannot address is one we must not offer to remove.
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
   * The existing keyword matching `pattern`, if any. Matching is case-insensitive because
   * the server's own content matching is — `OnCall` and `oncall` notify on the same
   * messages, so treating them as two keywords would mean two notifications for one word.
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
   * Writes against the EXISTING rule's id when one matches, rather than against the new
   * spelling: adding `oncall` where `OnCall` is already stored must replace it, since both
   * match the same messages and two rules would mean two notifications for one word.
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
          // Only when it needs it: a rule the server just created is already enabled, and
          // the extra round trip is what tips a burst of adds into the rate limiter.
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
   * The client owning these rules: the named account's, else the active one — the shape
   * {@link RoomNotificationsService} uses, so a second signed-in account's keywords are
   * reachable rather than silently those of whichever account happens to be active.
   */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  /**
   * Run a write, then re-read the rules so the next {@link keywords} call is accurate at
   * once — the same contract {@link RoomNotificationsService} keeps. Without it the list
   * would not change until the `m.push_rules` account-data echo arrived on sync, and the
   * row the user just added would appear to vanish.
   *
   * `getPushRules()` assigns `client.pushRules` itself, so the call is made for that
   * effect rather than for its return value.
   */
  private async write(
    client: MatrixClient,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    await operation();
    // The write has already landed, so a failed refresh must not be reported as a failed
    // write: doing so had the UI insisting a removal failed while the rule was gone, and
    // every retry then 404ing. The list is merely stale until the next sync echo.
    await client.getPushRules().catch(() => undefined);
  }
}
