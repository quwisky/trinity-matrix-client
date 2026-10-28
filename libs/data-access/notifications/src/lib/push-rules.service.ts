import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, throwError } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { unwrapEngineResult } from '@trinity/util/matrix';
import type { DefaultPushRule, PushRuleKind } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationSettingsStore } from './notification-settings.store';

/** A predefined rule a toggle governs. */
export type PushRuleId =
  | '.m.rule.master'
  | '.m.rule.invite_for_me'
  | '.m.rule.is_user_mention'
  | '.m.rule.contains_display_name'
  | '.m.rule.is_room_mention'
  | '.m.rule.roomnotif'
  | '.m.rule.call'
  | '.m.rule.room_one_to_one'
  | '.m.rule.encrypted_room_one_to_one'
  | '.m.rule.message'
  | '.m.rule.encrypted';

/**
 * One account-level notification preference, mapping a labelled toggle to a predefined
 * global push rule. `invert` marks a rule whose *enabled* state means "don't notify" (the
 * master kill-switch). `aliases` lists other rule ids governing the same preference across
 * homeserver variants — see {@link PushRulesService}.
 */
export interface PushRuleToggle {
  readonly id: PushRuleId;
  readonly kind: PushRuleKind;
  readonly label: string;
  readonly invert?: boolean;
  readonly aliases?: readonly PushRuleId[];
}

/** The predefined rules surfaced in the global Notifications settings, in display order. */
const TOGGLES: readonly PushRuleToggle[] = [
  {
    id: '.m.rule.master',
    kind: 'override',
    label: 'Enable notifications for this account',
    invert: true,
  },
  {
    id: '.m.rule.invite_for_me',
    kind: 'override',
    label: 'When I’m invited to a room',
  },
  {
    // Intentional mentions (MSC3952) replaced `.m.rule.contains_display_name` with
    // `.m.rule.is_user_mention`; servers expose one, the other, or (current Synapse) both.
    id: '.m.rule.is_user_mention',
    kind: 'override',
    label: 'When someone mentions my name',
    aliases: ['.m.rule.contains_display_name'],
  },
  {
    id: '.m.rule.is_room_mention',
    kind: 'override',
    label: 'When someone posts @room',
    aliases: ['.m.rule.roomnotif'],
  },
  {
    id: '.m.rule.call',
    kind: 'underride',
    label: 'Call invitations',
  },
  {
    id: '.m.rule.room_one_to_one',
    kind: 'underride',
    label: 'Messages in direct chats',
  },
  {
    id: '.m.rule.encrypted_room_one_to_one',
    kind: 'underride',
    label: 'Messages in encrypted direct chats',
  },
  {
    id: '.m.rule.message',
    kind: 'underride',
    label: 'Messages in rooms',
  },
  {
    id: '.m.rule.encrypted',
    kind: 'underride',
    label: 'Messages in encrypted rooms',
  },
];

/**
 * Reads and toggles the account's **predefined global push rules**: the account-level
 * notification preferences that sync across devices. A sibling to
 * {@link RoomNotificationsService} (per-room overrides).
 *
 * Reads are synchronous snapshots of the active account's {@link NotificationSettingsStore}
 * settings; toggles are cold engine commands.
 *
 * A preference can map to more than one rule id (a toggle's `id` plus its `aliases`):
 * homeservers name some rules differently, notably the intentional-mention rules
 * (`.m.rule.is_user_mention` / `.m.rule.is_room_mention`) vs. their legacy equivalents
 * (`.m.rule.contains_display_name` / `.m.rule.roomnotif`), and current Synapse ships both.
 * Reads consider every id the server defines, and a write is applied to each present id (at
 * whichever kind it lives); targeting an id the server lacks would 404.
 */
@Injectable({ providedIn: 'root' })
export class PushRulesService {
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly store = inject(NotificationSettingsStore);
  private readonly session = inject(SessionStateService);

  /** The notification preferences to surface, in display order. */
  readonly toggles = TOGGLES;

  /** Whether the toggle is "on" from the user's perspective (accounting for `invert`). */
  isOn(toggle: PushRuleToggle): boolean {
    const accountId = this.session.activeAccountId();
    const enabled =
      !!accountId &&
      this.resolveRules(accountId, toggle).some((rule) => rule.enabled);
    return toggle.invert ? !enabled : enabled;
  }

  /** Apply a toggle's on/off state to its push rule(s). Cold — runs on subscribe. */
  setOn(toggle: PushRuleToggle, on: boolean): Observable<void> {
    const enabled = toggle.invert ? !on : on;
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      const present = this.resolveRules(accountId, toggle);
      // Fall back to the canonical id/kind only if the server exposes none of them.
      const targets =
        present.length > 0
          ? present.map(({ ruleId, kind }) => ({ ruleId, kind }))
          : [{ ruleId: toggle.id, kind: toggle.kind }];
      return this.engine.setPushRulesEnabled(accountId, targets, enabled).pipe(
        unwrapEngineResult(),
        map(() => undefined),
      );
    });
  }

  /** Every candidate rule for the toggle that the synced ruleset actually defines. */
  private resolveRules(
    accountId: string,
    toggle: PushRuleToggle,
  ): DefaultPushRule[] {
    const rules = this.store.settings(accountId).defaultRules;
    return [toggle.id, ...(toggle.aliases ?? [])].flatMap(
      (id) => rules.find((rule) => rule.ruleId === id) ?? [],
    );
  }
}
