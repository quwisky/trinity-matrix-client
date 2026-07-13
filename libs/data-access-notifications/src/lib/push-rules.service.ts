import { Injectable, inject } from '@angular/core';
import {
  PushRuleKind,
  RuleId,
  type IPushRule,
  type IPushRules,
} from 'matrix-js-sdk';
import { Observable, defer, forkJoin, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/**
 * One account-level notification preference, mapping a labelled toggle to a predefined
 * global push rule. `invert` marks a rule whose *enabled* state means "don't notify" (the
 * master kill-switch), so the UI shows the opposite of the raw rule state. `aliases` lists
 * additional rule ids that govern the same preference across homeserver variants (e.g.
 * modern intentional-mention rules vs. their legacy equivalents) — see {@link PushRulesService}.
 */
export interface PushRuleToggle {
  readonly id: RuleId;
  readonly kind: PushRuleKind;
  readonly label: string;
  readonly invert?: boolean;
  readonly aliases?: readonly RuleId[];
}

/** The predefined rules surfaced in the global Notifications settings, in display order. */
const TOGGLES: readonly PushRuleToggle[] = [
  {
    id: RuleId.Master,
    kind: PushRuleKind.Override,
    label: 'Enable notifications for this account',
    invert: true,
  },
  {
    id: RuleId.InviteToSelf,
    kind: PushRuleKind.Override,
    label: 'When I’m invited to a room',
  },
  {
    // Intentional mentions (MSC3952) replaced `.m.rule.contains_display_name` with
    // `.m.rule.is_user_mention`; servers expose one, the other, or (current Synapse) both.
    id: RuleId.IsUserMention,
    kind: PushRuleKind.Override,
    label: 'When someone mentions my name',
    aliases: [RuleId.ContainsDisplayName],
  },
  {
    id: RuleId.IsRoomMention,
    kind: PushRuleKind.Override,
    label: 'When someone posts @room',
    aliases: [RuleId.AtRoomNotification],
  },
  {
    id: RuleId.IncomingCall,
    kind: PushRuleKind.Underride,
    label: 'Call invitations',
  },
  {
    id: RuleId.DM,
    kind: PushRuleKind.Underride,
    label: 'Messages in direct chats',
  },
  {
    id: RuleId.EncryptedDM,
    kind: PushRuleKind.Underride,
    label: 'Messages in encrypted direct chats',
  },
  {
    id: RuleId.Message,
    kind: PushRuleKind.Underride,
    label: 'Messages in rooms',
  },
  {
    id: RuleId.EncryptedMessage,
    kind: PushRuleKind.Underride,
    label: 'Messages in encrypted rooms',
  },
];

/** A predefined rule as it actually exists in the synced ruleset. */
interface ResolvedRule {
  readonly id: RuleId;
  readonly kind: PushRuleKind;
  readonly enabled: boolean;
}

/**
 * Reads and toggles the account's **predefined global push rules** — the server-side
 * rules that decide which events notify (mentions, invites, DMs, room messages, calls).
 * Owns the account-level notification *preferences* that sync across devices, a sibling to
 * {@link RoomNotificationsService} (per-room overrides).
 *
 * Reads are synchronous snapshots off the synced client's cached `pushRules`; toggles are
 * cold Observables. The client's account-data sync keeps `pushRules` current, so a change
 * made here (or on another device) is reflected on the next read.
 *
 * A single preference can map to more than one rule id (a toggle's `id` plus its `aliases`):
 * homeservers name some rules differently — notably the intentional-mention rules
 * (`.m.rule.is_user_mention` / `.m.rule.is_room_mention`) vs. their legacy equivalents
 * (`.m.rule.contains_display_name` / `.m.rule.roomnotif`) — and current Synapse ships both.
 * So reads consider every id the server actually defines, and a write is applied to each
 * present id (at whichever kind it lives), keeping the toggle authoritative and never
 * targeting an id the server doesn't have (which would 404 and appear as "won't toggle").
 */
@Injectable({ providedIn: 'root' })
export class PushRulesService {
  private readonly matrix = inject(MatrixClientService);

  /** The notification preferences to surface, in display order. */
  readonly toggles = TOGGLES;

  /** Whether the toggle is "on" from the user's perspective (accounting for `invert`). */
  isOn(toggle: PushRuleToggle): boolean {
    const enabled = this.resolveRules(toggle).some((rule) => rule.enabled);
    return toggle.invert ? !enabled : enabled;
  }

  /** Apply a toggle's on/off state to its push rule(s). Cold — runs on subscribe. */
  setOn(toggle: PushRuleToggle, on: boolean): Observable<void> {
    const enabled = toggle.invert ? !on : on;
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const present = this.resolveRules(toggle);
      // Fall back to the canonical id/kind only if the server exposes none of them.
      const targets: ReadonlyArray<Pick<ResolvedRule, 'id' | 'kind'>> =
        present.length > 0 ? present : [{ id: toggle.id, kind: toggle.kind }];
      return forkJoin(
        targets.map((target) =>
          from(
            this.matrix.instance.setPushRuleEnabled(
              'global',
              target.kind,
              target.id,
              enabled,
            ),
          ),
        ),
      ).pipe(map(() => void 0));
    });
  }

  /** Every candidate rule for the toggle that the synced ruleset actually defines. */
  private resolveRules(toggle: PushRuleToggle): ResolvedRule[] {
    if (!this.matrix.isInitialized) {
      return [];
    }
    const rules = this.matrix.instance.pushRules;
    const resolved: ResolvedRule[] = [];
    for (const id of [toggle.id, ...(toggle.aliases ?? [])]) {
      const entry = this.findRuleEntry(rules, id);
      if (entry) {
        resolved.push({ id, kind: entry.kind, enabled: entry.rule.enabled });
      }
    }
    return resolved;
  }

  /** Find a rule by id across the ruleset, returning it with the kind it lives under. */
  private findRuleEntry(
    rules: IPushRules | undefined,
    ruleId: RuleId,
  ): { rule: IPushRule; kind: PushRuleKind } | undefined {
    const set = rules?.global;
    if (!set) {
      return undefined;
    }
    const byKind: readonly [PushRuleKind, IPushRule[] | undefined][] = [
      [PushRuleKind.Override, set.override],
      [PushRuleKind.ContentSpecific, set.content],
      [PushRuleKind.RoomSpecific, set.room],
      [PushRuleKind.SenderSpecific, set.sender],
      [PushRuleKind.Underride, set.underride],
    ];
    for (const [kind, list] of byKind) {
      const rule = list?.find((candidate) => candidate.rule_id === ruleId);
      if (rule) {
        return { rule, kind };
      }
    }
    return undefined;
  }
}
