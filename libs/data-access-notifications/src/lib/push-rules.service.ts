import { Injectable, inject } from '@angular/core';
import {
  PushRuleKind,
  RuleId,
  type IPushRule,
  type IPushRules,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/**
 * One account-level notification preference, mapping a labelled toggle to a predefined
 * global push rule. `invert` marks a rule whose *enabled* state means "don't notify" (the
 * master kill-switch), so the UI shows the opposite of the raw rule state.
 */
export interface PushRuleToggle {
  readonly id: RuleId;
  readonly kind: PushRuleKind;
  readonly label: string;
  readonly invert?: boolean;
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
    id: RuleId.ContainsDisplayName,
    kind: PushRuleKind.Override,
    label: 'When someone mentions my name',
  },
  {
    id: RuleId.AtRoomNotification,
    kind: PushRuleKind.Override,
    label: 'When someone posts @room',
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

/**
 * Reads and toggles the account's **predefined global push rules** — the server-side
 * rules that decide which events notify (mentions, invites, DMs, room messages, calls).
 * Owns the account-level notification *preferences* that sync across devices, a sibling to
 * {@link RoomNotificationsService} (per-room overrides).
 *
 * Reads are synchronous snapshots off the synced client's cached `pushRules`; toggles are
 * cold Observables. The client's account-data sync keeps `pushRules` current, so a change
 * made here (or on another device) is reflected on the next read.
 */
@Injectable({ providedIn: 'root' })
export class PushRulesService {
  private readonly matrix = inject(MatrixClientService);

  /** The notification preferences to surface, in display order. */
  readonly toggles = TOGGLES;

  /** Whether the toggle is "on" from the user's perspective (accounting for `invert`). */
  isOn(toggle: PushRuleToggle): boolean {
    const enabled = this.isEnabled(toggle.id);
    return toggle.invert ? !enabled : enabled;
  }

  /** Apply a toggle's on/off state to its push rule. Cold — runs on subscribe. */
  setOn(toggle: PushRuleToggle, on: boolean): Observable<void> {
    const enabled = toggle.invert ? !on : on;
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.setPushRuleEnabled(
          'global',
          toggle.kind,
          toggle.id,
          enabled,
        ),
      ).pipe(map(() => void 0));
    });
  }

  /** Whether the raw predefined rule is enabled (before any `invert`). */
  private isEnabled(ruleId: RuleId): boolean {
    if (!this.matrix.isInitialized) {
      return false;
    }
    return (
      this.findRule(this.matrix.instance.pushRules, ruleId)?.enabled ?? false
    );
  }

  /** Find a rule by ID across every kind of the global ruleset. */
  private findRule(
    rules: IPushRules | undefined,
    ruleId: RuleId,
  ): IPushRule | undefined {
    const set = rules?.global;
    if (!set) {
      return undefined;
    }
    for (const list of [
      set.override,
      set.content,
      set.room,
      set.sender,
      set.underride,
    ]) {
      const found = list?.find((rule) => rule.rule_id === ruleId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
}
