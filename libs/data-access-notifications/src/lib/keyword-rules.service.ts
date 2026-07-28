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

/** A word the account notifies on, as it currently stands on the server. */
export interface KeywordRule {
  /** The word itself. Also the rule id — see {@link KeywordRulesService}. */
  readonly pattern: string;
  /** False for a keyword some client has switched off without deleting. */
  readonly enabled: boolean;
  /** Whether a match plays a sound, as opposed to only badging the room. */
  readonly sound: boolean;
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

/** Actions for a keyword match: always notify + highlight, optionally with a sound. */
function actionsFor(sound: boolean): PushRuleAction[] {
  const actions: PushRuleAction[] = [PushRuleActionName.Notify];
  if (sound) {
    actions.push({ set_tweak: TweakName.Sound, value: 'default' });
  }
  // Highlight regardless: it is what colours the room in the list, and a keyword that
  // notifies without marking where it matched is a notification you cannot act on.
  actions.push({ set_tweak: TweakName.Highlight });
  return actions;
}

/** Whether a rule's actions ask for a sound tweak. */
function hasSound(rule: IPushRule): boolean {
  return rule.actions.some(
    (action) =>
      typeof action === 'object' && action.set_tweak === TweakName.Sound,
  );
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
 * **The rule id is the keyword.** That is what Element does, and matching it is what lets a
 * keyword list round-trip between clients instead of each one accumulating its own
 * duplicates. It also means a keyword cannot be renamed — an edit is a delete plus an add —
 * though changing whether it plays a sound is an ordinary actions write.
 *
 * **Precedence is deliberate and worth knowing.** Content rules are evaluated *below*
 * overrides, so a room muted through {@link RoomNotificationsService} stays muted even when
 * a keyword matches there. Users coming from apps where a keyword pierces a mute expect the
 * opposite, so the settings copy says it.
 */
@Injectable({ providedIn: 'root' })
export class KeywordRulesService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * The account's keywords, in the order the server holds them.
   *
   * A synchronous snapshot off the synced client's cached `pushRules`, like its sibling
   * services. Tolerates a malformed rule rather than throwing: this is user data that has
   * been round-tripped through a server and possibly another client, and it is read from
   * inside a computed where a throw would blank the settings page.
   */
  keywords(): KeywordRule[] {
    if (!this.matrix.isInitialized) {
      return [];
    }
    const content = this.matrix.instance.pushRules?.global?.content ?? [];
    const keywords: KeywordRule[] = [];
    for (const rule of content) {
      const ruleId = typeof rule?.rule_id === 'string' ? rule.rule_id : '';
      // The pattern is what matches, but the id is what a write addresses, and a rule
      // whose id we cannot address is one we must not offer to remove.
      if (!ruleId || isServerRule(ruleId) || !Array.isArray(rule.actions)) {
        continue;
      }
      keywords.push({
        pattern: typeof rule.pattern === 'string' ? rule.pattern : ruleId,
        enabled: rule.enabled !== false,
        sound: hasSound(rule),
      });
    }
    return keywords;
  }

  /** Whether `pattern` is already a keyword (matching is case-insensitive, so this is too). */
  has(pattern: string): boolean {
    const normalised = pattern.trim().toLowerCase();
    return this.keywords().some(
      (keyword) => keyword.pattern.toLowerCase() === normalised,
    );
  }

  /**
   * Add a keyword, or re-enable and re-point one that already exists.
   *
   * `addPushRule` on an existing id overwrites it, which is what makes this idempotent:
   * adding a keyword another client had disabled switches it back on rather than silently
   * doing nothing.
   */
  add(pattern: string, sound = true): Observable<void> {
    const trimmed = pattern.trim();
    return defer(() => {
      if (!trimmed) {
        return throwError(
          () => new Error('Enter a word to be notified about.'),
        );
      }
      const client = this.activeClient();
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.write(client, async () => {
          await client.addPushRule(
            'global',
            PushRuleKind.ContentSpecific,
            trimmed,
            {
              actions: actionsFor(sound),
              pattern: trimmed,
            },
          );
          // A rule that exists but is switched off would otherwise be re-added still off.
          await client.setPushRuleEnabled(
            'global',
            PushRuleKind.ContentSpecific,
            trimmed,
            true,
          );
        }),
      );
    });
  }

  /** Remove a keyword. */
  remove(pattern: string): Observable<void> {
    return defer(() => {
      const client = this.activeClient();
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.write(client, () =>
          client.deletePushRule(
            'global',
            PushRuleKind.ContentSpecific,
            pattern,
          ),
        ),
      );
    });
  }

  /** Turn a keyword's sound on or off, leaving the keyword itself alone. */
  setSound(pattern: string, sound: boolean): Observable<void> {
    return defer(() => {
      const client = this.activeClient();
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.write(client, () =>
          client.setPushRuleActions(
            'global',
            PushRuleKind.ContentSpecific,
            pattern,
            actionsFor(sound),
          ),
        ),
      );
    });
  }

  private activeClient(): MatrixClient | null {
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  /**
   * Run a write, then refresh the client's cached rules so the next {@link keywords} read
   * is accurate at once — the same contract {@link RoomNotificationsService} keeps. Without
   * it the list would not change until the `m.push_rules` account-data echo arrived on
   * sync, and the row the user just added would appear to vanish.
   */
  private async write(
    client: MatrixClient,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    await operation();
    client.pushRules = await client.getPushRules();
  }
}
