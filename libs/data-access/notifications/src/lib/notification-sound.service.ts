import { Injectable, inject } from '@angular/core';
import {
  PushRuleActionName,
  TweakName,
  type IPushRule,
  type PushRuleAction,
  type PushRuleKind,
} from 'matrix-js-sdk';
import { Observable, defer, forkJoin, from, map, of, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * The predefined rules that ship with a `sound` tweak, and the tone each ships with.
 *
 * Measured against Synapse 1.119 rather than assumed — the spec lists more rules than
 * actually carry a sound, and `.m.rule.call` is the one that is NOT `default`. Silencing
 * notifications means removing the tweak from exactly these; any other rule has no sound to
 * remove and rewriting it would be a change the user did not ask for.
 *
 * `contains_display_name` / `contains_user_name` are the legacy mention rules. They are kept
 * in the list because a homeserver still serves them and they still fire for clients that do
 * not send `m.mentions`; leaving them out would let a mention from an older client ring
 * after the user asked for silence.
 */
const SOUNDED_RULES: readonly {
  id: string;
  kind: PushRuleKind;
  sound: string;
}[] = [
  {
    id: '.m.rule.invite_for_me',
    kind: 'override' as PushRuleKind,
    sound: 'default',
  },
  {
    id: '.m.rule.is_user_mention',
    kind: 'override' as PushRuleKind,
    sound: 'default',
  },
  {
    id: '.m.rule.contains_display_name',
    kind: 'override' as PushRuleKind,
    sound: 'default',
  },
  {
    id: '.m.rule.contains_user_name',
    kind: 'content' as PushRuleKind,
    sound: 'default',
  },
  { id: '.m.rule.call', kind: 'underride' as PushRuleKind, sound: 'ring' },
  {
    id: '.m.rule.encrypted_room_one_to_one',
    kind: 'underride' as PushRuleKind,
    sound: 'default',
  },
  {
    id: '.m.rule.room_one_to_one',
    kind: 'underride' as PushRuleKind,
    sound: 'default',
  },
];

/**
 * The single global "play a sound" preference, expressed as push rules rather than as a
 * local setting.
 *
 * Doing it in push rules is the point: the choice travels with the account, so silencing on
 * the desktop also silences the phone (the push gateway reads the same tweak) and shows up
 * in Element, which reads and writes the same rules. A local flag would only ever have
 * silenced the window it was set in.
 *
 * Deliberately ONE switch, not a per-room or per-tone picker. Trinity plays no audio of its
 * own — the tweak asks the platform to make its notification sound — so a tone chooser would
 * need a bundled asset, an autoplay story and four platform paths, none of which this
 * delivers. Per-room sounds and an in-app player are separate work.
 */
@Injectable({ providedIn: 'root' })
export class NotificationSoundService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * Whether notifications are currently allowed to make a sound.
   *
   * True when ANY of the sounded rules still carries its tweak, so a half-applied state (a
   * failed write, or another client that silenced only some) reads as "on" and the next
   * toggle-off completes the job rather than reporting success over a partial result.
   */
  isOn(): boolean {
    return this.presentRules().some(
      ({ rule }) => soundTweakOf(rule) !== undefined,
    );
  }

  /**
   * Add or remove the `sound` tweak across every predefined rule that has one. Cold — runs
   * on subscribe.
   *
   * Turning sound back on restores the tone the SPEC ships for each rule, not whatever was
   * there before: `.m.rule.call` returns to `ring` and the rest to `default`. A custom tone
   * set in another client is therefore not preserved across an off/on cycle — the honest
   * cost of not keeping a shadow copy of every rule's previous actions, and the reason this
   * is a global switch rather than a tone picker.
   */
  setOn(on: boolean): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const targets = this.presentRules();
      if (targets.length === 0) {
        // A homeserver that defines none of them: nothing to write, and reporting success
        // is honest — there is no sound to turn on or off.
        return of(void 0);
      }
      return forkJoin(
        targets.map(({ rule, spec }) =>
          from(
            this.matrix.instance.setPushRuleActions(
              'global',
              spec.kind,
              spec.id,
              actionsWithSound(rule, on ? spec.sound : undefined),
            ),
          ),
        ),
      ).pipe(map(() => void 0));
    });
  }

  /** The sounded rules the synced ruleset actually defines, paired with their spec entry. */
  private presentRules(): {
    rule: IPushRule;
    spec: (typeof SOUNDED_RULES)[number];
  }[] {
    if (!this.matrix.isInitialized) {
      return [];
    }
    // Optional all the way down, because {@link isOn} is read while BUILDING a notification:
    // a throw here would not surface as a broken setting, it would silently stop every
    // notification from being shown at all. "No rules visible" degrades to "no sound", which
    // is the safe direction.
    const rules = this.matrix.instance?.pushRules?.global;
    if (!rules) {
      return [];
    }
    const found: { rule: IPushRule; spec: (typeof SOUNDED_RULES)[number] }[] =
      [];
    for (const spec of SOUNDED_RULES) {
      const rule = (rules[spec.kind] ?? []).find((r) => r.rule_id === spec.id);
      if (rule) {
        found.push({ rule, spec });
      }
    }
    return found;
  }
}

/**
 * The rule's actions with the `sound` tweak set to `sound`, or removed when it is undefined.
 *
 * Every OTHER action is carried through untouched, unlike the keyword rules which regenerate
 * their list wholesale. These are rules the user may have adjusted elsewhere — a highlight
 * tweak, a `dont_notify` someone set deliberately — and this switch is only about sound.
 */
export function actionsWithSound(
  rule: IPushRule,
  sound: string | undefined,
): PushRuleAction[] {
  const kept = rule.actions.filter(
    (action) =>
      !(
        !!action &&
        typeof action === 'object' &&
        action.set_tweak === TweakName.Sound
      ),
  );
  if (sound === undefined) {
    return kept;
  }
  // After `notify` if it is there, so the list reads the way the spec's examples do.
  const at = kept.indexOf(PushRuleActionName.Notify);
  const tweak: PushRuleAction = { set_tweak: TweakName.Sound, value: sound };
  if (at === -1) {
    return [...kept, tweak];
  }
  return [...kept.slice(0, at + 1), tweak, ...kept.slice(at + 1)];
}

/** The rule's sound tweak value, or undefined when it has none. Null-safe. */
export function soundTweakOf(rule: IPushRule): string | undefined {
  for (const action of rule.actions) {
    if (
      !!action &&
      typeof action === 'object' &&
      action.set_tweak === TweakName.Sound
    ) {
      const value: unknown = action.value;
      return typeof value === 'string' ? value : 'default';
    }
  }
  return undefined;
}
